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

test("offers strict ultrasonic and compatibility recording profiles", async ({ page }) => {
  await page.goto("/");

  const profileSelect = page.locator("#recordingProfile");
  await expect(profileSelect).toHaveValue("ultrasonic");
  await expect(profileSelect.locator("option")).toHaveText([
    "Ultrasound (strict)",
    "Compatibility"
  ]);
  await expect(page.locator("#recordingProfileDescription")).toContainText("AudioWorklet");
  await expect(page.locator("#recordingProfileHint")).toHaveText(
    "If Ultrasound (strict) does not work, switch to Compatibility."
  );

  const strictRequest = await page.evaluate(() => (
    window.webAgentRecordingProfiles.createMicrophoneRequest("ultrasonic", 48000)
  ));
  expect(strictRequest.constraints.audio.echoCancellation.exact).toBe(false);
  expect(strictRequest.constraints.audio.noiseSuppression.exact).toBe(false);
  expect(strictRequest.constraints.audio.autoGainControl.exact).toBe(false);

  await profileSelect.selectOption("compatible");
  await expect(profileSelect).toHaveValue("compatible");
  await expect(page.locator("#recordingProfileDescription")).toContainText("fallback");
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getRecordingProfile().id
  ))).toBe("compatible");
});

test("keeps realtime IQ local by default and allows hosted override", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getRealtimeDebugState().realtimeWebSocketUrl
  ))).toBe("ws://127.0.0.1:8010/realtime");
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getRealtimeDebugState().audioEventOffsetMs
  ))).toBe(80);

  await page.evaluate(() => {
    window.localStorage.setItem("webagentAudioEventOffsetMs", "125");
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getRealtimeDebugState().audioEventOffsetMs
  ))).toBe(125);

  await page.goto("http://hosted.test:8010/");
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getRealtimeDebugState().realtimeWebSocketUrl
  ))).toBe("ws://hosted.test:8010/realtime");
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getRealtimeDebugState().audioEventOffsetMs
  ))).toBe(80);

  await page.evaluate(() => {
    window.localStorage.setItem("webagentRealtimeWebSocketUrl", "wss://iq.example.test/ws");
    window.localStorage.setItem("webagentAudioEventOffsetMs", "40");
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getRealtimeDebugState().realtimeWebSocketUrl
  ))).toBe("wss://iq.example.test/ws");
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getRealtimeDebugState().audioEventOffsetMs
  ))).toBe(40);
});

