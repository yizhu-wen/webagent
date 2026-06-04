const fs = require("fs");
const { test, expect } = require("@playwright/test");

test("original page links to the simplified experiment sites", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("a[href='experiments/']")).toHaveText("Open shopping experiment");
  await expect(page.locator("a[href='experiments/travel/']")).toHaveText("Open travel experiment");

  await page.locator("a[href='experiments/']").click();
  await expect(page).toHaveURL(/\/experiments\/$/);
  await expect(page.getByRole("heading", { name: "Simple Shopping Task" })).toBeVisible();
  await expect(page.locator(".product-row")).toHaveCount(5);
});

test("experiment pages expose live Python IQ panels", async ({ page }) => {
  for (const path of ["/experiments/", "/experiments/travel/"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Live Python IQ" })).toBeVisible();
    await expect(page.locator("[data-realtime-canvas]")).toBeVisible();
    await expect(page.locator("[data-realtime-status]")).toContainText("Start sensing");

    const debugState = await page.evaluate(() => window.experimentSensing.getRealtimeDebugState());
    expect(debugState.realtimeWebSocketUrl).toMatch(/\/realtime$/);
    expect(debugState.points).toBe(0);
  }
});

test("simple shopping page captures interaction data", async ({ page }) => {
  await page.goto("/experiments/");
  await expect(page.getByRole("heading", { name: "Simple Shopping Task" })).toBeVisible();
  await expect(page.locator("[data-download-tracking]")).toHaveCount(0);
  await expect(page.locator("#shoppingStartSensingBtn")).toBeEnabled();
  await expect(page.locator("#shoppingStopSensingBtn")).toBeDisabled();

  await page.mouse.move(80, 80);
  await page.keyboard.press("Tab");
  await expect.poll(() => page.evaluate(() => window.interactionTracker.getEvents().length)).toBe(0);

  await page.locator("#shoppingStartSensingBtn").click();
  await expect(page.locator("#shoppingStopSensingBtn")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.interactionTracker.isEnabled())).toBe(true);
  await expect.poll(() => page.evaluate(() => window.experimentSensing.isPlaybackActive())).toBe(true);

  await page.locator("input[name='query']").click();
  await page.keyboard.type("desk");
  await page.locator("input[name='filter'][value='sale']").check();
  await expect(page.locator("[data-product-row]:visible")).toHaveCount(5);
  await page.locator("#shopping-search button[type='submit']").click();
  await expect(page.locator("[data-product-row]:visible")).toHaveCount(2);
  await expect(page.locator("[data-product-row]:visible")).toContainText([
    "Desk organizer",
    "Notebook pack"
  ]);

  await page.locator("input[name='query']").fill("");
  await page.locator("input[name='filter'][value='sale']").uncheck();
  await page.locator("#shopping-search button[type='submit']").click();
  await expect(page.locator("[data-product-row]:visible")).toHaveCount(5);

  await page.locator("[data-add-cart]").first().click();
  await page.locator("[data-toggle-favorite]").first().click();

  await page.waitForTimeout(300);
  await page.mouse.move(140, 140);
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, 900);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await page.mouse.move(260, 220);

  await page.locator("input[name='customer_name']").click();
  await page.keyboard.type("Test User");
  await page.locator("input[name='email']").fill("test@example.com");
  await page.locator("textarea[name='notes']").fill("Leave at the door");
  await page.locator("#checkout-form button[type='submit']").click();

  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const downloads = [];
  page.on("download", (download) => {
    downloads.push(download);
  });

  await page.locator("#shoppingStopSensingBtn").click();
  await expect(page.locator("#shoppingStartSensingBtn")).toBeEnabled();
  await expect(page.locator("#shoppingStopSensingBtn")).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.interactionTracker.isEnabled())).toBe(false);
  await expect.poll(() => page.evaluate(() => window.experimentSensing.isPlaybackActive())).toBe(false);

  await expect(page.locator("#shoppingSpectrogramPanel")).toBeVisible();
  await expect(page.locator("#shoppingSpectrogramStatus")).toContainText("Spectrogram");
  const brightSpectrogramPixels = await page.evaluate(() => {
    const canvas = document.getElementById("shoppingSpectrogramCanvas");
    const ctx = canvas.getContext("2d");
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let brightPixels = 0;

    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 180 && pixels[index + 1] > 170 && pixels[index + 2] > 150) {
        brightPixels += 1;
      }
    }

    return brightPixels;
  });
  expect(brightSpectrogramPixels).toBeGreaterThan(20);

  await expect.poll(() => ({
    tracking: downloads.some((download) => download.suggestedFilename().includes("simple-shopping")),
    audio: downloads.some((download) => /^shopping_recording_\d{8}_\d{6}\.wav$/.test(download.suggestedFilename())),
    spectrogram: downloads.some((download) => /^shopping_recording_spectrogram_\d{8}_\d{6}\.png$/.test(download.suggestedFilename()))
  })).toEqual({
    tracking: true,
    audio: true,
    spectrogram: true
  });

  const trackingDownload = downloads.find((item) => item.suggestedFilename().includes("simple-shopping"));
  const audioDownload = downloads.find((item) => /^shopping_recording_\d{8}_\d{6}\.wav$/.test(item.suggestedFilename()));
  const spectrogramDownload = downloads.find((item) => /^shopping_recording_spectrogram_\d{8}_\d{6}\.png$/.test(item.suggestedFilename()));
  expect(trackingDownload.suggestedFilename()).toContain("simple-shopping");
  expect(audioDownload.suggestedFilename()).toMatch(/^shopping_recording_\d{8}_\d{6}\.wav$/);
  expect(spectrogramDownload.suggestedFilename()).toMatch(/^shopping_recording_spectrogram_\d{8}_\d{6}\.png$/);

  const payload = JSON.parse(fs.readFileSync(await trackingDownload.path(), "utf8"));
  const eventNames = payload.events.map((event) => event.name);

  for (const expectedEvent of [
    "click",
    "tap",
    "pointer_down",
    "pointer_up",
    "keydown",
    "wheel_swipe",
    "form_submit"
  ]) {
    expect(eventNames).toContain(expectedEvent);
  }

  for (const removedEvent of [
    "page_view",
    "mousemove",
    "scroll",
    "keyup",
    "page_visibility_change"
  ]) {
    expect(eventNames).not.toContain(removedEvent);
  }

  const formSubmits = payload.events.filter((event) => event.name === "form_submit");
  expect(formSubmits.length).toBeGreaterThanOrEqual(2);
  expect(formSubmits.some((event) => event.properties.target.id === "checkout-form")).toBe(true);
});

