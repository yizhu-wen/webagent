const { test, expect } = require("@playwright/test");

test("loops the chirp between start and stop sensing", async ({ page }) => {
  await page.goto("/");

  const startButton = page.locator("#startSensingBtn");
  const stopButton = page.locator("#stopSensingBtn");
  const audioState = () => page.evaluate(() => {
    const audio = document.getElementById("receivedAudio");
    return {
      loop: audio.loop,
      paused: audio.paused
    };
  });

  await expect(startButton).toHaveText("Start sensing");
  await expect(stopButton).toHaveText("Stop");
  await expect(startButton).toBeVisible();
  await expect(startButton).toBeEnabled();
  await expect(stopButton).toBeDisabled();

  await startButton.click();

  await expect(stopButton).toBeEnabled();
  await expect(startButton).toBeDisabled();
  await expect.poll(async () => (await audioState()).loop).toBe(true);
  await expect.poll(async () => (await audioState()).paused).toBe(false);

  await page.waitForTimeout(500);

  const downloads = [];
  page.on("download", (download) => {
    downloads.push(download);
  });

  await stopButton.click();

  await expect.poll(() => downloads.length, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await audioState()).paused).toBe(true);
  await expect(startButton).toBeEnabled();
  await expect(stopButton).toBeDisabled();

  const fileNames = downloads.map((download) => download.suggestedFilename());
  expect(fileNames.some((name) => /^recording_\d{8}_\d{6}\.wav$/.test(name))).toBe(true);
  expect(fileNames.some((name) => /^recording_spectrogram_\d{8}_\d{6}\.png$/.test(name))).toBe(true);
});
