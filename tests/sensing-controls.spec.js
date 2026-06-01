const fs = require("fs");
const { test, expect } = require("@playwright/test");

test("keeps realtime IQ local by default and allows hosted override", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getRealtimeDebugState().realtimeWebSocketUrl
  ))).toBe("ws://127.0.0.1:8765");
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
  ))).toBe(null);
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

test("loops the chirp between start and stop sensing", async ({ page }) => {
  await page.goto("/");

  const startButton = page.locator("#startSensingBtn");
  const stopButton = page.locator("#stopSensingBtn");
  const sensingState = () => page.evaluate(() => {
    const audio = document.getElementById("receivedAudio");
    return {
      loop: audio.loop,
      playbackActive: window.webAgentSensing.isPlaybackActive()
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
  await expect.poll(async () => (await sensingState()).loop).toBe(true);
  await expect.poll(async () => (await sensingState()).playbackActive).toBe(true);

  await page.waitForTimeout(500);

  const downloads = [];
  page.on("download", (download) => {
    downloads.push(download);
  });

  await stopButton.click();

  await expect.poll(() => downloads.length, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await sensingState()).playbackActive).toBe(false);
  await expect(startButton).toBeEnabled();
  await expect(stopButton).toBeDisabled();

  const fileNames = downloads.map((download) => download.suggestedFilename());
  expect(fileNames.some((name) => /^recording_\d{8}_\d{6}\.wav$/.test(name))).toBe(true);
  expect(fileNames.some((name) => /^recording_spectrogram_\d{8}_\d{6}\.png$/.test(name))).toBe(true);
  expect(fileNames.some((name) => /^recording_diagnostics_\d{8}_\d{6}\.json$/.test(name))).toBe(true);
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

  const diagnosticsDownload = downloads.find((item) => /^recording_diagnostics_\d{8}_\d{6}\.json$/.test(item.suggestedFilename()));
  const diagnostics = JSON.parse(fs.readFileSync(await diagnosticsDownload.path(), "utf8"));
  expect(diagnostics.requestedMicrophoneConstraints.channelCount.ideal).toBe(1);
  expect(diagnostics.requestedMicrophoneConstraints.sampleRate.ideal).toBe(48000);
  expect(diagnostics.audioContext.sampleRate).toBe(48000);
  expect(diagnostics.recordingExport.encoding).toBe("IEEE_FLOAT");
  expect(diagnostics.recordingExport.channels).toBe(1);
  expect(diagnostics.recordingExport.bitsPerSample).toBe(32);
  expect(diagnostics.signalCheck.method).toBe("normalized_autocorrelation_near_20ms_chirp_period");
});
