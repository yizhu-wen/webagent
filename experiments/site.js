document.addEventListener("DOMContentLoaded", () => {
  let cartCount = 0;
  let cartTotal = 0;
  const cartCountNode = document.querySelector("[data-cart-count]");
  const cartTotalNode = document.querySelector("[data-cart-total]");
  const activityNode = document.querySelector("[data-activity-status]");
  const micStatusNode = document.querySelector("[data-mic-status]") || document.getElementById("shoppingMicStatus");
  const sensingStatusNode = document.querySelector("[data-sensing-status]") || document.getElementById("shoppingSensingStatus");
  const startSensingBtn = document.querySelector("[data-start-sensing]") || document.getElementById("shoppingStartSensingBtn");
  const stopSensingBtn = document.querySelector("[data-stop-sensing]") || document.getElementById("shoppingStopSensingBtn");
  const downloadSessionBtn = document.querySelector("[data-download-session]");
  const sensingAudio = document.querySelector("[data-sensing-audio]") || document.getElementById("shoppingSensingAudio");
  const spectrogramPanel = document.querySelector("[data-spectrogram-panel]") || document.getElementById("shoppingSpectrogramPanel");
  const spectrogramStatus = document.querySelector("[data-spectrogram-status]") || document.getElementById("shoppingSpectrogramStatus");
  const spectrogramCanvas = document.querySelector("[data-spectrogram-canvas]") || document.getElementById("shoppingSpectrogramCanvas");
  const featureVisualizationPanel = document.querySelector("[data-feature-visualization-panel]");
  const featureVisualizationStatus = document.querySelector("[data-feature-visualization-status]");
  const featureVisualizationGrid = document.querySelector("[data-feature-visualization-grid]");
  const windowPredictionSection = document.querySelector("[data-window-prediction-section]");
  const windowPredictionStatus = document.querySelector("[data-window-prediction-status]");
  const windowPredictionBody = document.querySelector("[data-window-prediction-body]");
  const realtimePanel = document.querySelector("[data-realtime-panel]");
  const realtimeStatus = document.querySelector("[data-realtime-status]");
  const realtimeCanvas = document.querySelector("[data-realtime-canvas]");
  const recordingProfileSelect = document.querySelector("[data-recording-profile]");
  const recordingProfileDescription = document.querySelector("[data-recording-profile-description]");
  const recordingProfiles = window.webAgentRecordingProfiles;
  const chirpAudioFileName = "tx_dual_triangle_chirp_19_205_215_23.wav";
  const chirpPeriodSeconds = 0.012;
  const chirpAudioUrl = resolveChirpAudioUrl();
  const audioWorkletUrl = resolveAudioWorkletUrl();
  const siteLabel = document.body.dataset.siteLabel || "Shopping behavior";
  const resultLabel = document.body.dataset.resultLabel || "products";
  const recordingFilePrefix = document.body.dataset.recordingPrefix || "shopping_recording";
  const analysisApiUrl = "/api/analyze-recording";
  const targetSampleRate = 48000;
  const maximumSensingDurationSeconds = 40;
  const maximumSensingDurationMs = maximumSensingDurationSeconds * 1000;
  const realtimeFrameSize = 2048;
  const realtimeTimelineDurationSeconds = maximumSensingDurationSeconds;
  const realtimeTimelineTickSeconds = 5;
  const realtimeStillRegions = [
    { start: 0, end: 5, label: "STILL" },
    { start: 35, end: 40, label: "STILL" }
  ];
  const realtimeMaxPoints = 2400;
  const realtimeMaxWaveformPoints = 10000;
  const realtimeMaxMarkers = 220;
  const realtimeWaveformPlotHz = 240;
  const realtimeMaxSocketBufferedBytes = 512 * 1024;
  const realtimeAudioFrameHeaderBytes = 20;
  let micStream = null;
  let audioContext = null;
  let chirpPlaybackBuffer = null;
  let chirpSourceNode = null;
  let sensingSourceNode = null;
  let sensingProcessorNode = null;
  let sensingWorkletNode = null;
  let sensingMonitorNode = null;
  let audioWorkletModuleReady = false;
  let recordingBufferChunks = [];
  let recordingChannelCount = 0;
  let recordedFrameCount = 0;
  let sensingActive = false;
  let sensingStopInProgress = false;
  let sensingDurationTimerId = null;
  let sensingDurationLimitReached = false;
  let preparedSessionFiles = [];
  let selectedDetailTrip = null;
  let realtimeSocket = null;
  let realtimeStreamingActive = false;
  let realtimeSessionStartEpoch = null;
  let realtimeFrameSequence = 0;
  let realtimeFeaturePoints = [];
  let realtimeWaveformPoints = [];
  let realtimeEventMarkers = [];
  let realtimeDrawPending = false;
  let realtimeLastStatusMessage = "Start sensing to see live raw audio, amplitude, and phase.";
  let realtimeFramesSent = 0;
  let realtimeFramesReceived = 0;
  let realtimeFeaturesReceived = 0;
  let realtimeFramesDroppedBeforeSend = 0;
  let activeRecordingProfileId = recordingProfiles.normalizeProfileId(getLocalStorageItem("webagentRecordingProfile"));
  let microphoneRequestDetails = null;
  let microphoneQualification = null;
  let audioContextQualification = null;
  let recordingCaptureMethod = "not-started";
  let recordingCaptureFrameSize = 0;
  let recordingChunksCaptured = 0;
  let recordingClippedSamples = 0;
  let recordingPeakAmplitude = 0;
  let recordingWorkletFrameGaps = 0;
  let recordingLastWorkletSequence = 0;
  let completedCaptureDiagnostics = null;
  let chirpScheduledStartTime = null;
  let chirpScheduledStartFrame = null;
  function resolveChirpAudioUrl() {
    if (document.body.dataset.chirpAudio) {
      return new URL(document.body.dataset.chirpAudio, window.location.href).href;
    }

    const siteScript = Array.from(document.scripts).find((script) => {
      const src = script.getAttribute("src") || "";
      return src.endsWith("site.js") || src.includes("/site.js?");
    });
    const siteScriptUrl = siteScript ? siteScript.src : window.location.href;
    return new URL(`../${chirpAudioFileName}`, siteScriptUrl).href;
  }

  function resolveAudioWorkletUrl() {
    const siteScript = Array.from(document.scripts).find((script) => {
      const src = script.getAttribute("src") || "";
      return src.endsWith("site.js") || src.includes("/site.js?");
    });
    const siteScriptUrl = siteScript ? siteScript.src : window.location.href;
    return new URL("../audio-frame-worklet.js", siteScriptUrl).href;
  }

  function getLocalStorageItem(key) {
    try {
      return window.localStorage.getItem(key) || "";
    } catch (error) {
      return "";
    }
  }

  function getLocalStorageNumber(key, fallbackValue) {
    const rawValue = getLocalStorageItem(key);
    if (!rawValue) {
      return fallbackValue;
    }
    const parsedValue = Number(rawValue);
    return Number.isFinite(parsedValue) ? parsedValue : fallbackValue;
  }

  function setLocalStorageItem(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      // Storage may be unavailable in private or restricted browser contexts.
    }
  }

  function updateRecordingProfileControl() {
    if (!recordingProfileSelect || !recordingProfileDescription) {
      return;
    }
    const profile = recordingProfiles.getProfile(activeRecordingProfileId);
    recordingProfileSelect.value = profile.id;
    recordingProfileDescription.textContent = profile.description;
  }

  function initializeRecordingProfileControl() {
    if (!recordingProfileSelect) {
      return;
    }
    recordingProfileSelect.replaceChildren();
    for (const profile of recordingProfiles.list()) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.label;
      recordingProfileSelect.appendChild(option);
    }
    updateRecordingProfileControl();

    recordingProfileSelect.addEventListener("change", async () => {
      if (sensingActive) {
        updateRecordingProfileControl();
        return;
      }
      activeRecordingProfileId = recordingProfiles.normalizeProfileId(recordingProfileSelect.value);
      setLocalStorageItem("webagentRecordingProfile", activeRecordingProfileId);
      updateRecordingProfileControl();
      microphoneRequestDetails = null;
      microphoneQualification = null;
      if (micStream) {
        micStream.getTracks().forEach((track) => track.stop());
        micStream = null;
      }
      stopSensingCapture();
      stopChirpPlayback();
      if (audioContext) {
        try {
          await audioContext.close();
        } catch (error) {
          // The context may already be closed.
        }
        audioContext = null;
        audioContextQualification = null;
        audioWorkletModuleReady = false;
        chirpPlaybackBuffer = null;
      }
      if (micStatusNode) {
        micStatusNode.textContent = "Applying recording profile...";
      }
      setSensingControls(false, false);
      await requestMicrophone();
    });
  }

  function getRealtimeWebSocketUrl() {
    const overrideUrl = getLocalStorageItem("webagentRealtimeWebSocketUrl").trim();
    if (overrideUrl) {
      return overrideUrl;
    }
    if (!window.location.host) {
      return "ws://127.0.0.1:8000/realtime";
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/realtime`;
  }

  function setActivity(message) {
    if (activityNode) {
      activityNode.textContent = message;
    }
  }

  function updateCart(price) {
    cartCount += 1;
    cartTotal += price;
    if (cartCountNode) {
      cartCountNode.textContent = String(cartCount);
    }
    if (cartTotalNode) {
      cartTotalNode.textContent = `$${cartTotal.toFixed(2)}`;
    }
  }

  function setSensingStatus(message) {
    if (sensingStatusNode) {
      sensingStatusNode.textContent = message;
    }
  }

  function setSensingControls(micReady, active) {
    if (startSensingBtn) {
      startSensingBtn.disabled = !micReady && !active;
      startSensingBtn.textContent = active ? "Stop sensing" : "Start sensing";
      startSensingBtn.setAttribute("aria-pressed", String(active));
    }
    if (stopSensingBtn) {
      stopSensingBtn.disabled = true;
      stopSensingBtn.hidden = true;
      stopSensingBtn.setAttribute("aria-hidden", "true");
    }
    if (downloadSessionBtn) {
      downloadSessionBtn.disabled = !preparedSessionFiles.length || active;
    }
    if (recordingProfileSelect) {
      recordingProfileSelect.disabled = active;
    }
  }

  function getMicrophoneConstraints() {
    return recordingProfiles.createMicrophoneRequest(
      activeRecordingProfileId,
      targetSampleRate
    ).constraints;
  }

  function getPrimaryAudioTrack() {
    if (!micStream) {
      return null;
    }
    return micStream.getAudioTracks().find((track) => track.readyState === "live") || null;
  }

  function tryCallTrackMethod(track, methodName) {
    if (!track || typeof track[methodName] !== "function") {
      return null;
    }

    try {
      return track[methodName]();
    } catch (error) {
      return { error: error.message };
    }
  }

  function getAudioContext() {
    if (!audioContext) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const profile = recordingProfiles.getProfile(activeRecordingProfileId);
      audioContext = new AudioContextCtor({
        sampleRate: targetSampleRate,
        latencyHint: profile.latencyHint
      });
      audioContextQualification = recordingProfiles.qualifyAudioContext(
        audioContext,
        activeRecordingProfileId,
        targetSampleRate
      );
    }
    return audioContext;
  }

  function stopSensingCapture() {
    if (sensingSourceNode) {
      sensingSourceNode.disconnect();
      sensingSourceNode = null;
    }
    if (sensingProcessorNode) {
      sensingProcessorNode.disconnect();
      sensingProcessorNode.onaudioprocess = null;
      sensingProcessorNode = null;
    }
    if (sensingWorkletNode) {
      sensingWorkletNode.port.onmessage = null;
      sensingWorkletNode.disconnect();
      sensingWorkletNode = null;
    }
    if (sensingMonitorNode) {
      sensingMonitorNode.disconnect();
      sensingMonitorNode = null;
    }
  }

  async function loadChirpPlaybackBuffer() {
    const context = getAudioContext();
    const response = await fetch(chirpAudioUrl);
    if (!response.ok) {
      throw new Error("Audio fetch failed");
    }

    const chirpArrayBuffer = await response.arrayBuffer();
    chirpPlaybackBuffer = await context.decodeAudioData(chirpArrayBuffer.slice(0));
  }

  function startChirpPlayback() {
    if (!chirpPlaybackBuffer) {
      throw new Error("Chirp audio is not decoded");
    }

    const context = getAudioContext();
    stopChirpPlayback();
    chirpSourceNode = context.createBufferSource();
    chirpSourceNode.buffer = chirpPlaybackBuffer;
    chirpSourceNode.loop = true;
    chirpSourceNode.connect(context.destination);
    chirpSourceNode.onended = () => {
      chirpSourceNode = null;
    };
    chirpScheduledStartTime = context.currentTime + 0.05;
    chirpScheduledStartFrame = Math.round(chirpScheduledStartTime * context.sampleRate);
    chirpSourceNode.start(chirpScheduledStartTime);
    sensingAudio.loop = true;
  }

  function stopChirpPlayback() {
    if (!chirpSourceNode) {
      return;
    }

    const sourceNode = chirpSourceNode;
    chirpSourceNode = null;
    sourceNode.onended = null;
    try {
      sourceNode.stop();
    } catch (error) {
      // Already stopped.
    }
    sourceNode.disconnect();
  }

  function resetRecordingBuffers() {
    recordingBufferChunks = [];
    recordingChannelCount = 0;
    recordedFrameCount = 0;
  }

  function resetCaptureMetrics() {
    recordingCaptureMethod = "not-started";
    recordingCaptureFrameSize = 0;
    recordingChunksCaptured = 0;
    recordingClippedSamples = 0;
    recordingPeakAmplitude = 0;
    recordingWorkletFrameGaps = 0;
    recordingLastWorkletSequence = 0;
    completedCaptureDiagnostics = null;
  }

  function getCaptureDiagnostics() {
    return {
      method: recordingCaptureMethod,
      frameSize: recordingCaptureFrameSize,
      maximumDurationSeconds: maximumSensingDurationSeconds,
      durationLimitReached: sensingDurationLimitReached,
      chunksCaptured: recordingChunksCaptured,
      workletFrameGaps: recordingWorkletFrameGaps,
      clippedSamples: recordingClippedSamples,
      clippingDetected: recordingClippedSamples > 0,
      peakAbsoluteAmplitude: recordingPeakAmplitude,
      socketFramesDroppedBeforeSend: realtimeFramesDroppedBeforeSend
    };
  }

  function clearSensingDurationTimer() {
    if (sensingDurationTimerId === null) {
      return;
    }
    window.clearTimeout(sensingDurationTimerId);
    sensingDurationTimerId = null;
  }

  function requestSensingStopAtDurationLimit() {
    if (sensingDurationLimitReached || sensingStopInProgress) {
      return;
    }
    sensingDurationLimitReached = true;
    clearSensingDurationTimer();
    void stopSensing({ durationLimitReached: true });
  }

  function startSensingDurationTimer() {
    clearSensingDurationTimer();
    sensingDurationTimerId = window.setTimeout(() => {
      sensingDurationTimerId = null;
      requestSensingStopAtDurationLimit();
    }, maximumSensingDurationMs);
  }

  function getMaximumRecordingFrames() {
    const sampleRate = audioContext && Number.isFinite(audioContext.sampleRate)
      ? audioContext.sampleRate
      : targetSampleRate;
    return Math.floor(sampleRate * maximumSensingDurationSeconds);
  }

  function handleRecordedAudioChunk(chunk, metadata = {}) {
    if (!(chunk instanceof Float32Array) || !chunk.length) {
      return;
    }
    const remainingFrames = getMaximumRecordingFrames() - recordedFrameCount;
    if (remainingFrames <= 0) {
      requestSensingStopAtDurationLimit();
      return;
    }
    const recordedChunk = chunk.length > remainingFrames
      ? chunk.slice(0, remainingFrames)
      : chunk;
    if (!recordingChannelCount) {
      recordingChannelCount = 1;
    }
    if (Number.isFinite(metadata.sequence)) {
      if (recordingLastWorkletSequence && metadata.sequence > recordingLastWorkletSequence + 1) {
        recordingWorkletFrameGaps += metadata.sequence - recordingLastWorkletSequence - 1;
      }
      recordingLastWorkletSequence = metadata.sequence;
    }
    for (let sampleIndex = 0; sampleIndex < recordedChunk.length; sampleIndex += 1) {
      const absoluteSample = Math.abs(recordedChunk[sampleIndex]);
      recordingPeakAmplitude = Math.max(recordingPeakAmplitude, absoluteSample);
      if (absoluteSample >= 0.999) {
        recordingClippedSamples += 1;
      }
    }
    recordingBufferChunks.push(recordedChunk);
    recordedFrameCount += recordedChunk.length;
    recordingChunksCaptured += 1;
    appendRealtimeWaveform(recordedChunk);
    sendRealtimeAudioFrame(recordedChunk);
    if (recordedFrameCount >= getMaximumRecordingFrames()) {
      requestSensingStopAtDurationLimit();
    }
  }

  function buildTimestamp() {
    const now = new Date();
    const date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0")
    ].join("");
    const time = [
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0")
    ].join("");
    return `${date}_${time}`;
  }

  function triggerDownload(downloadUrl, fileName) {
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function downloadFileArtifact(file) {
    if (!file || !file.name || (!file.blob && !file.url)) {
      return false;
    }

    const downloadUrl = file.blob ? URL.createObjectURL(file.blob) : file.url;
    triggerDownload(downloadUrl, file.name);
    if (file.blob) {
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    }
    return true;
  }

  function downloadFileArtifacts(files) {
    return (Array.isArray(files) ? files : [])
      .reduce((count, file) => count + Number(downloadFileArtifact(file)), 0);
  }

  function setPreparedSessionFiles(files) {
    preparedSessionFiles = (Array.isArray(files) ? files : [])
      .filter((file) => file && file.name && (file.blob || file.url));
    if (!downloadSessionBtn) {
      return;
    }

    const hasFiles = preparedSessionFiles.length > 0;
    downloadSessionBtn.hidden = !hasFiles;
    downloadSessionBtn.disabled = !hasFiles || sensingActive;
    downloadSessionBtn.textContent = hasFiles
      ? `Download session files (${preparedSessionFiles.length})`
      : "Download session files";
  }

  function downloadPreparedSessionFiles() {
    if (!preparedSessionFiles.length || sensingActive) {
      return;
    }

    const downloadCount = downloadFileArtifacts(preparedSessionFiles);
    setSensingStatus(`Download started for ${downloadCount} session files.`);
  }

  function clampPcmSample(sample) {
    return Math.max(-1, Math.min(1, sample));
  }

  function estimateChirpPeriod(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const expectedPeriodSamples = Math.round(chirpPeriodSeconds * sampleRate);
    const samples = toMonoChannel(audioBuffer);
    const analysisLength = Math.min(samples.length, Math.round(sampleRate * 1.5));

    if (analysisLength < expectedPeriodSamples * 4) {
      return {
        status: "insufficient_audio",
        expectedPeriodSamples,
        expectedPeriodMs: chirpPeriodSeconds * 1000,
        sampleRate
      };
    }

    let energy = 0;
    for (let index = 0; index < analysisLength; index += 1) {
      energy += samples[index] * samples[index];
    }
    const rms = Math.sqrt(energy / analysisLength);
    if (rms < 1e-6) {
      return {
        status: "too_quiet",
        expectedPeriodSamples,
        expectedPeriodMs: chirpPeriodSeconds * 1000,
        sampleRate,
        rms
      };
    }

    const searchRadius = Math.max(2, Math.round(expectedPeriodSamples * 0.02));
    let bestLag = expectedPeriodSamples;
    let bestScore = -Infinity;

    for (let lag = expectedPeriodSamples - searchRadius; lag <= expectedPeriodSamples + searchRadius; lag += 1) {
      let cross = 0;
      let energyA = 0;
      let energyB = 0;
      const compareLength = analysisLength - lag;

      for (let index = 0; index < compareLength; index += 1) {
        const a = samples[index];
        const b = samples[index + lag];
        cross += a * b;
        energyA += a * a;
        energyB += b * b;
      }

      const score = cross / Math.sqrt((energyA * energyB) + 1e-24);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }

    return {
      status: bestScore > 0.05 ? "estimated" : "low_confidence",
      expectedPeriodSamples,
      estimatedPeriodSamples: bestLag,
      deviationSamples: bestLag - expectedPeriodSamples,
      estimatedPeriodMs: (bestLag / sampleRate) * 1000,
      expectedPeriodMs: chirpPeriodSeconds * 1000,
      normalizedCorrelation: bestScore,
      analyzedSamples: analysisLength,
      sampleRate,
      rms
    };
  }

  function buildAudioDiagnostics(recordedAudioBuffer, chirpPeriodEstimate) {
    const track = getPrimaryAudioTrack();
    const context = getAudioContext();
    const profile = recordingProfiles.getProfile(activeRecordingProfileId);
    return {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      browser: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        crossOriginIsolated: Boolean(window.crossOriginIsolated)
      },
      recordingProfile: {
        id: profile.id,
        label: profile.label,
        requireConfirmedDisabledProcessing: profile.requireConfirmedDisabledProcessing,
        requireAudioWorklet: profile.requireAudioWorklet,
        requireTargetContextSampleRate: profile.requireTargetContextSampleRate
      },
      requestedMicrophoneConstraints: microphoneRequestDetails
        ? microphoneRequestDetails.constraints.audio
        : getMicrophoneConstraints().audio,
      microphoneTrack: {
        present: Boolean(track),
        label: track ? track.label : "",
        readyState: track ? track.readyState : "",
        enabled: track ? track.enabled : null,
        muted: track ? track.muted : null,
        settings: tryCallTrackMethod(track, "getSettings"),
        capabilities: tryCallTrackMethod(track, "getCapabilities"),
        constraints: tryCallTrackMethod(track, "getConstraints")
      },
      microphoneQualification,
      audioContext: {
        sampleRate: context.sampleRate,
        state: context.state,
        baseLatency: Number.isFinite(context.baseLatency) ? context.baseLatency : null,
        outputLatency: Number.isFinite(context.outputLatency) ? context.outputLatency : null,
        qualification: audioContextQualification
      },
      playback: {
        engine: "Web Audio AudioBufferSourceNode",
        chirpFileName: chirpAudioFileName,
        chirpBufferSampleRate: chirpPlaybackBuffer ? chirpPlaybackBuffer.sampleRate : null,
        chirpBufferLength: chirpPlaybackBuffer ? chirpPlaybackBuffer.length : null,
        chirpBufferDuration: chirpPlaybackBuffer ? chirpPlaybackBuffer.duration : null,
        scheduledStartTime: chirpScheduledStartTime,
        scheduledStartFrame: chirpScheduledStartFrame,
        loop: true
      },
      recordingExport: {
        container: "WAV",
        encoding: "IEEE_FLOAT",
        channels: 1,
        bitsPerSample: 32,
        sampleRate: recordedAudioBuffer.sampleRate,
        frameCount: recordedAudioBuffer.length,
        duration: recordedAudioBuffer.duration
      },
      recordingCapture: completedCaptureDiagnostics || getCaptureDiagnostics(),
      signalCheck: {
        method: "normalized_autocorrelation_near_12ms_chirp_period",
        chirpPeriodEstimate
      },
      limitations: [
        "Browser APIs report the stream visible to JavaScript, not every conversion inside the OS mixer or hardware driver.",
        "If device hardware runs at a different native rate, the browser or OS may resample before JavaScript receives audio.",
        "The chirp-period signal check is empirical evidence from the exported recording, not direct access to hardware clocks."
      ]
    };
  }

  function getBrowserOsMetadata() {
    const userAgent = navigator.userAgent || "";
    let system = "Unknown";
    if (/Windows/i.test(userAgent)) {
      system = "Windows";
    } else if (/Macintosh|Mac OS X/i.test(userAgent)) {
      system = "Darwin";
    } else if (/Android/i.test(userAgent)) {
      system = "Android";
    } else if (/iPhone|iPad|iPod/i.test(userAgent)) {
      system = "iOS";
    } else if (/Linux/i.test(userAgent)) {
      system = "Linux";
    }

    return {
      system,
      release: null,
      machine: null,
      node: null
    };
  }

  function buildMetadataArtifact(recordedAudioBuffer, diagnostics, trackingArtifacts, timestamp) {
    const keyboardEvents = (trackingArtifacts && trackingArtifacts.keyboardEvents) || [];
    const cursorEvents = (trackingArtifacts && trackingArtifacts.cursorEvents) || [];
    const metadata = {
      fs: recordedAudioBuffer.sampleRate,
      chirp_samples: Math.round(chirpPeriodSeconds * recordedAudioBuffer.sampleRate),
      left_band_hz: [19000, 20500],
      right_band_hz: [21500, 23000],
      tx_amplitude: 0.12,
      duration_sec: recordedAudioBuffer.duration,
      recording_name: `${recordingFilePrefix}_${timestamp}`,
      capture: diagnostics && diagnostics.recordingCapture
        ? diagnostics.recordingCapture.method
        : recordingCaptureMethod,
      os: getBrowserOsMetadata(),
      n_key_events: keyboardEvents.length,
      n_cursor_events: cursorEvents.length
    };

    return {
      name: "metadata.json",
      blob: new Blob([JSON.stringify(metadata, null, 2)], { type: "application/json" })
    };
  }

  function buildGeneratedFigureArtifacts(result) {
    if (!result || !Array.isArray(result.figures)) {
      return [];
    }

    return result.figures
      .filter((figure) => figure && figure.url && figure.name)
      .map((figure) => ({
        name: figure.name,
        url: figure.url
      }));
  }

  function formatGeneratedFigureTitle(fileName) {
    return fileName
      .replace(/^\d+_/, "")
      .replace(/\.png$/i, "")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function clearFeatureVisualizations() {
    if (!featureVisualizationPanel || !featureVisualizationGrid || !featureVisualizationStatus) {
      return;
    }
    featureVisualizationGrid.replaceChildren();
    if (windowPredictionBody) {
      windowPredictionBody.replaceChildren();
    }
    if (windowPredictionSection) {
      windowPredictionSection.hidden = true;
    }
    if (windowPredictionStatus) {
      windowPredictionStatus.textContent = "";
    }
    featureVisualizationPanel.hidden = true;
    featureVisualizationStatus.textContent = "Calculated after sensing stops.";
  }

  function renderGeneratedFigures(result) {
    clearFeatureVisualizations();
    if (
      !featureVisualizationPanel
      || !featureVisualizationGrid
      || !featureVisualizationStatus
      || !result
      || !Array.isArray(result.figures)
      || !result.figures.length
    ) {
      return 0;
    }

    for (const figure of result.figures) {
      if (!figure || !figure.url || !figure.name) {
        continue;
      }
      const item = document.createElement("figure");
      item.className = "feature-visualization-item";
      const image = document.createElement("img");
      image.src = figure.url;
      image.alt = formatGeneratedFigureTitle(figure.name);
      image.loading = "lazy";
      const caption = document.createElement("figcaption");
      const title = document.createElement("strong");
      title.textContent = formatGeneratedFigureTitle(figure.name);
      caption.append(title);
      if (figure.description) {
        caption.append(document.createElement("br"), figure.description);
      }
      item.append(image, caption);
      featureVisualizationGrid.append(item);
    }

    featureVisualizationStatus.textContent =
      "Post-processed from the completed recording using the model feature pipeline.";
    featureVisualizationPanel.hidden = false;
    return featureVisualizationGrid.childElementCount;
  }

  function getPredictionLabelColor(label) {
    const colors = {
      body_motion: "#277da1",
      click_tap: "#f9844a",
      hand_wave: "#43aa8b",
      keydown: "#b8860b",
      no_event: "#6c757d",
      pointer_move: "#9b5de5",
      scroll: "#577590"
    };
    return colors[label] || "#455a64";
  }

  function renderWindowPredictions(result) {
    if (!windowPredictionSection || !windowPredictionStatus || !windowPredictionBody) {
      return 0;
    }
    const predictionResult = result && result.predictions;
    const rows = predictionResult && Array.isArray(predictionResult.predictions)
      ? predictionResult.predictions
      : [];
    windowPredictionBody.replaceChildren();
    if (!rows.length) {
      windowPredictionSection.hidden = true;
      return 0;
    }

    for (const prediction of rows) {
      const row = document.createElement("tr");
      const values = [
        prediction.windowIndex,
        `${Number(prediction.startSeconds).toFixed(2)} s`,
        `${Number(prediction.endSeconds).toFixed(2)} s`
      ];
      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      const labelCell = document.createElement("td");
      const label = document.createElement("span");
      label.className = "prediction-label";
      label.textContent = prediction.predictedLabel;
      label.style.backgroundColor = getPredictionLabelColor(prediction.predictedLabel);
      labelCell.append(label);
      const confidenceCell = document.createElement("td");
      confidenceCell.textContent = `${(Number(prediction.confidence) * 100).toFixed(1)}%`;
      row.append(labelCell, confidenceCell);
      windowPredictionBody.append(row);
    }

    windowPredictionStatus.textContent =
      `${rows.length} overlapping ${Number(predictionResult.windowSeconds).toFixed(1)}-second windows, ` +
      `evaluated every ${Number(predictionResult.strideSeconds).toFixed(2)} seconds.`;
    windowPredictionSection.hidden = false;
    featureVisualizationPanel.hidden = false;
    return rows.length;
  }

  async function requestFigureGeneration(wavBlob, diagnostics, trackingArtifacts, timestamp) {
    if (!trackingArtifacts || !trackingArtifacts.osEventLog) {
      return null;
    }

    const formData = new FormData();
    formData.append("recording", wavBlob, `${recordingFilePrefix}_${timestamp}.wav`);
    formData.append(
      "events",
      new Blob([trackingArtifacts.osEventLog], { type: "text/plain" }),
      `os_event_log_${timestamp}.txt`
    );
    formData.append(
      "diagnostics",
      new Blob([JSON.stringify(diagnostics, null, 2)], { type: "application/json" }),
      `${recordingFilePrefix}_diagnostics_${timestamp}.json`
    );
    formData.append("timestamp", timestamp);
    formData.append("prefix", recordingFilePrefix);

    const response = await fetch(analysisApiUrl, {
      method: "POST",
      body: formData
    });
    if (!response.ok) {
      return null;
    }

    const result = await response.json();
    return result && result.ok ? result : null;
  }

  function toMonoFloat32(inputBuffer) {
    const channelCount = inputBuffer.numberOfChannels;
    const length = inputBuffer.length;
    const mono = new Float32Array(length);

    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const channelData = inputBuffer.getChannelData(channelIndex);
      for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
        mono[sampleIndex] += channelData[sampleIndex];
      }
    }

    if (channelCount > 1) {
      for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
        mono[sampleIndex] /= channelCount;
      }
    }

    return mono;
  }

  function setRealtimeStatus(message) {
    realtimeLastStatusMessage = message;
    if (realtimeStatus) {
      realtimeStatus.textContent = message;
    }
    queueRealtimeChartDraw();
  }

  function resetRealtimeChart() {
    realtimeFeaturePoints = [];
    realtimeWaveformPoints = [];
    realtimeEventMarkers = [];
    realtimeFrameSequence = 0;
    realtimeFramesSent = 0;
    realtimeFramesReceived = 0;
    realtimeFeaturesReceived = 0;
    realtimeFramesDroppedBeforeSend = 0;
    realtimeSessionStartEpoch = null;
    drawRealtimeChart();
  }

  function queueRealtimeChartDraw() {
    if (realtimeDrawPending) {
      return;
    }
    realtimeDrawPending = true;
    window.requestAnimationFrame(() => {
      realtimeDrawPending = false;
      drawRealtimeChart();
    });
  }

  function drawRealtimeChart() {
    if (!realtimeCanvas) {
      return;
    }
    const ctx = realtimeCanvas.getContext("2d");
    const width = realtimeCanvas.width;
    const height = realtimeCanvas.height;
    const margin = { top: 28, right: 18, bottom: 42, left: 74 };
    const gap = 32;
    const plotWidth = width - margin.left - margin.right;
    const panelHeight = Math.floor((height - margin.top - margin.bottom - gap * 2) / 3);
    const rawArea = {
      left: margin.left,
      top: margin.top,
      right: margin.left + plotWidth,
      bottom: margin.top + panelHeight,
      width: plotWidth,
      height: panelHeight
    };
    const ampArea = {
      left: margin.left,
      top: margin.top + panelHeight + gap,
      right: margin.left + plotWidth,
      bottom: margin.top + panelHeight + gap + panelHeight,
      width: plotWidth,
      height: panelHeight
    };
    const phaseArea = {
      left: margin.left,
      top: margin.top + (panelHeight + gap) * 2,
      right: margin.left + plotWidth,
      bottom: margin.top + (panelHeight + gap) * 2 + panelHeight,
      width: plotWidth,
      height: panelHeight
    };

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#fffdfa";
    ctx.fillRect(0, 0, width, height);

    const xMin = 0;
    const xMax = realtimeTimelineDurationSeconds;
    const visiblePoints = realtimeFeaturePoints.filter((point) => point.time >= xMin && point.time <= xMax);
    const visibleWaveformPoints = realtimeWaveformPoints.filter((point) => point.time >= xMin && point.time <= xMax);
    const visibleMarkers = realtimeEventMarkers.filter((marker) => marker.time >= xMin && marker.time <= xMax);

    function xToPx(timeValue) {
      return ampArea.left + ((timeValue - xMin) / Math.max(1e-6, xMax - xMin)) * ampArea.width;
    }

    function drawPanel(area, title, ylabel, color, points, valueKey, fixedMin, fixedMax) {
      let yMin = fixedMin;
      let yMax = fixedMax;
      if (yMin === null || yMax === null) {
        const values = points.map((point) => point[valueKey]).filter(Number.isFinite);
        if (values.length) {
          yMin = Math.min(...values);
          yMax = Math.max(...values);
          const pad = Math.max(0.25, (yMax - yMin) * 0.18);
          yMin -= pad;
          yMax += pad;
        } else {
          yMin = -1;
          yMax = 1;
        }
      }
      if (Math.abs(yMax - yMin) < 1e-9) {
        yMax += 1;
        yMin -= 1;
      }

      function yToPx(value) {
        return area.bottom - ((value - yMin) / (yMax - yMin)) * area.height;
      }

      ctx.save();
      ctx.strokeStyle = "rgba(31, 41, 51, 0.18)";
      ctx.fillStyle = "#1f2933";
      ctx.lineWidth = 1;
      ctx.font = "16px Arial, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(title, area.left, area.top - 6);

      ctx.fillStyle = "rgba(190, 45, 45, 0.16)";
      for (const region of realtimeStillRegions) {
        const left = xToPx(region.start);
        const right = xToPx(region.end);
        ctx.fillRect(left, area.top, right - left, area.height);
      }

      for (
        let seconds = xMin;
        seconds <= xMax + 1e-6;
        seconds += realtimeTimelineTickSeconds
      ) {
        const x = xToPx(seconds);
        const isPhaseBoundary = realtimeStillRegions.some(
          (region) => seconds === region.start || seconds === region.end
        ) && seconds > xMin && seconds < xMax;
        ctx.strokeStyle = isPhaseBoundary
          ? "rgba(150, 35, 35, 0.62)"
          : "rgba(31, 41, 51, 0.14)";
        ctx.lineWidth = isPhaseBoundary ? 1.5 : 1;
        ctx.setLineDash(isPhaseBoundary ? [] : [3, 4]);
        ctx.beginPath();
        ctx.moveTo(x, area.top);
        ctx.lineTo(x, area.bottom);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      if (area === rawArea) {
        ctx.fillStyle = "rgba(145, 25, 25, 0.9)";
        ctx.font = "bold 11px Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        for (const region of realtimeStillRegions) {
          ctx.fillText(region.label, xToPx((region.start + region.end) / 2), area.top + 5);
        }
      }

      ctx.strokeStyle = "rgba(31, 41, 51, 0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(area.left, area.top);
      ctx.lineTo(area.left, area.bottom);
      ctx.lineTo(area.right, area.bottom);
      ctx.stroke();

      ctx.font = "12px Arial, sans-serif";
      ctx.fillStyle = "rgba(31, 41, 51, 0.76)";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let tick = 0; tick <= 3; tick += 1) {
        const ratio = tick / 3;
        const value = yMin + ratio * (yMax - yMin);
        const y = area.bottom - ratio * area.height;
        ctx.strokeStyle = "rgba(31, 41, 51, 0.08)";
        ctx.beginPath();
        ctx.moveTo(area.left, y);
        ctx.lineTo(area.right, y);
        ctx.stroke();
        ctx.fillText(value.toFixed(valueKey === "amplitude_norm" ? 2 : 1), area.left - 8, y);
      }

      ctx.save();
      ctx.translate(18, area.top + area.height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(ylabel, 0, 0);
      ctx.restore();

      for (const marker of visibleMarkers) {
        const x = xToPx(marker.time);
        ctx.strokeStyle = marker.color;
        ctx.globalAlpha = 0.28;
        ctx.beginPath();
        ctx.moveTo(x, area.top);
        ctx.lineTo(x, area.bottom);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.save();
        ctx.translate(x + 2, area.top + 4);
        ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = marker.color;
        ctx.font = "11px Arial, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText(marker.label, 0, 0);
        ctx.restore();
      }

      if (points.length > 1) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.7;
        ctx.beginPath();
        points.forEach((point, index) => {
          const x = xToPx(point.time);
          const y = yToPx(point[valueKey]);
          if (index === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        });
        ctx.stroke();
      }

      ctx.restore();
    }

    drawPanel(rawArea, "Raw audio", "PCM", "#4f83cc", visibleWaveformPoints, "value", -1, 1);
    drawPanel(ampArea, "Amplitude", "normalized", "#ff9d42", visiblePoints, "amplitude_norm", 0, 1.1);
    drawPanel(phaseArea, "Phase", "rad", "#5dae70", visiblePoints, "phase", null, null);

    ctx.save();
    ctx.fillStyle = "rgba(31, 41, 51, 0.76)";
    ctx.font = "12px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (
      let seconds = xMin;
      seconds <= xMax + 1e-6;
      seconds += realtimeTimelineTickSeconds
    ) {
      ctx.fillText(`${seconds}s`, xToPx(seconds), phaseArea.bottom + 12);
    }
    ctx.font = "13px Arial, sans-serif";
    ctx.fillText("Recording time (s)", width / 2, height - 18);
    if (!visiblePoints.length && !visibleWaveformPoints.length) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "15px Arial, sans-serif";
      ctx.fillText(realtimeLastStatusMessage, width / 2, height / 2);
    }
    ctx.restore();
  }

  function appendRealtimeFeature(message) {
    realtimeFeaturesReceived += 1;
    const featureTimestamp = Number(message.timestamp);
    let featureTime = Number(message.time) || 0;
    if (Number.isFinite(featureTimestamp) && Number.isFinite(realtimeSessionStartEpoch)) {
      featureTime = featureTimestamp - realtimeSessionStartEpoch;
    }
    if (!Number.isFinite(featureTime) || featureTime < 0) {
      featureTime = Number(message.time) || 0;
    }
    realtimeFeaturePoints.push({
      time: featureTime,
      timestamp: Number.isFinite(featureTimestamp) ? featureTimestamp : null,
      timestamp_source: message.timestamp_source || "",
      window_start_time: Number.isFinite(message.window_start_time) ? message.window_start_time : null,
      window_end_time: Number.isFinite(message.window_end_time) ? message.window_end_time : null,
      amplitude_norm: Number.isFinite(message.amplitude_norm) ? message.amplitude_norm : 0,
      phase: Number.isFinite(message.phase) ? message.phase : 0,
      range_cm: Number.isFinite(message.range_cm) ? message.range_cm : 0
    });
    if (realtimeFeaturePoints.length > realtimeMaxPoints) {
      realtimeFeaturePoints.splice(0, realtimeFeaturePoints.length - realtimeMaxPoints);
    }
    queueRealtimeChartDraw();
  }

  function appendRealtimeWaveform(samples) {
    if (!realtimeStreamingActive || !Number.isFinite(realtimeSessionStartEpoch) || !samples || !samples.length) {
      return;
    }
    const context = getAudioContext();
    const sampleRate = context.sampleRate || targetSampleRate;
    const frameEndTime = Date.now() / 1000 - realtimeSessionStartEpoch;
    const frameStartTime = frameEndTime - samples.length / sampleRate;
    const stride = Math.max(1, Math.floor(sampleRate / realtimeWaveformPlotHz));
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += stride) {
      const time = frameStartTime + sampleIndex / sampleRate;
      if (Number.isFinite(time) && time >= 0) {
        realtimeWaveformPoints.push({
          time,
          value: Math.max(-1, Math.min(1, Number(samples[sampleIndex]) || 0))
        });
      }
    }
    if (realtimeWaveformPoints.length > realtimeMaxWaveformPoints) {
      realtimeWaveformPoints.splice(0, realtimeWaveformPoints.length - realtimeMaxWaveformPoints);
    }
    queueRealtimeChartDraw();
  }

  function getRealtimeMarkerColor(name) {
    return {
      keydown: "#d62728",
      pointer_move: "#1f77b4",
      scroll: "#17becf",
      click: "#9467bd"
    }[name] || "#9467bd";
  }

  function getRealtimeMarkerLabel(event) {
    const name = event.name || "";
    const props = event.properties || {};
    if (name === "keydown") {
      if (props.code && props.code.startsWith("Key") && props.code.length === 4) {
        return props.code.slice(3);
      }
      return props.key || "key";
    }
    if (name === "pointer_move") {
      return "move";
    }
    return name;
  }

  function recordRealtimeEventMarker(event) {
    if (!realtimeStreamingActive || !Number.isFinite(realtimeSessionStartEpoch) || !event) {
      return;
    }
    const eventTime = Number(event.epochSeconds) - realtimeSessionStartEpoch;
    if (!Number.isFinite(eventTime) || eventTime < 0) {
      return;
    }
    const correctedEventTime = eventTime + getLocalStorageNumber("webagentAudioEventOffsetMs", 80) / 1000;
    if (!Number.isFinite(correctedEventTime) || correctedEventTime < 0) {
      return;
    }
    const keepNames = new Set([
      "keydown",
      "pointer_move",
      "scroll",
      "click"
    ]);
    if (!keepNames.has(event.name)) {
      return;
    }
    realtimeEventMarkers.push({
      time: correctedEventTime,
      rawTime: eventTime,
      name: event.name,
      pointerType: event.properties && event.properties.pointerType ? event.properties.pointerType : "",
      x: event.properties && Number.isFinite(event.properties.x) ? event.properties.x : null,
      y: event.properties && Number.isFinite(event.properties.y) ? event.properties.y : null,
      dx: event.properties && Number.isFinite(event.properties.dx) ? event.properties.dx : null,
      dy: event.properties && Number.isFinite(event.properties.dy) ? event.properties.dy : null,
      label: getRealtimeMarkerLabel(event),
      color: getRealtimeMarkerColor(event.name)
    });
    if (realtimeEventMarkers.length > realtimeMaxMarkers) {
      realtimeEventMarkers.splice(0, realtimeEventMarkers.length - realtimeMaxMarkers);
    }
    queueRealtimeChartDraw();
  }

  function handleRealtimeMessage(rawData) {
    let message = null;
    try {
      message = JSON.parse(rawData);
    } catch (error) {
      return;
    }

    if (message.type === "feature") {
      appendRealtimeFeature(message);
      return;
    }
    if (message.type === "alignment") {
      setRealtimeStatus(`Live Python IQ aligned. Peak/base ${Number(message.peak_over_baseline || 0).toFixed(1)}x.`);
      return;
    }
    if (message.type === "status") {
      if (message.status === "connected") {
        setRealtimeStatus("Live backend connected. Waiting for sensing frames...");
      } else if (message.status === "started") {
        const resampleText = message.resampling
          ? ` Resampling ${message.sample_rate} Hz to ${message.processing_sample_rate} Hz.`
          : "";
        setRealtimeStatus(`Live Python IQ running.${resampleText}`);
      } else if (message.status === "frames") {
        realtimeFramesReceived = Number(message.frames_received) || realtimeFramesReceived;
        if (!realtimeFeaturesReceived) {
          const alignedText = message.aligned ? "aligned, waiting for feature points" : "waiting for chirp alignment";
          const processedText = Number.isFinite(message.frames_processed)
            ? ` processed ${message.frames_processed};`
            : "";
          const dropText = message.dropped_stale_frames
            ? ` dropped ${message.dropped_stale_frames} stale frames to stay live;`
            : "";
          const ageText = Number.isFinite(message.latest_frame_age_ms)
            ? ` latest age ${message.latest_frame_age_ms} ms;`
            : "";
          setRealtimeStatus(`Python received ${realtimeFramesReceived} audio frames;${processedText}${dropText}${ageText} ${alignedText}.`);
        }
      } else if (message.status === "stopped") {
        setRealtimeStatus(`Live Python IQ stopped after ${message.chirps_processed || 0} chirps.`);
      }
      return;
    }
    if (message.type === "warning" || message.type === "error") {
      setRealtimeStatus(`Live Python IQ: ${message.message || message.type}`);
    }
  }

  async function startRealtimeSession() {
    resetRealtimeChart();
    if (!realtimeCanvas || !("WebSocket" in window)) {
      setRealtimeStatus("Live Python IQ unavailable in this browser.");
      return false;
    }
    return await new Promise((resolve) => {
      let settled = false;
      const socket = new WebSocket(getRealtimeWebSocketUrl());
      socket.binaryType = "arraybuffer";
      const timeout = window.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          socket.close();
        } catch (error) {
          // Ignore close races.
        }
        setRealtimeStatus("Live Python IQ backend not connected. Run: python server.py");
        resolve(false);
      }, 1200);

      socket.addEventListener("open", () => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        realtimeSocket = socket;
        realtimeStreamingActive = true;
        realtimeSessionStartEpoch = Date.now() / 1000;
        socket.send(JSON.stringify({
          type: "start",
          timestamp: realtimeSessionStartEpoch,
          sample_rate: getAudioContext().sampleRate,
          frame_size: realtimeFrameSize,
          channel_count: 1,
          source: "browser_microphone",
          format: "float32"
        }));
        setRealtimeStatus("Live Python IQ connected. Aligning chirp...");
        resolve(true);
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          handleRealtimeMessage(event.data);
        }
      });

      socket.addEventListener("close", () => {
        if (realtimeSocket === socket) {
          realtimeSocket = null;
        }
        realtimeStreamingActive = false;
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          setRealtimeStatus("Live Python IQ backend not connected. Run: python server.py");
          resolve(false);
        }
      });

      socket.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          try {
            socket.close();
          } catch (error) {
            // Ignore close races.
          }
          setRealtimeStatus("Live Python IQ backend not connected. Run: python server.py");
          resolve(false);
        }
      });
    });
  }

  function sendRealtimeAudioFrame(samples) {
    if (!realtimeStreamingActive || !realtimeSocket || realtimeSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (realtimeSocket.bufferedAmount > realtimeMaxSocketBufferedBytes) {
      realtimeFramesDroppedBeforeSend += 1;
      if (!realtimeFeaturesReceived && realtimeFramesDroppedBeforeSend % 25 === 0) {
        setRealtimeStatus(`Dropped ${realtimeFramesDroppedBeforeSend} mic frames before send to keep live IQ current.`);
      }
      return;
    }
    realtimeFrameSequence += 1;
    realtimeFramesSent += 1;
    if (!realtimeFeaturesReceived && !realtimeFramesReceived && realtimeFramesSent % 25 === 0) {
      setRealtimeStatus(`Sent ${realtimeFramesSent} mic frames to Python; waiting for live IQ features.`);
    }
    try {
      const payload = new ArrayBuffer(realtimeAudioFrameHeaderBytes + samples.byteLength);
      const view = new DataView(payload);
      view.setUint8(0, 0x57);
      view.setUint8(1, 0x41);
      view.setUint8(2, 0x49);
      view.setUint8(3, 0x51);
      view.setFloat64(4, Date.now() / 1000, true);
      view.setUint32(12, realtimeFrameSequence, true);
      view.setUint32(16, samples.length, true);
      new Float32Array(payload, realtimeAudioFrameHeaderBytes).set(samples);
      realtimeSocket.send(payload);
    } catch (error) {
      setRealtimeStatus("Live Python IQ stream paused after a socket send error.");
    }
  }

  function stopRealtimeSession() {
    realtimeStreamingActive = false;
    if (!realtimeSocket) {
      return;
    }
    const socket = realtimeSocket;
    realtimeSocket = null;
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "stop" }));
      }
      socket.close();
    } catch (error) {
      // Ignore close races.
    }
  }

  function buildAudioBufferFromRecording(context) {
    if (!recordedFrameCount || !recordingChannelCount) {
      return null;
    }

    const audioBuffer = context.createBuffer(
      1,
      recordedFrameCount,
      context.sampleRate
    );
    const channelData = audioBuffer.getChannelData(0);
    let frameOffset = 0;

    for (const chunk of recordingBufferChunks) {
      channelData.set(chunk, frameOffset);
      frameOffset += chunk.length;
    }

    return audioBuffer;
  }

  function encodeAudioBufferToWav(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const frameCount = audioBuffer.length;
    const channelCount = 1;
    const bytesPerSample = 4;
    const blockAlign = channelCount * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = frameCount * blockAlign;
    const wavBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(wavBuffer);
    const channelData = toMonoChannel(audioBuffer);
    let offset = 0;

    function writeAscii(text) {
      for (let index = 0; index < text.length; index += 1) {
        view.setUint8(offset, text.charCodeAt(index));
        offset += 1;
      }
    }

    writeAscii("RIFF");
    view.setUint32(offset, 36 + dataSize, true);
    offset += 4;
    writeAscii("WAVE");
    writeAscii("fmt ");
    view.setUint32(offset, 16, true);
    offset += 4;
    view.setUint16(offset, 3, true);
    offset += 2;
    view.setUint16(offset, channelCount, true);
    offset += 2;
    view.setUint32(offset, sampleRate, true);
    offset += 4;
    view.setUint32(offset, byteRate, true);
    offset += 4;
    view.setUint16(offset, blockAlign, true);
    offset += 2;
    view.setUint16(offset, bytesPerSample * 8, true);
    offset += 2;
    writeAscii("data");
    view.setUint32(offset, dataSize, true);
    offset += 4;

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      view.setFloat32(offset, clampPcmSample(channelData[frameIndex]), true);
      offset += bytesPerSample;
    }

    return new Blob([wavBuffer], { type: "audio/wav" });
  }

  function showSpectrogramStatus(message) {
    spectrogramStatus.textContent = message;
    spectrogramPanel.hidden = false;
  }

  function clearSpectrogram() {
    const ctx = spectrogramCanvas.getContext("2d");
    ctx.clearRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
    spectrogramPanel.hidden = true;
    spectrogramStatus.textContent = "";
  }

  function toMonoChannel(audioBuffer) {
    const channelCount = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    if (channelCount === 1) {
      return audioBuffer.getChannelData(0);
    }

    const mono = new Float32Array(length);
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const channelData = audioBuffer.getChannelData(channelIndex);
      for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
        mono[sampleIndex] += channelData[sampleIndex];
      }
    }

    for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
      mono[sampleIndex] /= channelCount;
    }

    return mono;
  }

  function createHannWindow(size) {
    const windowValues = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
      windowValues[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1)));
    }
    return windowValues;
  }

  const SPECTROGRAM_CONFIG = Object.freeze({
    fftSize: 1024,
    hopLength: 256,
    maxColumns: 8192,
    canvasHeight: 394,
    minFrequency: 18000,
    maxFrequency: 24000,
    minDb: -90,
    maxDb: -20,
    margin: Object.freeze({ top: 71, right: 29, bottom: 60, left: 85 })
  });

  const SPECTROGRAM_COLOR_STOPS = Object.freeze([
    Object.freeze([0, 0, 40]),
    Object.freeze([24, 15, 61]),
    Object.freeze([68, 15, 118]),
    Object.freeze([106, 28, 129]),
    Object.freeze([147, 38, 103]),
    Object.freeze([188, 55, 84]),
    Object.freeze([222, 81, 72]),
    Object.freeze([248, 133, 92]),
    Object.freeze([252, 209, 128])
  ]);

  function createFftWorkspace(size) {
    return {
      real: new Float64Array(size),
      imaginary: new Float64Array(size),
      magnitudes: new Float32Array(size / 2)
    };
  }

  function computeFftMagnitudes(samples, start, windowValues, workspace) {
    const size = windowValues.length;
    const { real, imaginary, magnitudes } = workspace;

    for (let index = 0; index < size; index += 1) {
      real[index] = (samples[start + index] || 0) * windowValues[index];
      imaginary[index] = 0;
    }

    for (let index = 1, reversed = 0; index < size; index += 1) {
      let bit = size >> 1;
      while (reversed & bit) {
        reversed ^= bit;
        bit >>= 1;
      }
      reversed ^= bit;

      if (index < reversed) {
        const realValue = real[index];
        const imaginaryValue = imaginary[index];
        real[index] = real[reversed];
        imaginary[index] = imaginary[reversed];
        real[reversed] = realValue;
        imaginary[reversed] = imaginaryValue;
      }
    }

    for (let blockSize = 2; blockSize <= size; blockSize <<= 1) {
      const angle = (-2 * Math.PI) / blockSize;
      const blockCosine = Math.cos(angle);
      const blockSine = Math.sin(angle);
      const halfBlockSize = blockSize >> 1;

      for (let blockStart = 0; blockStart < size; blockStart += blockSize) {
        let twiddleReal = 1;
        let twiddleImaginary = 0;

        for (let offset = 0; offset < halfBlockSize; offset += 1) {
          const evenIndex = blockStart + offset;
          const oddIndex = evenIndex + halfBlockSize;
          const oddReal = real[oddIndex] * twiddleReal - imaginary[oddIndex] * twiddleImaginary;
          const oddImaginary = real[oddIndex] * twiddleImaginary + imaginary[oddIndex] * twiddleReal;
          const evenReal = real[evenIndex];
          const evenImaginary = imaginary[evenIndex];

          real[evenIndex] = evenReal + oddReal;
          imaginary[evenIndex] = evenImaginary + oddImaginary;
          real[oddIndex] = evenReal - oddReal;
          imaginary[oddIndex] = evenImaginary - oddImaginary;

          const nextTwiddleReal = twiddleReal * blockCosine - twiddleImaginary * blockSine;
          twiddleImaginary = twiddleReal * blockSine + twiddleImaginary * blockCosine;
          twiddleReal = nextTwiddleReal;
        }
      }
    }

    for (let bin = 0; bin < magnitudes.length; bin += 1) {
      magnitudes[bin] = Math.hypot(real[bin], imaginary[bin]) / size;
    }

    return magnitudes;
  }

  function getSpectrogramColor(value) {
    const clamped = Math.max(0, Math.min(1, value));
    const scaledPosition = clamped * (SPECTROGRAM_COLOR_STOPS.length - 1);
    const lowerIndex = Math.min(
      SPECTROGRAM_COLOR_STOPS.length - 2,
      Math.floor(scaledPosition)
    );
    const blend = scaledPosition - lowerIndex;
    const lowerColor = SPECTROGRAM_COLOR_STOPS[lowerIndex];
    const upperColor = SPECTROGRAM_COLOR_STOPS[lowerIndex + 1];
    return lowerColor.map((channel, index) => (
      Math.round(channel + blend * (upperColor[index] - channel))
    ));
  }

  function getSpectrogramTimeTickStep(duration) {
    if (duration <= 5) return 0.5;
    if (duration <= 10) return 1;
    if (duration <= 20) return 2;
    if (duration <= 60) return 5;
    if (duration <= 120) return 10;
    return 20;
  }

  function drawSpectrogramAxes(ctx, plotArea, audioBuffer, renderingConfig) {
    const duration = audioBuffer.duration;
    const {
      fftSize,
      hopLength,
      minFrequency,
      maxFrequency,
      minDb,
      maxDb
    } = renderingConfig;
    const canvasCenter = ctx.canvas.width / 2;
    const overlapPercent = Math.round((1 - hopLength / fftSize) * 100);
    const minFrequencyKhz = minFrequency / 1000;
    const maxFrequencyKhz = maxFrequency / 1000;
    const frequencyStepKhz = 1;
    const timeStep = getSpectrogramTimeTickStep(duration);

    ctx.save();
    ctx.strokeStyle = "#111827";
    ctx.fillStyle = "#111827";
    ctx.lineWidth = 1;

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "600 13px 'Segoe UI', sans-serif";
    ctx.fillText(
      `Received audio spectrogram (${minFrequencyKhz.toFixed(0)}-${maxFrequencyKhz.toFixed(0)} kHz)`,
      canvasCenter,
      9
    );
    ctx.font = "10px 'Segoe UI', sans-serif";
    ctx.fillText(
      `FFT ${fftSize} | effective hop ${hopLength} samples | overlap ${overlapPercent}% | color ${minDb} to ${maxDb} dB`,
      canvasCenter,
      29
    );

    ctx.strokeRect(plotArea.left, plotArea.top, plotArea.width, plotArea.height);

    ctx.font = "10px 'Segoe UI', sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (
      let frequencyKhz = Math.ceil(minFrequencyKhz);
      frequencyKhz <= maxFrequencyKhz + 1e-6;
      frequencyKhz += frequencyStepKhz
    ) {
      const ratio = (frequencyKhz - minFrequencyKhz) /
        Math.max(1e-9, maxFrequencyKhz - minFrequencyKhz);
      const y = plotArea.bottom - ratio * plotArea.height;
      ctx.beginPath();
      ctx.moveTo(plotArea.left - 5, y);
      ctx.lineTo(plotArea.left, y);
      ctx.stroke();
      ctx.fillText(frequencyKhz.toFixed(0), plotArea.left - 9, y);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let seconds = 0; seconds <= duration + 1e-6; seconds += timeStep) {
      const x = plotArea.left + (seconds / Math.max(duration, 1e-9)) * plotArea.width;
      ctx.beginPath();
      ctx.moveTo(x, plotArea.bottom);
      ctx.lineTo(x, plotArea.bottom + 5);
      ctx.stroke();
      ctx.fillText(
        seconds.toFixed(timeStep < 1 ? 1 : 0),
        x,
        plotArea.bottom + 8
      );
    }

    if (duration % timeStep > 1e-6) {
      ctx.beginPath();
      ctx.moveTo(plotArea.right, plotArea.bottom);
      ctx.lineTo(plotArea.right, plotArea.bottom + 5);
      ctx.stroke();
      ctx.fillText(duration.toFixed(duration < 10 ? 1 : 0), plotArea.right, plotArea.bottom + 8);
    }

    ctx.font = "11px 'Segoe UI', sans-serif";
    ctx.fillText("Time (s)", canvasCenter, ctx.canvas.height - 18);

    ctx.save();
    ctx.translate(18, plotArea.top + plotArea.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("Frequency (kHz)", 0, 0);
    ctx.restore();

    ctx.restore();
  }

  async function renderSpectrogram(recordedBlob) {
    showSpectrogramStatus("Generating spectrogram...");

    try {
      const arrayBuffer = await recordedBlob.arrayBuffer();
      const decodingContext = getAudioContext();
      const audioBuffer = await decodingContext.decodeAudioData(arrayBuffer.slice(0));
      const samples = toMonoChannel(audioBuffer);
      if (samples.length < 8) {
        throw new Error("Recording too short");
      }
      const margin = SPECTROGRAM_CONFIG.margin;
      const fftSize = SPECTROGRAM_CONFIG.fftSize;
      const requestedHopLength = SPECTROGRAM_CONFIG.hopLength;
      const availableStartSamples = Math.max(0, samples.length - fftSize);
      const requestedFrameCount = Math.max(1, Math.floor(availableStartSamples / requestedHopLength) + 1);
      const plotWidth = Math.min(requestedFrameCount, SPECTROGRAM_CONFIG.maxColumns);
      const hopLength = requestedFrameCount > SPECTROGRAM_CONFIG.maxColumns
        ? Math.max(1, Math.ceil(availableStartSamples / Math.max(1, plotWidth - 1)))
        : requestedHopLength;
      const canvasWidth = margin.left + plotWidth + margin.right;
      const canvasHeight = SPECTROGRAM_CONFIG.canvasHeight;
      const plotHeight = canvasHeight - margin.top - margin.bottom;
      spectrogramCanvas.width = canvasWidth;
      spectrogramCanvas.height = canvasHeight;
      const plotArea = {
        left: margin.left,
        top: margin.top,
        right: margin.left + plotWidth,
        bottom: margin.top + plotHeight,
        width: plotWidth,
        height: plotHeight
      };
      const nyquistBins = fftSize / 2;
      const minFrequency = Math.min(
        SPECTROGRAM_CONFIG.minFrequency,
        audioBuffer.sampleRate / 2
      );
      const maxFrequency = Math.max(
        minFrequency,
        Math.min(SPECTROGRAM_CONFIG.maxFrequency, audioBuffer.sampleRate / 2)
      );
      const minFrequencyBin = Math.min(
        nyquistBins - 1,
        Math.floor((minFrequency * fftSize) / audioBuffer.sampleRate)
      );
      const maxFrequencyBin = Math.min(
        nyquistBins - 1,
        Math.ceil((maxFrequency * fftSize) / audioBuffer.sampleRate)
      );
      const windowValues = createHannWindow(fftSize);
      const fftWorkspace = createFftWorkspace(fftSize);
      const ctx = spectrogramCanvas.getContext("2d");
      const imageData = ctx.createImageData(plotWidth, plotHeight);
      const pixelBuffer = imageData.data;

      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      for (let x = 0; x < plotWidth; x += 1) {
        const start = Math.max(0, Math.min(availableStartSamples, x * hopLength));
        const magnitudes = computeFftMagnitudes(samples, start, windowValues, fftWorkspace);

        for (let y = 0; y < plotHeight; y += 1) {
          const normalizedY = y / Math.max(1, plotHeight - 1);
          const frequencyBin = Math.min(
            maxFrequencyBin,
            Math.round(
              minFrequencyBin + normalizedY * (maxFrequencyBin - minFrequencyBin)
            )
          );

          const magnitude = magnitudes[frequencyBin];
          const db = 20 * Math.log10(magnitude + 1e-6);
          const normalizedMagnitude = Math.max(0, Math.min(
            1,
            (db - SPECTROGRAM_CONFIG.minDb) /
              (SPECTROGRAM_CONFIG.maxDb - SPECTROGRAM_CONFIG.minDb)
          ));
          const [red, green, blue] = getSpectrogramColor(normalizedMagnitude);
          const pixelIndex = ((plotHeight - 1 - y) * plotWidth + x) * 4;
          pixelBuffer[pixelIndex] = red;
          pixelBuffer[pixelIndex + 1] = green;
          pixelBuffer[pixelIndex + 2] = blue;
          pixelBuffer[pixelIndex + 3] = 255;
        }

        if (x > 0 && x % 256 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      ctx.putImageData(imageData, plotArea.left, plotArea.top);
      drawSpectrogramAxes(ctx, plotArea, audioBuffer, {
        fftSize,
        hopLength,
        minFrequency,
        maxFrequency,
        minDb: SPECTROGRAM_CONFIG.minDb,
        maxDb: SPECTROGRAM_CONFIG.maxDb
      });
      showSpectrogramStatus(
        `Spectrogram of the recorded audio (${(minFrequency / 1000).toFixed(0)}-${(maxFrequency / 1000).toFixed(0)} kHz). FFT ${fftSize}, hop ${hopLength} samples.`
      );
    } catch (error) {
      showSpectrogramStatus("Could not generate a spectrogram for the recording.");
    }
  }

  async function prepareRecordedAudio(recordedAudioBuffer, options = {}) {
    const sessionFiles = [
      ...((options.trackingArtifacts && options.trackingArtifacts.files) || [])
    ];
    if (!recordedAudioBuffer) {
      setPreparedSessionFiles(sessionFiles);
      setSensingStatus(sessionFiles.length
        ? "Sensing stopped without microphone audio. The tracking files are ready to download."
        : "Sensing stopped, but no microphone recording was captured.");
      resetRecordingBuffers();
      return sessionFiles;
    }

    try {
      const timestamp = options.timestamp || buildTimestamp();
      const chirpPeriodEstimate = estimateChirpPeriod(recordedAudioBuffer);
      const diagnostics = buildAudioDiagnostics(recordedAudioBuffer, chirpPeriodEstimate);
      const wavBlob = encodeAudioBufferToWav(recordedAudioBuffer);
      await renderSpectrogram(wavBlob);

      sessionFiles.push(
        { name: `${recordingFilePrefix}_${timestamp}.wav`, blob: wavBlob },
        {
          name: `${recordingFilePrefix}_spectrogram_${timestamp}.png`,
          url: spectrogramCanvas.toDataURL("image/png")
        },
        buildMetadataArtifact(recordedAudioBuffer, diagnostics, options.trackingArtifacts, timestamp)
      );
      setSensingStatus("Sensing stopped. Calculating post-processed signal features...");

      let figureFiles = [];
      try {
        const analysisResult = await requestFigureGeneration(
          wavBlob,
          diagnostics,
          options.trackingArtifacts,
          timestamp
        );
        renderGeneratedFigures(analysisResult);
        renderWindowPredictions(analysisResult);
        figureFiles = buildGeneratedFigureArtifacts(analysisResult);
      } catch (error) {
        figureFiles = [];
      }

      sessionFiles.push(...figureFiles);
      setPreparedSessionFiles(sessionFiles);

      if (figureFiles.length > 0) {
        setSensingStatus(`Sensing is stopped. ${sessionFiles.length} session files are ready, including ${figureFiles.length} processed feature figures. Choose Download session files to save them.`);
      } else {
        setSensingStatus(`Sensing is stopped. ${sessionFiles.length} session files are ready. Choose Download session files to save them. Exact Python figures require serving the app with webagent/server.py.`);
      }
    } catch (error) {
      setPreparedSessionFiles(sessionFiles);
      setSensingStatus(sessionFiles.length
        ? "Sensing stopped. The tracking files are ready, but the recording or spectrogram could not be prepared."
        : "Sensing stopped, but failed to prepare the recording or spectrogram.");
    } finally {
      resetRecordingBuffers();
    }

    return sessionFiles;
  }

  async function requestMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (micStatusNode) {
        micStatusNode.textContent = "Microphone is not supported in this browser.";
      }
      setSensingControls(false, false);
      return false;
    }

    try {
      microphoneRequestDetails = recordingProfiles.createMicrophoneRequest(
        activeRecordingProfileId,
        targetSampleRate
      );
      micStream = await navigator.mediaDevices.getUserMedia(microphoneRequestDetails.constraints);
      const track = getPrimaryAudioTrack();
      recordingProfiles.applyMicrophoneTrackHints(track);
      microphoneQualification = recordingProfiles.qualifyMicrophoneTrack(
        track,
        activeRecordingProfileId,
        microphoneRequestDetails.supportedConstraints
      );
      if (!microphoneQualification.supported) {
        const reason = microphoneQualification.errors.join(" ");
        micStream.getTracks().forEach((item) => item.stop());
        micStream = null;
        throw new Error(reason);
      }
      if (micStatusNode) {
        const profile = recordingProfiles.getProfile(activeRecordingProfileId);
        micStatusNode.textContent = microphoneQualification.warnings.length
          ? `Microphone is on with ${profile.label}; ${microphoneQualification.warnings.join(" ")}`
          : `Microphone is on with ${profile.label}.`;
      }
      setSensingControls(true, false);
      return true;
    } catch (error) {
      microphoneQualification = null;
      if (micStatusNode) {
        const detail = error && error.message ? ` ${error.message}` : "";
        micStatusNode.textContent = `Could not qualify the microphone.${detail}`;
      }
      setSensingControls(false, false);
      return false;
    }
  }

  async function startSensing() {
    if (!micStream || sensingActive || sensingStopInProgress) {
      return;
    }

    clearSensingDurationTimer();
    sensingDurationLimitReached = false;
    setSensingControls(true, true);
    setSensingStatus("Starting sensing...");

    try {
      const context = getAudioContext();
      if (context.state === "suspended") {
        await context.resume();
      }
      audioContextQualification = recordingProfiles.qualifyAudioContext(
        context,
        activeRecordingProfileId,
        targetSampleRate
      );
      if (!audioContextQualification.supported) {
        throw new Error(audioContextQualification.errors.join(" "));
      }
      const profile = recordingProfiles.getProfile(activeRecordingProfileId);

      const liveTracks = micStream.getAudioTracks().filter((track) => (
        track.readyState === "live" && track.enabled
      ));
      if (!liveTracks.length) {
        throw new Error("No live microphone track");
      }

      const microphoneOnlyStream = new MediaStream(liveTracks);
      const channelCount = 1;

      stopSensingCapture();
      resetRecordingBuffers();
      resetCaptureMetrics();
      clearSpectrogram();
      clearFeatureVisualizations();
      await loadChirpPlaybackBuffer();
      await startRealtimeSession();
      sensingSourceNode = context.createMediaStreamSource(microphoneOnlyStream);
      const workletAvailable = Boolean(context.audioWorklet && window.AudioWorkletNode);
      let workletStarted = false;

      if (workletAvailable) {
        try {
          if (!audioWorkletModuleReady) {
            await context.audioWorklet.addModule(audioWorkletUrl);
            audioWorkletModuleReady = true;
          }
          sensingWorkletNode = new AudioWorkletNode(context, "audio-frame-processor", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
              frameSize: realtimeFrameSize
            }
          });
          sensingWorkletNode.port.onmessage = (event) => {
            if (!event.data || event.data.type !== "audio-frame" || !event.data.samples) {
              return;
            }
            handleRecordedAudioChunk(event.data.samples, {
              sequence: event.data.sequence,
              startFrame: event.data.startFrame
            });
          };
          sensingMonitorNode = context.createGain();
          sensingMonitorNode.gain.value = 0;
          sensingSourceNode.connect(sensingWorkletNode);
          sensingWorkletNode.connect(sensingMonitorNode);
          sensingMonitorNode.connect(context.destination);
          recordingCaptureMethod = "AudioWorklet + transferable Float32Array";
          recordingCaptureFrameSize = realtimeFrameSize;
          workletStarted = true;
        } catch (error) {
          if (profile.requireAudioWorklet) {
            throw new Error(`AudioWorklet capture is required but could not start. ${error.message || ""}`.trim());
          }
          sensingSourceNode.disconnect();
          if (sensingWorkletNode) {
            sensingWorkletNode.disconnect();
            sensingWorkletNode = null;
          }
          if (sensingMonitorNode) {
            sensingMonitorNode.disconnect();
            sensingMonitorNode = null;
          }
        }
      }

      if (!workletStarted) {
        if (profile.requireAudioWorklet) {
          throw new Error("AudioWorklet capture is required by the Ultrasound profile but is unavailable.");
        }
        sensingProcessorNode = context.createScriptProcessor(realtimeFrameSize, channelCount, channelCount);
        sensingProcessorNode.onaudioprocess = (event) => {
          handleRecordedAudioChunk(toMonoFloat32(event.inputBuffer));
        };
        sensingMonitorNode = context.createGain();
        sensingMonitorNode.gain.value = 0;
        sensingSourceNode.connect(sensingProcessorNode);
        sensingProcessorNode.connect(sensingMonitorNode);
        sensingMonitorNode.connect(context.destination);
        recordingCaptureMethod = "ScriptProcessorNode compatibility fallback";
        recordingCaptureFrameSize = realtimeFrameSize;
      }

      sensingAudio.src = chirpAudioUrl;
      sensingAudio.loop = true;
      sensingAudio.currentTime = 0;
      startChirpPlayback();

      sensingActive = true;
      startSensingDurationTimer();
      window.interactionTracker.beginSession();
      setSensingControls(true, true);
      const contextWarning = audioContextQualification.warnings.join(" ");
      setSensingStatus(`Sensing is active with ${profile.label} using ${recordingCaptureMethod}. ${siteLabel} is being tracked. Recording stops automatically after ${maximumSensingDurationSeconds} seconds.${contextWarning ? ` ${contextWarning}` : ""}`);
    } catch (error) {
      clearSensingDurationTimer();
      sensingActive = false;
      window.interactionTracker.setEnabled(false);
      stopRealtimeSession();
      stopChirpPlayback();
      stopSensingCapture();
      resetRecordingBuffers();
      setSensingControls(Boolean(micStream), false);
      const detail = error && error.message ? ` ${error.message}` : "";
      setSensingStatus(`Could not start sensing.${detail}`);
    }
  }

  async function stopSensing({ prepareFiles = true, durationLimitReached = false } = {}) {
    if (sensingStopInProgress) {
      return;
    }
    clearSensingDurationTimer();
    if (!sensingActive && !recordedFrameCount) {
      return;
    }

    sensingStopInProgress = true;
    sensingDurationLimitReached = sensingDurationLimitReached || durationLimitReached;
    try {
      const timestamp = buildTimestamp();
      const shouldPrepareRecording = prepareFiles && recordedFrameCount > 0;
      const completedRecording = shouldPrepareRecording
        ? buildAudioBufferFromRecording(getAudioContext())
        : null;
      completedCaptureDiagnostics = recordedFrameCount > 0 ? getCaptureDiagnostics() : null;

      sensingActive = false;
      let trackingArtifacts = null;
      if (prepareFiles) {
        trackingArtifacts = window.interactionTracker.prepareTrackingData(timestamp);
      }
      window.interactionTracker.setEnabled(false);
      setSensingControls(Boolean(micStream), false);
      stopRealtimeSession();
      stopChirpPlayback();
      sensingAudio.currentTime = 0;
      stopSensingCapture();

      if (prepareFiles) {
        if (downloadSessionBtn) {
          downloadSessionBtn.disabled = true;
        }
        setSensingStatus(durationLimitReached
          ? `Maximum ${maximumSensingDurationSeconds}-second recording reached. Preparing session files...`
          : "Sensing stopped. Preparing session files...");
        await prepareRecordedAudio(completedRecording, { timestamp, trackingArtifacts });
      } else {
        resetRecordingBuffers();
        setSensingStatus(`Sensing is stopped. ${siteLabel} is not being tracked.`);
      }
    } finally {
      clearSensingDurationTimer();
      sensingStopInProgress = false;
    }
  }

  function getSelectedFilters(form) {
    return Array.from(form.querySelectorAll("input[name='filter']:checked"))
      .map((input) => input.value);
  }

  function applyFilters(form) {
    const queryInput = form.querySelector("[name='query']");
    const categoryInput = form.querySelector("[name='category']");
    const query = ((queryInput && queryInput.value) || "").trim().toLowerCase();
    const category = (categoryInput && categoryInput.value) || "All";
    const selectedFilters = getSelectedFilters(form);
    const products = Array.from(document.querySelectorAll("[data-product-row]"));
    let visibleCount = 0;

    products.forEach((product) => {
      const searchableText = [
        product.dataset.productName || "",
        product.textContent || ""
      ].join(" ").toLowerCase();
      const productTags = (product.dataset.tags || "").split(/\s+/).filter(Boolean);
      const matchesQuery = !query || searchableText.includes(query);
      const matchesCategory = category === "All" || product.dataset.category === category;
      const matchesFilters = selectedFilters.every((filter) => productTags.includes(filter));
      const isVisible = matchesQuery && matchesCategory && matchesFilters;

      product.hidden = !isVisible;
      if (isVisible) {
        visibleCount += 1;
      }
    });

    return visibleCount;
  }

  function getProductRow(button) {
    return button.closest("[data-product-row]");
  }

  function setTripDetailText(panel, selector, text) {
    const node = panel ? panel.querySelector(selector) : null;
    if (node) {
      node.textContent = text || "";
    }
  }

  function getOrCreateTripDetailPanel(productRow) {
    let panel = productRow.querySelector("[data-trip-detail-panel]");
    if (panel) {
      return panel;
    }

    panel = document.createElement("div");
    panel.className = "travel-details-panel";
    panel.dataset.tripDetailPanel = "";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="travel-details-header">
        <div>
          <h4 data-trip-detail-name>Trip details</h4>
          <p data-trip-detail-summary>Select a trip to review details.</p>
        </div>
        <span class="price" data-trip-detail-price></span>
      </div>
      <dl class="travel-details-list">
        <div>
          <dt>Duration</dt>
          <dd data-trip-detail-duration></dd>
        </div>
        <div>
          <dt>Route</dt>
          <dd data-trip-detail-route></dd>
        </div>
        <div>
          <dt>Included</dt>
          <dd data-trip-detail-included></dd>
        </div>
        <div>
          <dt>Note</dt>
          <dd data-trip-detail-note></dd>
        </div>
      </dl>
      <div class="actions">
        <button class="primary-button" type="button" data-use-trip>Use this trip</button>
        <button class="secondary-button" type="button" data-close-trip-details>Close details</button>
      </div>
    `;
    panel.querySelector("[data-use-trip]").addEventListener("click", useSelectedTrip);
    panel.querySelector("[data-close-trip-details]").addEventListener("click", () => {
      closeTripDetails(panel);
    });
    productRow.appendChild(panel);
    return panel;
  }

  function hideOtherTripDetails(activePanel) {
    document.querySelectorAll("[data-trip-detail-panel]").forEach((panel) => {
      if (panel === activePanel) {
        return;
      }
      panel.hidden = true;
      const detailsButton = panel.closest("[data-product-row]")?.querySelector("[data-quick-view]");
      if (detailsButton) {
        detailsButton.setAttribute("aria-expanded", "false");
      }
    });
  }

  function showTripDetails(button) {
    const productRow = getProductRow(button);
    const productName = button.dataset.product || (productRow && productRow.dataset.productName) || "Trip";
    if (!document.body.classList.contains("travel-site") || !productRow) {
      setActivity(`Quick view opened for ${productName}.`);
      return;
    }

    const tripDetailPanel = getOrCreateTripDetailPanel(productRow);
    const priceNode = productRow.querySelector(".price");
    const summaryNode = productRow.querySelector("p:not(.product-labels)");
    const priceText = priceNode ? priceNode.textContent.trim() : "";
    const summaryText = summaryNode ? summaryNode.textContent.trim() : "";
    selectedDetailTrip = {
      name: productName,
      price: Number(productRow.querySelector("[data-add-cart]")?.dataset.price || "0"),
      duration: productRow.dataset.duration || "",
      route: productRow.dataset.route || "",
      included: productRow.dataset.included || "",
      note: productRow.dataset.note || "",
      panel: tripDetailPanel
    };

    hideOtherTripDetails(tripDetailPanel);
    setTripDetailText(tripDetailPanel, "[data-trip-detail-name]", productName);
    setTripDetailText(tripDetailPanel, "[data-trip-detail-summary]", summaryText);
    setTripDetailText(tripDetailPanel, "[data-trip-detail-price]", priceText);
    setTripDetailText(tripDetailPanel, "[data-trip-detail-duration]", selectedDetailTrip.duration);
    setTripDetailText(tripDetailPanel, "[data-trip-detail-route]", selectedDetailTrip.route);
    setTripDetailText(tripDetailPanel, "[data-trip-detail-included]", selectedDetailTrip.included);
    setTripDetailText(tripDetailPanel, "[data-trip-detail-note]", selectedDetailTrip.note);
    tripDetailPanel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    tripDetailPanel.scrollIntoView({ block: "nearest" });
    setActivity(`Details opened for ${productName}.`);
  }

  function useSelectedTrip() {
    if (!selectedDetailTrip) {
      return;
    }

    updateCart(selectedDetailTrip.price);
    const notesField = document.querySelector("textarea[name='notes']");
    if (notesField && !notesField.value.trim()) {
      notesField.value = `Interested in ${selectedDetailTrip.name}. ${selectedDetailTrip.duration}. ${selectedDetailTrip.route}.`;
    }
    setActivity(`${selectedDetailTrip.name} added to booking from details.`);
  }

  function closeTripDetails(panel = null) {
    const targetPanel = panel || selectedDetailTrip?.panel;
    if (targetPanel) {
      targetPanel.hidden = true;
      const detailsButton = targetPanel.closest("[data-product-row]")?.querySelector("[data-quick-view]");
      if (detailsButton) {
        detailsButton.setAttribute("aria-expanded", "false");
      }
    }
    setActivity("Trip details closed.");
  }

  document.querySelectorAll("[data-add-cart]").forEach((button) => {
    button.addEventListener("click", () => {
      const price = Number(button.dataset.price || "0");
      updateCart(price);
      setActivity(`${button.dataset.product || "Item"} added to cart.`);
    });
  });

  document.querySelectorAll("[data-toggle-favorite]").forEach((button) => {
    button.addEventListener("click", () => {
      const active = button.getAttribute("aria-pressed") === "true";
      button.setAttribute("aria-pressed", String(!active));
      button.textContent = active ? "Save" : "Saved";
      setActivity(active ? "Item removed from saved list." : "Item saved for later.");
    });
  });

  document.querySelectorAll("[data-quick-view]").forEach((button) => {
    button.addEventListener("click", () => {
      showTripDetails(button);
    });
  });

  document.querySelectorAll("form").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const statusNode = document.querySelector(`[data-form-status="${form.id}"]`);
      const message = form.dataset.successMessage || "Updated.";

      if (form.id === "shopping-search" || form.dataset.filterForm === "true") {
        const visibleCount = applyFilters(form);
        const resultText = `${visibleCount} ${resultLabel} match the current filters.`;
        if (statusNode) {
          statusNode.textContent = resultText;
        }
        setActivity(resultText);
        return;
      }

      if (statusNode) {
        statusNode.textContent = message;
      }
      setActivity(message);
    });
  });

  if (startSensingBtn) {
    startSensingBtn.addEventListener("click", () => {
      if (sensingActive) {
        void stopSensing();
      } else {
        void startSensing();
      }
    });
  }

  if (stopSensingBtn) {
    stopSensingBtn.addEventListener("click", () => {
      void stopSensing();
    });
  }

  if (downloadSessionBtn) {
    downloadSessionBtn.addEventListener("click", () => {
      downloadPreparedSessionFiles();
    });
  }

  window.addEventListener("webagent:track-event", (event) => {
    recordRealtimeEventMarker(event.detail);
  });

  window.experimentSensing = {
    isPlaybackActive: () => Boolean(chirpSourceNode),
    getRecordingChannelCount: () => recordingChannelCount,
    getRecordedFrameCount: () => recordedFrameCount,
    getTargetSampleRate: () => targetSampleRate,
    getMaximumSensingDurationSeconds: () => maximumSensingDurationSeconds,
    isDurationLimitTimerActive: () => sensingDurationTimerId !== null,
    getRecordingProfile: () => recordingProfiles.getProfile(activeRecordingProfileId),
    getMicrophoneQualification: () => microphoneQualification,
    getCaptureDiagnostics: () => completedCaptureDiagnostics || getCaptureDiagnostics(),
    getPreparedSessionFileNames: () => preparedSessionFiles.map((file) => file.name),
    getRealtimePointCount: () => realtimeFeaturePoints.length,
    renderGeneratedFigures,
    renderWindowPredictions,
    clearFeatureVisualizations,
    getRealtimeDebugState: () => ({
      connected: Boolean(realtimeSocket),
      streaming: realtimeStreamingActive,
      framesSent: realtimeFramesSent,
      framesReceived: realtimeFramesReceived,
      featuresReceived: realtimeFeaturesReceived,
      framesDroppedBeforeSend: realtimeFramesDroppedBeforeSend,
      recordedFrameCount,
      points: realtimeFeaturePoints.length,
      waveformPoints: realtimeWaveformPoints.length,
      status: realtimeLastStatusMessage,
      realtimeWebSocketUrl: getRealtimeWebSocketUrl(),
      latestFeature: realtimeFeaturePoints.length ? realtimeFeaturePoints[realtimeFeaturePoints.length - 1] : null,
      latestWaveform: realtimeWaveformPoints.length ? realtimeWaveformPoints[realtimeWaveformPoints.length - 1] : null,
      markers: realtimeEventMarkers.slice(-8)
    })
  };

  window.addEventListener("pagehide", () => {
    clearSensingDurationTimer();
    void stopSensing({ prepareFiles: false });
    stopRealtimeSession();
    stopChirpPlayback();
    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
    }
  });

  initializeRecordingProfileControl();
  setSensingControls(false, false);
  drawRealtimeChart();
  void requestMicrophone();
});
