const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

async function installDurationLimitTimerTestHook(page) {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const durationTimerId = 35000;
    let durationTimerCallback = null;

    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 35000) {
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

test("supports strict ultrasonic and compatibility recording profiles", async ({ page }) => {
  await page.goto("/collection.html?activity=sitting_still");

  const profileSelect = page.locator("#recordingProfile");
  await expect(page.locator(".recording-profile-control")).toBeHidden();
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

  await profileSelect.evaluate((select) => {
    select.value = "compatible";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(profileSelect).toHaveValue("compatible");
  await expect(page.locator("#recordingProfileDescription")).toContainText("fallback");
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getRecordingProfile().id
  ))).toBe("compatible");
});

test("keeps realtime IQ local by default and allows hosted override", async ({ page }) => {
  await page.goto("/collection.html?activity=sitting_still");
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

  await page.goto("http://hosted.test:8010/collection.html?activity=sitting_still");
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

test("loops the chirp and automatically stops at the 35-second limit", async ({ page }) => {
  await installDurationLimitTimerTestHook(page);
  await page.goto("/collection.html?activity=sitting_still");

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
  await expect(startButton).toBeVisible();
  await expect(page.locator('input[name="collectionActivity"][value="sitting_still"]')).toBeChecked();
  await expect(startButton).toBeEnabled();
  await expect(stopButton).toBeHidden();
  await expect(page.locator("#downloadSessionBtn")).toHaveCount(0);

  await startButton.click();

  await expect(startButton).toHaveText("Stop sensing");
  await expect(startButton).toBeEnabled();
  await expect(startButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('input[name="collectionActivity"]').first()).toBeDisabled();
  await expect.poll(async () => (await sensingState()).loop).toBe(true);
  await expect.poll(async () => (await sensingState()).playbackActive).toBe(true);
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getRecordedFrameCount()
  )), { timeout: 10000 }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getMaximumSensingDurationSeconds()
  ))).toBe(35);
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.isDurationLimitTimerActive()
  ))).toBe(true);
  await expect(page.locator("#fileStatus")).toHaveText("");
  await expect(page.locator("#fileStatus")).toBeHidden();

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
  await expect.poll(() => downloads.length).toBeGreaterThanOrEqual(8);

  const fileNames = downloads.map((download) => download.suggestedFilename());
  expect(fileNames).toContain("keyboard_events.json");
  expect(fileNames).toContain("cursor_events.json");
  expect(fileNames.some((name) => name.startsWith("tracking_data_"))).toBe(false);
  expect(fileNames.some((name) => name.startsWith("os_event_log_"))).toBe(false);
  expect(fileNames.some((name) => /^recording_\d{8}_\d{6}\.wav$/.test(name))).toBe(true);
  expect(fileNames.some((name) => /^recording_spectrogram_\d{8}_\d{6}\.png$/.test(name))).toBe(true);
  expect(fileNames.some((name) => /^recording_live_python_iq_\d{8}_\d{6}\.png$/.test(name))).toBe(true);
  expect(fileNames.some((name) => /^recording_live_micro_doppler_left_\d{8}_\d{6}\.png$/.test(name))).toBe(true);
  expect(fileNames.some((name) => /^recording_live_micro_doppler_right_\d{8}_\d{6}\.png$/.test(name))).toBe(true);
  expect(fileNames).not.toContain("stage4_signal_events_amplitude_change.png");
  expect(fileNames).not.toContain("stage4_signal_events_phase_change.png");
  expect(fileNames).not.toContain("micro_doppler_left_band.png");
  expect(fileNames).not.toContain("micro_doppler_right_band.png");
  expect(fileNames).toContain("metadata.json");
  expect(fileNames.some((name) => /^recording_diagnostics_\d{8}_\d{6}\.json$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^input_events_amplitude_phase\.png$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^keydown_amplitude_phase\.png$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^01_alignment_and_recording_spectrogram_recording_\d{8}_\d{6}\.png$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^02_keystroke_motion_overlay_recording_\d{8}_\d{6}\.png$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^03_key_event_aligned_features_recording_\d{8}_\d{6}\.png$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^04_average_range_profile_recording_\d{8}_\d{6}\.png$/.test(name))).toBe(false);
  expect(fileNames.some((name) => /^05_keydown_zoom_overlay_recording_\d{8}_\d{6}\.png$/.test(name))).toBe(false);

  const liveFigureDownloads = downloads.filter((item) => (
    /^recording_live_(python_iq|micro_doppler_(left|right))_\d{8}_\d{6}\.png$/
      .test(item.suggestedFilename())
  ));
  expect(liveFigureDownloads).toHaveLength(3);
  for (const liveFigureDownload of liveFigureDownloads) {
    const png = fs.readFileSync(await liveFigureDownload.path());
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  }

  const audioDownload = downloads.find((item) => /^recording_\d{8}_\d{6}\.wav$/.test(item.suggestedFilename()));
  const wav = fs.readFileSync(await audioDownload.path());
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
  expect(wav.readUInt16LE(20)).toBe(3);
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt32LE(24)).toBe(48000);
  expect(wav.readUInt16LE(34)).toBe(32);
  const wavDurationSeconds = wav.readUInt32LE(40) / (48000 * 4);
  expect(wavDurationSeconds).toBeLessThanOrEqual(35);

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
    "n_cursor_events",
    "target_activity",
    "collection_timing",
    "typing_sentence_id",
    "typing_sentence_source",
    "typing_sentence"
  ]);
  expect(metadata.fs).toBe(48000);
  expect(metadata.chirp_samples).toBe(576);
  expect(metadata.left_band_hz).toEqual([19000, 20500]);
  expect(metadata.right_band_hz).toEqual([21500, 23000]);
  expect(metadata.tx_amplitude).toBe(0.12);
  expect(metadata.duration_sec).toBeGreaterThan(0);
  expect(metadata.duration_sec).toBeLessThanOrEqual(35);
  expect(metadata.recording_name).toMatch(/^recording_\d{8}_\d{6}$/);
  expect(metadata.capture).toContain("AudioWorklet");
  expect(typeof metadata.os.system).toBe("string");
  expect(metadata.n_key_events).toBe(0);
  expect(metadata.n_cursor_events).toBe(0);
  expect(metadata.target_activity).toBe("sitting_still");
  expect(metadata.collection_timing).toEqual({
    duration_sec: 35,
    initial_still_sec: [0, 5],
    action_sec: [5, 30],
    final_still_sec: [30, 35],
    sitting_still_entire_recording: true
  });
  expect(metadata.typing_sentence_id).toBeNull();
  expect(metadata.typing_sentence_source).toBeNull();
  expect(metadata.typing_sentence).toBeNull();
});

