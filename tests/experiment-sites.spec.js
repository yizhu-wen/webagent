const fs = require("fs");
const { test, expect } = require("@playwright/test");

async function installDurationLimitTimerTestHook(page) {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const durationTimerId = 40000;
    let durationTimerCallback = null;

    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 40000) {
        durationTimerCallback = () => callback(...args);
        return durationTimerId;
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
    window.clearTimeout = (timerId) => {
      if (timerId === durationTimerId) {
        durationTimerCallback = null;
        return;
      }
      nativeClearTimeout(timerId);
    };
    window.__triggerDurationLimitForTest = () => {
      const callback = durationTimerCallback;
      durationTimerCallback = null;
      if (callback) {
        callback();
      }
    };
  });
}

function expectPythonStyleTrackingEvents(keyboardEvents, cursorEvents) {
  expect(Array.isArray(keyboardEvents)).toBe(true);
  expect(Array.isArray(cursorEvents)).toBe(true);
  expect(keyboardEvents.some((event) => event.event === "down")).toBe(true);
  expect(keyboardEvents.some((event) => event.event === "up")).toBe(true);
  expect(keyboardEvents.every((event) => (
    typeof event.key === "string" && Number.isFinite(event.t)
  ))).toBe(true);

  const cursorTypes = [...new Set(cursorEvents.map((event) => event.type))].sort();
  expect(cursorTypes).toEqual(["click", "move", "scroll"]);
  expect(cursorEvents.some((event) => event.type === "click" && event.pressed === true)).toBe(true);
  expect(cursorEvents.some((event) => event.type === "click" && event.pressed === false)).toBe(true);
  expect(cursorEvents.every((event) => (
    Number.isFinite(event.x) && Number.isFinite(event.y) && Number.isFinite(event.t)
  ))).toBe(true);
}

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
    await expect(page.locator("[data-collection-panel]")).toHaveCount(0);
    await expect(page.locator("[data-recording-profile]")).toHaveValue("ultrasonic");
    await expect(page.locator("[data-recording-profile] option")).toHaveText([
      "Ultrasound (strict)",
      "Compatibility"
    ]);
    await expect(page.locator("[data-recording-profile-hint]")).toHaveText(
      "If Ultrasound (strict) does not work, switch to Compatibility."
    );

    const debugState = await page.evaluate(() => window.experimentSensing.getRealtimeDebugState());
    expect(debugState.realtimeWebSocketUrl).toMatch(/\/realtime$/);
    expect(debugState.points).toBe(0);
    expect(await page.evaluate(() => window.experimentSensing.getRecordingProfile().id)).toBe("ultrasonic");
    expect(await page.evaluate(() => window.experimentSensing.getMaximumSensingDurationSeconds())).toBe(40);
    expect(await page.evaluate(() => window.experimentSensing.isDurationLimitTimerActive())).toBe(false);
  }
});

