const fs = require("fs");
const { test, expect } = require("@playwright/test");

test("records requested interaction events in downloadable log", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#downloadEventLogBtn")).toHaveCount(0);
  await expect(page.locator("#startSensingBtn")).toBeEnabled();

  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.id = "tracking-scroll-spacer";
    spacer.style.height = "1600px";
    document.body.appendChild(spacer);

    const form = document.createElement("form");
    form.id = "tracking-test-form";
    form.method = "post";
    form.action = "/tracking-test-submit";
    form.addEventListener("submit", (event) => event.preventDefault());
    document.body.appendChild(form);
  });

  await page.mouse.move(80, 80);
  await page.keyboard.press("Tab");
  await expect.poll(() => page.evaluate(() => window.interactionTracker.getEvents().length)).toBe(0);

  await page.locator("#startSensingBtn").click();
  await expect(page.locator("#stopSensingBtn")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.interactionTracker.isEnabled())).toBe(true);

  await page.waitForTimeout(300);
  await page.mouse.move(120, 120);
  await page.waitForTimeout(300);
  await page.mouse.move(220, 180);

  await page.waitForTimeout(300);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await page.mouse.move(260, 220);

  await page.keyboard.press("Tab");

  await page.evaluate(() => {
    const form = document.getElementById("tracking-test-form");
    form.requestSubmit();
  });

  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const downloads = [];
  page.on("download", (download) => {
    downloads.push(download);
  });

  await page.locator("#stopSensingBtn").click();
  await expect.poll(() => (
    downloads.find((download) => download.suggestedFilename().startsWith("tracking_data_"))
      ? "ready"
      : ""
  )).toBe("ready");

  const download = downloads.find((item) => item.suggestedFilename().startsWith("tracking_data_"));
  const payload = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  const eventNames = payload.events.map((event) => event.name);

  expect(payload.schemaVersion).toBe(1);
  expect(payload.eventCount).toBe(payload.events.length);
  expect(payload.trackingConfig.maxEvents).toBeGreaterThan(0);

  for (const expectedEvent of [
    "page_view",
    "mousemove",
    "scroll",
    "keydown",
    "form_submit",
    "page_visibility_change",
    "click"
  ]) {
    expect(eventNames).toContain(expectedEvent);
  }

  const keydown = payload.events.find((event) => event.name === "keydown");
  expect(keydown.properties.key).toBe("Tab");

  const formSubmit = payload.events.find((event) => event.name === "form_submit");
  expect(formSubmit.properties.target.id).toBe("tracking-test-form");
  expect(formSubmit.properties.method).toBe("post");

  const scrolledMousemove = payload.events
    .filter((event) => event.name === "mousemove")
    .find((event) => event.properties.scrollY > 0);
  expect(scrolledMousemove).toBeTruthy();
  expect(scrolledMousemove.properties.pageX).toBe(scrolledMousemove.properties.x + scrolledMousemove.properties.scrollX);
  expect(scrolledMousemove.properties.pageY).toBe(scrolledMousemove.properties.y + scrolledMousemove.properties.scrollY);
  expect(scrolledMousemove.properties.documentHeight).toBeGreaterThan(scrolledMousemove.properties.pageY);

  const stopClick = payload.events.find((event) => (
    event.name === "click" &&
    event.properties.target &&
    event.properties.target.id === "stopSensingBtn"
  ));
  expect(stopClick).toBeTruthy();
});