test("falls back to compatibility capture when strict AudioWorklet startup fails", async ({ page }) => {
  await page.addInitScript(() => {
    window.AudioWorkletNode = undefined;
  });
  await page.goto("/collection.html?activity=keyboard_activity");

  const startButton = page.locator("#startSensingBtn");
  await expect(startButton).toBeEnabled();
  await startButton.click();

  await expect(startButton).toHaveText("Stop sensing");
  await expect(page.locator("#micStatus")).toContainText("Compatibility fallback");
  await expect(page.locator("#fileStatus")).toContainText("Compatibility capture is active");
  await expect(page.locator("#fileStatus")).not.toContainText("Looping");
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getRecordingProfile().id
  ))).toBe("compatible");
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getCaptureDiagnostics().method
  ))).toContain("ScriptProcessorNode");

  await startButton.click();
});

test("generates the chirp mathematically without requesting the WAV file", async ({ page }) => {
  let chirpRequestCount = 0;
  await page.route("**/*.wav", async (route) => {
    chirpRequestCount += 1;
    await route.abort();
  });
  await page.goto("/collection.html?activity=keyboard_activity");

  const startButton = page.locator("#startSensingBtn");
  await expect(startButton).toBeEnabled();
  await expect(page.locator("#fileStatus")).toHaveText("Generated dual-band ultrasound chirp ready.");
  expect(chirpRequestCount).toBe(0);

  const generation = await page.evaluate(() => ({
    parameters: window.webAgentSensing.getChirpGenerationParameters(),
    channels: window.webAgentSensing.getGeneratedChirpPeriod()
  }));
  expect(generation.parameters).toEqual({
    sampleRate: 48000,
    durationSeconds: 0.012,
    samplesPerPeriod: 576,
    amplitude: 0.12,
    left: { startHz: 19000, endHz: 20500 },
    right: { startHz: 21500, endHz: 23000 }
  });

  const sourceWav = fs.readFileSync(path.join(
    __dirname,
    "..",
    "tx_dual_triangle_chirp_19_205_215_23.wav"
  ));
  const expectedChannels = [[], []];
  for (let frameIndex = 0; frameIndex < 576; frameIndex += 1) {
    expectedChannels[0].push(sourceWav.readFloatLE(58 + (frameIndex * 2 * 4)));
    expectedChannels[1].push(sourceWav.readFloatLE(58 + ((frameIndex * 2 + 1) * 4)));
  }
  expect(generation.channels).toEqual(expectedChannels);

  await startButton.click();

  await expect(startButton).toHaveText("Stop sensing");
  await expect(page.locator("#nextTypingSentenceBtn")).toBeDisabled();
  await expect(page.locator("#collectionPhaseStatus")).toBeVisible();
  await expect(page.locator("#collectionTimers, .collection-timers")).toBeHidden();
  await expect(page.locator("#collectionPromptInstruction")).toBeHidden();
  await expect(page.locator("#startSensingHint")).toBeHidden();
  await expect(page.locator("#fileStatus")).toHaveText("");
  await expect(page.locator("#fileStatus")).toBeHidden();
  expect(chirpRequestCount).toBe(0);
  await expect.poll(() => page.evaluate(() => (
    window.webAgentSensing.getChirpPlaybackInfo()
  ))).toEqual({
    channelCount: 2,
    frameCount: 576,
    sampleRate: 48000,
    durationSeconds: 0.012
  });

  await startButton.click();
  await expect(page.locator("#nextTypingSentenceBtn")).toBeEnabled();
});
