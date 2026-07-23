const fs = require("fs");
const { test, expect } = require("@playwright/test");

test("downloads Python-style keyboard and cursor event files", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#downloadEventLogBtn")).toHaveCount(0);
  await expect(page.locator("#downloadSessionBtn")).toHaveCount(0);
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

  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (
    window.interactionTracker.getEvents().some((event) => event.name === "scroll")
  ))).toBe(true);

  const downloads = [];
  page.on("download", (download) => {
    downloads.push(download);
  });

  await page.locator("#startSensingBtn").click();
  await expect.poll(() => (
    downloads.find((download) => download.suggestedFilename() === "keyboard_events.json")
      ? "ready"
      : ""
  )).toBe("ready");
  await expect.poll(() => (
    downloads.find((download) => download.suggestedFilename() === "cursor_events.json")
      ? "ready"
      : ""
  )).toBe("ready");

  const keyboardDownload = downloads.find((item) => item.suggestedFilename() === "keyboard_events.json");
  const cursorDownload = downloads.find((item) => item.suggestedFilename() === "cursor_events.json");
  const keyboardEvents = JSON.parse(fs.readFileSync(await keyboardDownload.path(), "utf8"));
  const cursorEvents = JSON.parse(fs.readFileSync(await cursorDownload.path(), "utf8"));

  expect(Array.isArray(keyboardEvents)).toBe(true);
  expect(Array.isArray(cursorEvents)).toBe(true);
  expect(keyboardEvents.length).toBeGreaterThanOrEqual(2);
  expect(cursorEvents.length).toBeGreaterThan(0);

  const keyDown = keyboardEvents.find((event) => event.event === "down" && event.key === "Key.tab");
  const keyUp = keyboardEvents.find((event) => event.event === "up" && event.key === "Key.tab");
  expect(keyDown).toBeTruthy();
  expect(keyUp).toBeTruthy();
  expect(Object.keys(keyDown).sort()).toEqual(["event", "flight_sec", "key", "t"]);
  expect(Object.keys(keyUp).sort()).toEqual(["dwell_sec", "event", "key", "t"]);
  expect(keyDown.flight_sec).toBeNull();
  expect(keyDown.t).toBeGreaterThanOrEqual(0);
  expect(keyUp.t).toBeGreaterThanOrEqual(keyDown.t);
  expect(keyUp.dwell_sec).toBeGreaterThanOrEqual(0);

  expect([...new Set(cursorEvents.map((event) => event.type))].sort()).toEqual([
    "click",
    "move",
    "scroll"
  ]);
  const move = cursorEvents.find((event) => event.type === "move");
  const clickPress = cursorEvents.find((event) => event.type === "click" && event.pressed === true);
  const clickRelease = cursorEvents.find((event) => event.type === "click" && event.pressed === false);
  const scroll = cursorEvents.find((event) => event.type === "scroll");
  expect(Object.keys(move).sort()).toEqual(["t", "type", "x", "y"]);
  expect(Object.keys(clickPress).sort()).toEqual(["button", "pressed", "t", "type", "x", "y"]);
  expect(Object.keys(scroll).sort()).toEqual(["dx", "dy", "t", "type", "x", "y"]);
  expect(clickPress.button).toBe("Button.left");
  expect(clickRelease.button).toBe("Button.left");
  expect(scroll.dy).not.toBe(0);
  expect(cursorEvents.every((event) => event.t >= 0)).toBe(true);

  const eventFileNames = downloads
    .map((download) => download.suggestedFilename())
    .filter((name) => /event|tracking/i.test(name));
  expect(eventFileNames.sort()).toEqual(["cursor_events.json", "keyboard_events.json"]);
});