test("simple shopping page captures interaction data", async ({ page }) => {
  await installDurationLimitTimerTestHook(page);
  await page.goto("/experiments/");
  await expect(page.getByRole("heading", { name: "Simple Shopping Task" })).toBeVisible();
  await expect(page.locator("[data-download-tracking]")).toHaveCount(0);
  await expect(page.locator("[data-download-session]")).toBeHidden();
  await expect(page.locator("#shoppingStartSensingBtn")).toBeEnabled();
  await expect(page.locator("#shoppingStopSensingBtn")).toBeHidden();

  await page.mouse.move(80, 80);
  await page.keyboard.press("Tab");
  await expect.poll(() => page.evaluate(() => window.interactionTracker.getEvents().length)).toBe(0);

  await page.locator("#shoppingStartSensingBtn").click();
  await expect(page.locator("#shoppingStartSensingBtn")).toHaveText("Stop sensing");
  await expect.poll(() => page.evaluate(() => window.interactionTracker.isEnabled())).toBe(true);
  await expect.poll(() => page.evaluate(() => window.experimentSensing.isPlaybackActive())).toBe(true);
  await expect.poll(() => page.evaluate(() => window.experimentSensing.isDurationLimitTimerActive())).toBe(true);
  await expect(page.locator("#shoppingSensingStatus")).toContainText("automatically after 40 seconds");

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

  await page.evaluate(() => window.__triggerDurationLimitForTest());
  await expect(page.locator("#shoppingStartSensingBtn")).toBeEnabled();
  await expect(page.locator("#shoppingStartSensingBtn")).toHaveText("Start sensing");
  await expect(page.locator("#shoppingStopSensingBtn")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.interactionTracker.isEnabled())).toBe(false);
  await expect.poll(() => page.evaluate(() => window.experimentSensing.isPlaybackActive())).toBe(false);
  await expect.poll(() => page.evaluate(() => window.experimentSensing.isDurationLimitTimerActive())).toBe(false);
  await expect.poll(() => page.evaluate(() => (
    window.experimentSensing.getCaptureDiagnostics().durationLimitReached
  ))).toBe(true);

  await expect(page.locator("#shoppingSpectrogramPanel")).toBeVisible();
  await expect(page.locator("#shoppingSpectrogramStatus")).toContainText("18-24 kHz");
  const spectrogramFormat = await page.evaluate(() => {
    const canvas = document.getElementById("shoppingSpectrogramCanvas");
    const ctx = canvas.getContext("2d");
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let darkUltrasoundPixels = 0;

    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 50 && pixels[index + 1] < 50 && pixels[index + 2] >= 35 && pixels[index + 2] < 130) {
        darkUltrasoundPixels += 1;
      }
    }

    return {
      height: canvas.height,
      background: Array.from(ctx.getImageData(0, 0, 1, 1).data),
      darkUltrasoundPixels
    };
  });
  expect(spectrogramFormat.height).toBe(394);
  expect(spectrogramFormat.background).toEqual([255, 255, 255, 255]);
  expect(spectrogramFormat.darkUltrasoundPixels).toBeGreaterThan(20);

  await expect(page.locator("[data-download-session]")).toBeVisible({ timeout: 20000 });
  await expect(page.locator("[data-download-session]")).toBeEnabled();
  expect(downloads).toHaveLength(0);
  await page.locator("[data-download-session]").click();

  await expect.poll(() => ({
    keyboard: downloads.some((download) => download.suggestedFilename() === "keyboard_events.json"),
    cursor: downloads.some((download) => download.suggestedFilename() === "cursor_events.json"),
    metadata: downloads.some((download) => download.suggestedFilename() === "metadata.json"),
    audio: downloads.some((download) => /^shopping_recording_\d{8}_\d{6}\.wav$/.test(download.suggestedFilename())),
    spectrogram: downloads.some((download) => /^shopping_recording_spectrogram_\d{8}_\d{6}\.png$/.test(download.suggestedFilename()))
  })).toEqual({
    keyboard: true,
    cursor: true,
    metadata: true,
    audio: true,
    spectrogram: true
  });

  const keyboardDownload = downloads.find((item) => item.suggestedFilename() === "keyboard_events.json");
  const cursorDownload = downloads.find((item) => item.suggestedFilename() === "cursor_events.json");
  const metadataDownload = downloads.find((item) => item.suggestedFilename() === "metadata.json");
  const audioDownload = downloads.find((item) => /^shopping_recording_\d{8}_\d{6}\.wav$/.test(item.suggestedFilename()));
  const spectrogramDownload = downloads.find((item) => /^shopping_recording_spectrogram_\d{8}_\d{6}\.png$/.test(item.suggestedFilename()));
  expect(audioDownload.suggestedFilename()).toMatch(/^shopping_recording_\d{8}_\d{6}\.wav$/);
  expect(spectrogramDownload.suggestedFilename()).toMatch(/^shopping_recording_spectrogram_\d{8}_\d{6}\.png$/);

  const keyboardEvents = JSON.parse(fs.readFileSync(await keyboardDownload.path(), "utf8"));
  const cursorEvents = JSON.parse(fs.readFileSync(await cursorDownload.path(), "utf8"));
  const metadata = JSON.parse(fs.readFileSync(await metadataDownload.path(), "utf8"));
  expectPythonStyleTrackingEvents(keyboardEvents, cursorEvents);
  expect(metadata.scenario).toBe("Shopping");
  expect(metadata.input).toBe("Mix");
  expect(metadata.n_key_events).toBe(keyboardEvents.length);
  expect(metadata.n_cursor_events).toBe(cursorEvents.length);
  expect(metadata.recording_name).toMatch(/^shopping_recording_\d{8}_\d{6}$/);
});

