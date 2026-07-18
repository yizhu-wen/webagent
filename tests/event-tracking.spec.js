const fs = require("fs");
const { test, expect } = require("@playwright/test");

test("records requested interaction events in downloadable log", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#downloadEventLogBtn")).toHaveCount(0);
  await expect(page.locator("#downloadSessionBtn")).toBeHidden();
  await expect(page.locator("#startSensingBtn")).toBeEnabled();
  await expect(page.locator("[data-collection-panel]")).toHaveCount(0);

  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.id = "tracking-scroll-spacer";
    spacer.style.height = "1600px";
    document.body.appendChild(spacer);

    const pointerTarget = document.createElement("div");
    pointerTarget.id = "tracking-pointer-target";
    pointerTarget.style.position = "fixed";
    pointerTarget.style.left = "16px";
    pointerTarget.style.top = "16px";
    pointerTarget.style.width = "360px";
    pointerTarget.style.height = "320px";
    pointerTarget.style.zIndex = "10";
    pointerTarget.style.background = "rgba(255, 255, 255, 0)";
    document.body.appendChild(pointerTarget);

    const range = document.createElement("input");
    range.id = "tracking-range";
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.value = "25";
    document.body.appendChild(range);

    const form = document.createElement("form");
    form.id = "tracking-test-form";
    form.method = "post";
    form.action = "/tracking-test-submit";
    form.addEventListener("submit", (event) => event.preventDefault());
    document.body.appendChild(form);
  });

  await page.mouse.move(80, 80);
  await page.mouse.click(80, 80);
  await expect.poll(() => page.evaluate(() => window.interactionTracker.getEvents().length)).toBe(0);

  await page.locator("#startSensingBtn").click();
  await expect(page.locator("#startSensingBtn")).toHaveText("Stop sensing");
  await expect(page.locator("#stopSensingBtn")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.interactionTracker.isEnabled())).toBe(true);

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.keyboard.press("Tab");
  await page.mouse.move(120, 120);
  await page.mouse.click(120, 120);
  await page.mouse.click(122, 122);
  await page.mouse.dblclick(160, 160);

  await page.mouse.move(180, 180);
  await page.mouse.down();
  await page.waitForTimeout(340);
  await page.mouse.up();
  await page.waitForTimeout(80);
  await page.mouse.down();
  await page.waitForTimeout(340);
  await page.mouse.up();

  await page.mouse.move(200, 200);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();

  await page.mouse.move(240, 240);
  await page.mouse.down();
  await page.mouse.move(330, 280, { steps: 8 });
  await page.mouse.up();

  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await page.evaluate(() => {
    const range = document.getElementById("tracking-range");
    range.value = "75";
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await page.evaluate(() => {
    const form = document.getElementById("tracking-test-form");
    form.requestSubmit();
  });

  const downloads = [];
  page.on("download", (download) => {
    downloads.push(download);
  });

  await page.locator("#startSensingBtn").click();
  await expect(page.locator("#downloadSessionBtn")).toBeVisible({ timeout: 20000 });
  await expect(page.locator("#downloadSessionBtn")).toBeEnabled();
  expect(downloads).toHaveLength(0);

  await page.locator("#downloadSessionBtn").click();
  await expect.poll(() => (
    downloads.find((download) => download.suggestedFilename().startsWith("tracking_data_"))
      ? "ready"
      : ""
  )).toBe("ready");
  await expect.poll(() => (
    downloads.find((download) => download.suggestedFilename().startsWith("os_event_log_"))
      ? "ready"
      : ""
  )).toBe("ready");

  const download = downloads.find((item) => item.suggestedFilename().startsWith("tracking_data_"));
  const payload = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  const eventNames = payload.events.map((event) => event.name);

  expect(payload.schemaVersion).toBe(1);
  expect(payload.eventCount).toBe(payload.events.length);
  expect(payload.trackingConfig.maxEvents).toBeGreaterThan(0);
  expect(payload.trackingConfig.pointerMoveThrottleMs).toBeGreaterThan(0);
  expect(payload.trackingConfig.doublePressWindowMs).toBeGreaterThan(0);
  expect(payload.dataCollection).toBeUndefined();
  expect(payload.startEpochSeconds).toBeGreaterThan(0);
  expect(payload.events.every((event) => event.epochSeconds > 0)).toBe(true);

  for (const expectedEvent of [
    "pointer_down",
    "pointer_move",
    "pointer_up",
    "tap",
    "tap_to_click",
    "double_tap",
    "click",
    "double_click",
    "press",
    "press_to_click",
    "double_press",
    "long_press",
    "drag_start",
    "drag_move",
    "drag_end",
    "keydown",
    "wheel_swipe",
    "range_input",
    "range_change",
    "form_submit",
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

  const keydown = payload.events.find((event) => event.name === "keydown");
  expect(keydown.properties.key).toBe("Tab");
  expect(keydown.properties.code).toBe("Tab");
  expect(keydown.properties.target).toBeTruthy();

  const osLogDownload = downloads.find((item) => item.suggestedFilename().startsWith("os_event_log_"));
  const osLog = fs.readFileSync(await osLogDownload.path(), "utf8");
  expect(osLog).toContain("# start_epoch | ");
  expect(osLog).toContain("# format | EVENT | VALUE | EPOCH_SECONDS");
  expect(osLog).toContain("KEYDOWN | key=Tab code=Tab");
  expect(osLog).toContain("POINTER_MOVE | gesture=pointer_move");
  expect(osLog).toContain("TAP | ");
  expect(osLog).toContain("TAP_TO_CLICK | ");
  expect(osLog).toContain("PRESS_TO_CLICK | ");
  expect(osLog).toContain("DOUBLE_PRESS | ");
  expect(osLog).toContain("DRAG_END | ");

  const formSubmit = payload.events.find((event) => event.name === "form_submit");
  expect(formSubmit.properties.target.id).toBe("tracking-test-form");
  expect(formSubmit.properties.method).toBe("post");

  const stopClick = payload.events.find((event) => (
    event.name === "click" &&
    event.properties.target &&
    event.properties.target.id === "startSensingBtn" &&
    event.properties.target.label === "Stop sensing"
  ));
  expect(stopClick).toBeTruthy();
});
