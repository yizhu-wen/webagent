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
  const sensingAudio = document.querySelector("[data-sensing-audio]") || document.getElementById("shoppingSensingAudio");
  const spectrogramPanel = document.querySelector("[data-spectrogram-panel]") || document.getElementById("shoppingSpectrogramPanel");
  const spectrogramStatus = document.querySelector("[data-spectrogram-status]") || document.getElementById("shoppingSpectrogramStatus");
  const spectrogramCanvas = document.querySelector("[data-spectrogram-canvas]") || document.getElementById("shoppingSpectrogramCanvas");
  const chirpAudioFileName = "triangle_fmcw_20-23kHz_20ms_48kHz_600s.wav";
  const chirpAudioUrl = resolveChirpAudioUrl();
  const siteLabel = document.body.dataset.siteLabel || "Shopping behavior";
  const resultLabel = document.body.dataset.resultLabel || "products";
  const recordingFilePrefix = document.body.dataset.recordingPrefix || "shopping_recording";
  const analysisApiUrl = "/api/analyze-recording";
  const targetSampleRate = 48000;
  let micStream = null;
  let audioContext = null;
  let chirpPlaybackBuffer = null;
  let chirpSourceNode = null;
  let sensingSourceNode = null;
  let sensingProcessorNode = null;
  let recordingBufferChunks = [];
  let recordingChannelCount = 0;
  let recordedFrameCount = 0;
  let sensingActive = false;
  let selectedDetailTrip = null;

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
      startSensingBtn.disabled = !micReady || active;
    }
    if (stopSensingBtn) {
      stopSensingBtn.disabled = !active;
    }
  }

  function getMicrophoneConstraints() {
    return {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: targetSampleRate },
        sampleSize: { ideal: 32 }
      },
      video: false
    };
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
      audioContext = new AudioContextCtor({ sampleRate: targetSampleRate });
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
    chirpSourceNode.start(0);
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

  function clampPcmSample(sample) {
    return Math.max(-1, Math.min(1, sample));
  }

  function estimateChirpPeriod(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const expectedPeriodSamples = Math.round(0.020 * sampleRate);
    const samples = toMonoChannel(audioBuffer);
    const analysisLength = Math.min(samples.length, Math.round(sampleRate * 1.5));

    if (analysisLength < expectedPeriodSamples * 4) {
      return {
        status: "insufficient_audio",
        expectedPeriodSamples,
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
      expectedPeriodMs: 20,
      normalizedCorrelation: bestScore,
      analyzedSamples: analysisLength,
      sampleRate,
      rms
    };
  }

  function buildAudioDiagnostics(recordedAudioBuffer, chirpPeriodEstimate) {
    const track = getPrimaryAudioTrack();
    const context = getAudioContext();
    return {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      browser: {
        userAgent: navigator.userAgent,
        platform: navigator.platform
      },
      requestedMicrophoneConstraints: getMicrophoneConstraints().audio,
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
      audioContext: {
        sampleRate: context.sampleRate,
        state: context.state,
        baseLatency: Number.isFinite(context.baseLatency) ? context.baseLatency : null,
        outputLatency: Number.isFinite(context.outputLatency) ? context.outputLatency : null
      },
      playback: {
        engine: "Web Audio AudioBufferSourceNode",
        chirpFileName: chirpAudioFileName,
        chirpBufferSampleRate: chirpPlaybackBuffer ? chirpPlaybackBuffer.sampleRate : null,
        chirpBufferLength: chirpPlaybackBuffer ? chirpPlaybackBuffer.length : null,
        chirpBufferDuration: chirpPlaybackBuffer ? chirpPlaybackBuffer.duration : null,
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
      signalCheck: {
        method: "normalized_autocorrelation_near_20ms_chirp_period",
        chirpPeriodEstimate
      },
      limitations: [
        "Browser APIs report the stream visible to JavaScript, not every conversion inside the OS mixer or hardware driver.",
        "If device hardware runs at a different native rate, the browser or OS may resample before JavaScript receives audio.",
        "The chirp-period signal check is empirical evidence from the exported recording, not direct access to hardware clocks."
      ]
    };
  }

  function downloadAudioDiagnostics(diagnostics, timestamp) {
    const diagnosticsUrl = URL.createObjectURL(new Blob([JSON.stringify(diagnostics, null, 2)], {
      type: "application/json"
    }));
    triggerDownload(diagnosticsUrl, `${recordingFilePrefix}_diagnostics_${timestamp}.json`);
    window.setTimeout(() => URL.revokeObjectURL(diagnosticsUrl), 1000);
  }

  function downloadGeneratedFigures(result) {
    if (!result || !Array.isArray(result.figures)) {
      return 0;
    }

    for (const figure of result.figures) {
      if (!figure || !figure.url || !figure.name) {
        continue;
      }
      triggerDownload(figure.url, figure.name);
    }

    return result.figures.length;
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

  function getSpectrogramColor(value) {
    const clamped = Math.max(0, Math.min(1, value));
    const red = Math.round(255 * Math.pow(clamped, 0.72));
    const green = Math.round(255 * Math.pow(clamped, 1.55));
    const blue = Math.round(40 + 180 * (1 - clamped) * Math.pow(clamped, 0.35));
    return [red, green, blue];
  }

  function drawSpectrogramAxes(ctx, plotArea, audioBuffer) {
    const duration = audioBuffer.duration;
    const sampleRate = audioBuffer.sampleRate;
    const maxFrequency = sampleRate / 2;
    const frequencyTicks = 5;
    const timeTicks = Math.max(2, Math.min(6, Math.round(duration)));

    ctx.save();
    ctx.strokeStyle = "rgba(255, 248, 240, 0.28)";
    ctx.fillStyle = "rgba(255, 248, 240, 0.92)";
    ctx.lineWidth = 1;
    ctx.font = "12px 'Segoe UI', sans-serif";

    ctx.beginPath();
    ctx.moveTo(plotArea.left, plotArea.top);
    ctx.lineTo(plotArea.left, plotArea.bottom);
    ctx.lineTo(plotArea.right, plotArea.bottom);
    ctx.stroke();

    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let index = 0; index < frequencyTicks; index += 1) {
      const ratio = index / (frequencyTicks - 1);
      const y = plotArea.bottom - ratio * plotArea.height;
      const frequency = (ratio * maxFrequency) / 1000;
      ctx.beginPath();
      ctx.moveTo(plotArea.left - 6, y);
      ctx.lineTo(plotArea.left, y);
      ctx.stroke();
      ctx.fillText(`${frequency.toFixed(frequency >= 10 ? 0 : 1)} kHz`, plotArea.left - 10, y);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let index = 0; index <= timeTicks; index += 1) {
      const ratio = index / timeTicks;
      const x = plotArea.left + ratio * plotArea.width;
      const seconds = ratio * duration;
      ctx.beginPath();
      ctx.moveTo(x, plotArea.bottom);
      ctx.lineTo(x, plotArea.bottom + 6);
      ctx.stroke();
      ctx.fillText(`${seconds.toFixed(duration >= 10 ? 0 : 1)} s`, x, plotArea.bottom + 10);
    }

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
      const canvasWidth = spectrogramCanvas.width;
      const canvasHeight = spectrogramCanvas.height;
      const margin = { top: 16, right: 14, bottom: 54, left: 70 };
      const plotWidth = canvasWidth - margin.left - margin.right;
      const plotHeight = canvasHeight - margin.top - margin.bottom;
      const plotArea = {
        left: margin.left,
        top: margin.top,
        right: margin.left + plotWidth,
        bottom: margin.top + plotHeight,
        width: plotWidth,
        height: plotHeight
      };
      const fftSize = 512;
      const nyquistBins = fftSize / 2;
      const hopSize = Math.max(1, Math.floor(Math.max(1, samples.length - fftSize) / plotWidth));
      const windowValues = createHannWindow(fftSize);
      const ctx = spectrogramCanvas.getContext("2d");
      const imageData = ctx.createImageData(plotWidth, plotHeight);
      const pixelBuffer = imageData.data;

      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      ctx.fillStyle = "#0c0820";
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      for (let x = 0; x < plotWidth; x += 1) {
        const start = Math.max(0, Math.min(samples.length - fftSize, x * hopSize));

        for (let y = 0; y < plotHeight; y += 1) {
          const normalizedY = y / Math.max(1, plotHeight - 1);
          const frequencyBin = Math.min(
            nyquistBins - 1,
            Math.floor(Math.pow(normalizedY, 1.85) * (nyquistBins - 1))
          );

          let real = 0;
          let imaginary = 0;
          for (let n = 0; n < fftSize; n += 1) {
            const sample = samples[start + n] * windowValues[n];
            const angle = (2 * Math.PI * frequencyBin * n) / fftSize;
            real += sample * Math.cos(angle);
            imaginary -= sample * Math.sin(angle);
          }

          const magnitude = Math.sqrt(real * real + imaginary * imaginary) / fftSize;
          const db = 20 * Math.log10(magnitude + 1e-6);
          const normalizedMagnitude = Math.max(0, Math.min(1, (db + 90) / 70));
          const [red, green, blue] = getSpectrogramColor(normalizedMagnitude);
          const pixelIndex = ((plotHeight - 1 - y) * plotWidth + x) * 4;
          pixelBuffer[pixelIndex] = red;
          pixelBuffer[pixelIndex + 1] = green;
          pixelBuffer[pixelIndex + 2] = blue;
          pixelBuffer[pixelIndex + 3] = 255;
        }
      }

      ctx.putImageData(imageData, plotArea.left, plotArea.top);
      drawSpectrogramAxes(ctx, plotArea, audioBuffer);
      showSpectrogramStatus("Spectrogram of the recorded audio.");
    } catch (error) {
      showSpectrogramStatus("Could not generate a spectrogram for the recording.");
    }
  }

  async function downloadRecordedAudio(recordedAudioBuffer, options = {}) {
    if (!recordedAudioBuffer) {
      setSensingStatus("Sensing stopped, but no microphone recording was captured.");
      resetRecordingBuffers();
      return;
    }

    try {
      const timestamp = options.timestamp || buildTimestamp();
      const chirpPeriodEstimate = estimateChirpPeriod(recordedAudioBuffer);
      const diagnostics = buildAudioDiagnostics(recordedAudioBuffer, chirpPeriodEstimate);
      const wavBlob = encodeAudioBufferToWav(recordedAudioBuffer);
      await renderSpectrogram(wavBlob);

      const downloadUrl = URL.createObjectURL(wavBlob);
      triggerDownload(downloadUrl, `${recordingFilePrefix}_${timestamp}.wav`);
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);

      triggerDownload(
        spectrogramCanvas.toDataURL("image/png"),
        `${recordingFilePrefix}_spectrogram_${timestamp}.png`
      );
      downloadAudioDiagnostics(diagnostics, timestamp);
      setSensingStatus("Sensing stopped. Running Python IQ pipeline for input-event amplitude/phase figure...");

      let figureCount = 0;
      try {
        const analysisResult = await requestFigureGeneration(
          wavBlob,
          diagnostics,
          options.trackingArtifacts,
          timestamp
        );
        figureCount = downloadGeneratedFigures(analysisResult);
      } catch (error) {
        figureCount = 0;
      }

      if (figureCount > 0) {
        setSensingStatus(`Sensing is stopped. Recording, spectrogram, diagnostics, tracking data, and ${figureCount} Python IQ input-event figure downloaded.`);
      } else {
        setSensingStatus("Sensing is stopped. Recording, spectrogram, diagnostics, and tracking data downloaded. Exact Python figures require serving the app with webagent/server.py.");
      }
    } catch (error) {
      setSensingStatus("Sensing stopped, but failed to download the recording or spectrogram.");
    } finally {
      resetRecordingBuffers();
    }
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
      micStream = await navigator.mediaDevices.getUserMedia(getMicrophoneConstraints());
      if (micStatusNode) {
        micStatusNode.textContent = "Microphone is on.";
      }
      setSensingControls(true, false);
      return true;
    } catch (error) {
      if (micStatusNode) {
        micStatusNode.textContent = "Could not turn on microphone. Please allow microphone permission.";
      }
      setSensingControls(false, false);
      return false;
    }
  }

  async function startSensing() {
    if (!micStream || sensingActive) {
      return;
    }

    setSensingControls(true, true);
    setSensingStatus("Starting sensing...");

    try {
      const context = getAudioContext();
      if (context.state === "suspended") {
        await context.resume();
      }

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
      clearSpectrogram();
      await loadChirpPlaybackBuffer();
      sensingSourceNode = context.createMediaStreamSource(microphoneOnlyStream);
      sensingProcessorNode = context.createScriptProcessor(4096, channelCount, channelCount);
      sensingProcessorNode.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer;

        if (!recordingChannelCount) {
          recordingChannelCount = 1;
        }

        const chunk = toMonoFloat32(inputBuffer);
        recordingBufferChunks.push(chunk);
        recordedFrameCount += chunk.length;
      };
      sensingSourceNode.connect(sensingProcessorNode);
      sensingProcessorNode.connect(context.destination);

      sensingAudio.src = chirpAudioUrl;
      sensingAudio.loop = true;
      sensingAudio.currentTime = 0;
      startChirpPlayback();

      sensingActive = true;
      window.interactionTracker.beginSession();
      setSensingControls(true, true);
      setSensingStatus(`Sensing is active. ${siteLabel} is being tracked.`);
    } catch (error) {
      sensingActive = false;
      window.interactionTracker.setEnabled(false);
      stopChirpPlayback();
      stopSensingCapture();
      resetRecordingBuffers();
      setSensingControls(Boolean(micStream), false);
      setSensingStatus("Could not start sensing.");
    }
  }

  async function stopSensing({ download = true } = {}) {
    if (!sensingActive && !recordedFrameCount) {
      return;
    }

    const timestamp = buildTimestamp();
    const shouldDownloadRecording = download && recordedFrameCount > 0;
    const completedRecording = shouldDownloadRecording
      ? buildAudioBufferFromRecording(getAudioContext())
      : null;

    sensingActive = false;
    let trackingArtifacts = null;
    if (download) {
      trackingArtifacts = window.interactionTracker.downloadTrackingData(timestamp);
    }
    window.interactionTracker.setEnabled(false);
    setSensingControls(Boolean(micStream), false);
    stopChirpPlayback();
    sensingAudio.currentTime = 0;
    stopSensingCapture();

    if (download) {
      setSensingStatus("Sensing stopped. Preparing recording and spectrogram downloads...");
      await downloadRecordedAudio(completedRecording, { timestamp, trackingArtifacts });
    } else {
      resetRecordingBuffers();
      setSensingStatus(`Sensing is stopped. ${siteLabel} is not being tracked.`);
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
      void startSensing();
    });
  }

  if (stopSensingBtn) {
    stopSensingBtn.addEventListener("click", () => {
      void stopSensing();
    });
  }

  window.experimentSensing = {
    isPlaybackActive: () => Boolean(chirpSourceNode),
    getRecordingChannelCount: () => recordingChannelCount,
    getTargetSampleRate: () => targetSampleRate
  };

  window.addEventListener("pagehide", () => {
    void stopSensing({ download: false });
    stopChirpPlayback();
    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
    }
  });

  setSensingControls(false, false);
  void requestMicrophone();
});