test("travel tourism page captures interaction data", async ({ page }) => {
  await page.goto("/experiments/travel/");
  await expect(page.getByRole("heading", { name: "Simple Travel Task" })).toBeVisible();
  await expect(page.locator("[data-product-row]")).toHaveCount(5);
  await expect(page.locator("[data-download-tracking]")).toHaveCount(0);
  await expect(page.locator("[data-download-session]")).toBeHidden();
  await expect(page.locator("#travelStartSensingBtn")).toBeEnabled();
  await expect(page.locator("#travelStopSensingBtn")).toBeHidden();

  await page.mouse.move(80, 80);
  await page.keyboard.press("Tab");
  await expect.poll(() => page.evaluate(() => window.interactionTracker.getEvents().length)).toBe(0);

  await page.locator("#travelStartSensingBtn").click();
  await expect(page.locator("#travelStartSensingBtn")).toHaveText("Stop sensing");
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

  await page.locator("#travelStartSensingBtn").click();
  await expect(page.locator("#travelStartSensingBtn")).toBeEnabled();
  await expect(page.locator("#travelStartSensingBtn")).toHaveText("Start sensing");
  await expect(page.locator("#travelStopSensingBtn")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.interactionTracker.isEnabled())).toBe(false);
  await expect.poll(() => page.evaluate(() => window.experimentSensing.isPlaybackActive())).toBe(false);
  await expect.poll(() => page.evaluate(() => window.experimentSensing.isDurationLimitTimerActive())).toBe(false);

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

  await expect(page.locator("[data-download-session]")).toBeVisible({ timeout: 20000 });
  await expect(page.locator("[data-download-session]")).toBeEnabled();
  expect(downloads).toHaveLength(0);
  await page.locator("[data-download-session]").click();

  await expect.poll(() => ({
    keyboard: downloads.some((download) => download.suggestedFilename() === "keyboard_events.json"),
    cursor: downloads.some((download) => download.suggestedFilename() === "cursor_events.json"),
    metadata: downloads.some((download) => download.suggestedFilename() === "metadata.json"),
    audio: downloads.some((download) => /^travel_recording_\d{8}_\d{6}\.wav$/.test(download.suggestedFilename())),
    spectrogram: downloads.some((download) => /^travel_recording_spectrogram_\d{8}_\d{6}\.png$/.test(download.suggestedFilename()))
  })).toEqual({
    keyboard: true,
    cursor: true,
    metadata: true,
    audio: true,
    spectrogram: true
  });

  const keyboardDownload = downloads.find((item) => item.suggestedFilename() === "keyboard_events.json");
  const cursorDownload = downloads.find((item) => item.suggestedFilename() === "cursor_events.json");
  const metadataDownload = downloads.find((item) => item.suggestedFilename() === "metadata.json");
  const keyboardEvents = JSON.parse(fs.readFileSync(await keyboardDownload.path(), "utf8"));
  const cursorEvents = JSON.parse(fs.readFileSync(await cursorDownload.path(), "utf8"));
  const metadata = JSON.parse(fs.readFileSync(await metadataDownload.path(), "utf8"));
  expectPythonStyleTrackingEvents(keyboardEvents, cursorEvents);
  expect(metadata.scenario).toBe("Travel");
  expect(metadata.input).toBe("Mix");
  expect(metadata.n_key_events).toBe(keyboardEvents.length);
  expect(metadata.n_cursor_events).toBe(cursorEvents.length);
  expect(metadata.recording_name).toMatch(/^travel_recording_\d{8}_\d{6}$/);
});