test("loops the chirp and automatically stops at the 40-second limit", async ({ page }) => {
  await installDurationLimitTimerTestHook(page);
  await page.goto("/");

  const startButton = page.locator("#startSensingBtn");
  const stopButton = page.locator("#stopSensingBtn");
  const downloadButton = page.locator("#downloadSessionBtn");
  const sensingState = () => page.evaluate(() => {
    const audio = document.getElementById("receivedAudio");
    return {
      loop: audio.loop,
      playbackActive: window.webAgentSensing.isPlaybackActive()
    };
  });

  await expect(startButton).toHaveText("Start sensing");
  await expect(startButton).toBeVisible();
  await expect(startButton).toBeEnabled();
  await expect(stopButton).toBeHidden();
  await expect(downloadButton).toBeHidden();

  await startButton.click();

  await expect(startButton).toHaveText("Stop sensing");
  await expect(startButton).toBeEnabled();
  await expect(startButton).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await sensingState()).loop).toBe(true);
  await expect.poll(async () => (await sensingState()).playbackActive).toBe(true);
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getRecordedFrameCount()
  )), { timeout: 10000 }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getMaximumSensingDurationSeconds()
  ))).toBe(40);
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.isDurationLimitTimerActive()
  ))).toBe(true);
  await expect(page.locator("#fileStatus")).toContainText("automatically after 40 seconds");

  const downloads = [];
  page.on("download", (download) => {
    downloads.push(download);
  });

  await page.evaluate(() => window.__triggerDurationLimitForTest());

  await expect.poll(
    async () => (await sensingState()).playbackActive,
    { timeout: 15000 }
  ).toBe(false);
  await expect(stopButton).toBeHidden();
  await expect(downloadButton).toBeVisible({ timeout: 20000 });
  await expect(downloadButton).toBeEnabled();
  await expect(startButton).toBeEnabled();
  await expect(startButton).toHaveText("Start sensing");
  await expect(startButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#spectrogramStatus")).toContainText("18-24 kHz");
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.isDurationLimitTimerActive()
  ))).toBe(false);
  const spectrogramFormat = await page.evaluate(() => {
    const canvas = document.getElementById("spectrogramCanvas");
    const context = canvas.getContext("2d");
    return {
      height: canvas.height,
      background: Array.from(context.getImageData(0, 0, 1, 1).data)
    };
  });
  expect(spectrogramFormat.height).toBe(394);
  expect(spectrogramFormat.background).toEqual([255, 255, 255, 255]);
  expect(downloads).toHaveLength(0);

  await downloadButton.click();
  await expect.poll(() => downloads.length).toBeGreaterThanOrEqual(5);

  const fileNames = downloads.map((download) => download.suggestedFilename());
  expect(fileNames).toContain("keyboard_events.json");
  expect(fileNames).toContain("cursor_events.json");
  expect(fileNames.some((name) => name.startsWith("tracking_data_"))).toBe(false);
  expect(fileNames.some((name) => name.startsWith("os_event_log_"))).toBe(false);
  expect(fileNames.some((name) => /^recording_\d{8}_\d{6}\.wav$/.test(name))).toBe(true);
  expect(fileNames.some((name) => /^recording_spectrogram_\d{8}_\d{6}\.png$/.test(name))).toBe(true);
  expect(fileNames).toContain("metadata.json");
  expect(fileNames.some((name) => /^recording_diagnostics_\d{8}_\d{6}\.json$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^input_events_amplitude_phase\.png$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^keydown_amplitude_phase\.png$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^01_alignment_and_recording_spectrogram_recording_\d{8}_\d{6}\.png$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^02_keystroke_motion_overlay_recording_\d{8}_\d{6}\.png$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^03_key_event_aligned_features_recording_\d{8}_\d{6}\.png$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^04_average_range_profile_recording_\d{8}_\d{6}\.png$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^05_keydown_zoom_overlay_recording_\d{8}_\d{6}\.png$/.test(name))).toBe(false);

  const audioDownload = downloads.find((item) => /^recording_\d{8}_\d{6}\.wav$/.test(item.suggestedFilename()));
  const wav = fs.readFileSync(await audioDownload.path());
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
  expect(wav.readUInt16LE(20)).toBe(3);
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt32LE(24)).toBe(48000);
  expect(wav.readUInt16LE(34)).toBe(32);
  const wavDurationSeconds = wav.readUInt32LE(40) / (48000 * 4);
  expect(wavDurationSeconds).toBeLessThanOrEqual(40);

  const metadataDownload = downloads.find((item) => item.suggestedFilename() === "metadata.json");
  const metadata = JSON.parse(fs.readFileSync(await metadataDownload.path(), "utf8"));
  expect(Object.keys(metadata)).toEqual([
    "fs",
    "chirp_samples",
    "left_band_hz",
    "right_band_hz",
    "tx_amplitude",
    "duration_sec",
    "recording_name",
    "capture",
    "os",
    "n_key_events",
    "n_cursor_events"
  ]);
  expect(metadata.fs).toBe(48000);
  expect(metadata.chirp_samples).toBe(576);
  expect(metadata.left_band_hz).toEqual([19000, 20500]);
  expect(metadata.right_band_hz).toEqual([21500, 23000]);
  expect(metadata.tx_amplitude).toBe(0.12);
  expect(metadata.duration_sec).toBeGreaterThan(0);
  expect(metadata.duration_sec).toBeLessThanOrEqual(40);
  expect(metadata.recording_name).toMatch(/^recording_\d{8}_\d{6}$/);
  expect(metadata.capture).toContain("AudioWorklet");
  expect(typeof metadata.os.system).toBe("string");
  expect(metadata.n_key_events).toBe(0);
  expect(metadata.n_cursor_events).toBe(0);
});
