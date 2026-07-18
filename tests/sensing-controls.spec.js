const fs = require("fs");
const { test, expect } = require("@playwright/test");

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

test("loops the chirp between start and stop sensing", async ({ page }) => {
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

  const downloads = [];
  page.on("download", (download) => {
    downloads.push(download);
  });

  await startButton.click();

  await expect.poll(
    async () => (await sensingState()).playbackActive,
    { timeout: 15000 }
  ).toBe(false);
  await expect(startButton).toBeEnabled();
  await expect(startButton).toHaveText("Start sensing");
  await expect(startButton).toHaveAttribute("aria-pressed", "false");
  await expect(stopButton).toBeHidden();
  await expect(downloadButton).toBeVisible({ timeout: 20000 });
  await expect(downloadButton).toBeEnabled();
  expect(downloads).toHaveLength(0);

  await downloadButton.click();
  await expect.poll(() => downloads.length).toBeGreaterThanOrEqual(5);

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
  expect(diagnostics.requestedMicrophoneConstraints.echoCancellation.exact).toBe(false);
  expect(diagnostics.recordingProfile.id).toBe("ultrasonic");
  expect(diagnostics.microphoneQualification.processingDisabled).toBe(true);
  expect(diagnostics.audioContext.sampleRate).toBe(48000);
  expect(diagnostics.audioContext.qualification.supported).toBe(true);
  expect(diagnostics.playback.scheduledStartTime).toBeGreaterThan(0);
  expect(diagnostics.playback.scheduledStartFrame).toBeGreaterThan(0);
  expect(diagnostics.recordingExport.encoding).toBe("IEEE_FLOAT");
  expect(diagnostics.recordingExport.channels).toBe(1);
  expect(diagnostics.recordingExport.bitsPerSample).toBe(32);
  expect(diagnostics.recordingCapture.method).toContain("AudioWorklet");
  expect(diagnostics.recordingCapture.frameSize).toBe(2048);
  expect(typeof diagnostics.recordingCapture.clippingDetected).toBe("boolean");
  expect(diagnostics.recordingCapture.clippedSamples).toBeGreaterThanOrEqual(0);
  expect(diagnostics.recordingCapture.workletFrameGaps).toBe(0);
  expect(diagnostics.signalCheck.method).toBe("normalized_autocorrelation_near_12ms_chirp_period");
  expect(diagnostics.signalCheck.chirpPeriodEstimate.expectedPeriodSamples).toBe(576);
  expect(diagnostics.signalCheck.chirpPeriodEstimate.expectedPeriodMs).toBe(12);
});