test("travel tourism page captures interaction data", async ({ page }) => {
  await page.goto("/experiments/travel/");
  await expect(page.getByRole("heading", { name: "Simple Travel Task" })).toBeVisible();
  await expect(page.locator("[data-product-row]")).toHaveCount(5);
  await expect(page.locator("[data-download-tracking]")).toHaveCount(0);
  await expect(page.locator("#travelStartSensingBtn")).toBeEnabled();
  await expect(page.locator("#travelStopSensingBtn")).toBeDisabled();

  await page.mouse.move(80, 80);
  await page.keyboard.press("Tab");
  await expect.poll(() => page.evaluate(() => window.interactionTracker.getEvents().length)).toBe(0);

  await page.locator("#travelStartSensingBtn").click();
  await expect(page.locator("#travelStopSensingBtn")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.interactionTracker.isEnabled())).toBe(true);
  await expect.poll(() => page.evaluate(() => window.experimentSensing.isPlaybackActive())).toBe(true);

  await page.locator("input[name='query']").click();
  await page.keyboard.type("lisbon");
  await page.locator("input[name='filter'][value='guided']").check();
  await expect(page.locator("[data-product-row]:visible")).toHaveCount(5);
  await page.locator("#travel-search button[type='submit']").click();
  await expect(page.locator("[data-product-row]:visible")).toHaveCount(1);
  await expect(page.locator("[data-product-row]:visible")).toContainText("Lisbon weekend");

  await page.locator("input[name='query']").fill("");
  await page.locator("input[name='filter'][value='guided']").uncheck();
  await page.locator("#travel-search button[type='submit']").click();
  await expect(page.locator("[data-product-row]:visible")).toHaveCount(5);

  await page.locator("[data-add-cart]").first().click();
  await page.locator("[data-toggle-favorite]").first().click();
  const firstTrip = page.locator("[data-product-row]").first();
  await firstTrip.locator("[data-quick-view]").click();
  await expect(page.locator("#travelDetailsPanel")).toHaveCount(0);
  await expect(firstTrip.locator("[data-trip-detail-panel]")).toBeVisible();
  await expect(firstTrip.locator("[data-trip-detail-name]")).toHaveText("Tokyo city break");
  await expect(firstTrip.locator("[data-trip-detail-duration]")).toHaveText("3 nights");
  await expect(firstTrip.locator("[data-trip-detail-route]")).toContainText("Shinjuku");
  await firstTrip.locator("[data-use-trip]").click();
  await expect(page.locator("[data-cart-count]")).toHaveText("2");
  await expect(page.locator("textarea[name='notes']")).toHaveValue(/Tokyo city break/);
  await firstTrip.locator("[data-close-trip-details]").click();
  await expect(firstTrip.locator("[data-trip-detail-panel]")).toBeHidden();

  await page.waitForTimeout(300);
  await page.mouse.move(140, 140);
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, 900);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await page.mouse.move(260, 220);

  await page.locator("input[name='traveler_name']").click();
  await page.keyboard.type("Test Traveler");
  await page.locator("input[name='email']").fill("traveler@example.com");
  await page.locator("input[name='start_date']").fill("2026-08-15");
  await page.locator("input[name='traveler_count']").fill("2");
  await page.locator("textarea[name='notes']").fill("Prefer morning flights");
  await page.locator("#booking-form button[type='submit']").click();

  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const downloads = [];
  page.on("download", (download) => {
    downloads.push(download);
  });

  await page.locator("#travelStopSensingBtn").click();
  await expect(page.locator("#travelStartSensingBtn")).toBeEnabled();
  await expect(page.locator("#travelStopSensingBtn")).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.interactionTracker.isEnabled())).toBe(false);
  await expect.poll(() => page.evaluate(() => window.experimentSensing.isPlaybackActive())).toBe(false);

  await expect(page.locator("#travelSpectrogramPanel")).toBeVisible();
  await expect(page.locator("#travelSpectrogramStatus")).toContainText("Spectrogram");
  const brightSpectrogramPixels = await page.evaluate(() => {
    const canvas = document.getElementById("travelSpectrogramCanvas");
    const ctx = canvas.getContext("2d");
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let brightPixels = 0;

    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 180 && pixels[index + 1] > 170 && pixels[index + 2] > 150) {
        brightPixels += 1;
      }
    }

    return brightPixels;
  });
  expect(brightSpectrogramPixels).toBeGreaterThan(20);

  await expect.poll(() => ({
    tracking: downloads.some((download) => download.suggestedFilename().includes("travel-tourism")),
    audio: downloads.some((download) => /^travel_recording_\d{8}_\d{6}\.wav$/.test(download.suggestedFilename())),
    spectrogram: downloads.some((download) => /^travel_recording_spectrogram_\d{8}_\d{6}\.png$/.test(download.suggestedFilename()))
  })).toEqual({
    tracking: true,
    audio: true,
    spectrogram: true
  });

  const trackingDownload = downloads.find((item) => item.suggestedFilename().includes("travel-tourism"));
  const payload = JSON.parse(fs.readFileSync(await trackingDownload.path(), "utf8"));
  const eventNames = payload.events.map((event) => event.name);

  for (const expectedEvent of [
    "click",
    "tap",
    "pointer_down",
    "pointer_up",
    "keydown",
    "wheel_swipe",
    "form_submit"
  ]) {
    expect(eventNames).toContain(expectedEvent);
  }

  for (const removedEvent of [
    "page_view",
    "mousemove",
    "scroll",
    "keyup",
    "page_visibility_change"
  ]) {
    expect(eventNames).not.toContain(removedEvent);
  }

  const formSubmits = payload.events.filter((event) => event.name === "form_submit");
  expect(formSubmits.some((event) => event.properties.target.id === "booking-form")).toBe(true);
});
