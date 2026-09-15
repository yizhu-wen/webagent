(function initializeRecordingProfiles(global) {
  "use strict";

  const targetSampleRate = 48000;
  const requiredProcessingFeatures = [
    "echoCancellation",
    "noiseSuppression",
    "autoGainControl"
  ];

  const profiles = Object.freeze({
    ultrasonic: Object.freeze({
      id: "ultrasonic",
      label: "Ultrasound (strict)",
      description: "Requires browser speech processing to be confirmed off, a 48 kHz AudioContext, and AudioWorklet PCM capture.",
      requireProcessingControls: true,
      requireConfirmedDisabledProcessing: true,
      requireAudioWorklet: true,
      requireTargetContextSampleRate: true,
      latencyHint: "interactive"
    }),
    compatible: Object.freeze({
      id: "compatible",
      label: "Compatibility",
      description: "Requests speech processing off and prefers AudioWorklet, but permits unconfirmed settings and the ScriptProcessor fallback.",
      requireProcessingControls: false,
      requireConfirmedDisabledProcessing: false,
      requireAudioWorklet: false,
      requireTargetContextSampleRate: false,
      latencyHint: "interactive"
    })
  });

  function normalizeProfileId(profileId) {
    return Object.prototype.hasOwnProperty.call(profiles, profileId)
      ? profileId
      : "ultrasonic";
  }

  function getProfile(profileId) {
    return profiles[normalizeProfileId(profileId)];
  }

  function getSupportedConstraints() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getSupportedConstraints !== "function") {
      return {};
    }
    return navigator.mediaDevices.getSupportedConstraints() || {};
  }

  function createMicrophoneRequest(profileId, sampleRate = targetSampleRate) {
    const profile = getProfile(profileId);
    const supportedConstraints = getSupportedConstraints();
    const unsupportedRequiredFeatures = requiredProcessingFeatures.filter(
      (feature) => !supportedConstraints[feature]
    );

    if (profile.requireProcessingControls && unsupportedRequiredFeatures.length) {
      const error = new Error(
        `This browser cannot control required microphone processing: ${unsupportedRequiredFeatures.join(", ")}. Choose the Compatibility profile to continue with a warning.`
      );
      error.code = "processing-controls-unavailable";
      error.features = unsupportedRequiredFeatures;
      throw error;
    }

    const audio = {};
    for (const feature of requiredProcessingFeatures) {
      if (supportedConstraints[feature]) {
        audio[feature] = profile.requireProcessingControls ? { exact: false } : false;
      }
    }

    if (supportedConstraints.voiceIsolation) {
      audio.voiceIsolation = profile.requireProcessingControls ? { exact: false } : false;
    }
    if (supportedConstraints.channelCount) {
      audio.channelCount = { ideal: 1 };
    }
    if (supportedConstraints.sampleRate) {
      audio.sampleRate = { ideal: sampleRate };
    }
    if (supportedConstraints.sampleSize) {
      audio.sampleSize = { ideal: 32 };
    }
    if (supportedConstraints.latency) {
      audio.latency = { ideal: 0.01 };
    }

    return {
      profile,
      supportedConstraints,
      unsupportedRequiredFeatures,
      constraints: {
        audio,
        video: false
      }
    };
  }

  function callTrackMethod(track, methodName) {
    if (!track || typeof track[methodName] !== "function") {
      return null;
    }
    try {
      return track[methodName]();
    } catch (error) {
      return { error: error.message };
    }
  }

  function qualifyMicrophoneTrack(track, profileId, supportedConstraints = getSupportedConstraints()) {
    const profile = getProfile(profileId);
    const settings = callTrackMethod(track, "getSettings") || {};
    const errors = [];
    const warnings = [];
    const featuresToConfirm = requiredProcessingFeatures.filter(
      (feature) => supportedConstraints[feature]
    );

    if (supportedConstraints.voiceIsolation) {
      featuresToConfirm.push("voiceIsolation");
    }

    const notConfirmedOff = featuresToConfirm.filter(
      (feature) => settings[feature] !== false
    );
    const unsupportedControls = requiredProcessingFeatures.filter(
      (feature) => !supportedConstraints[feature]
    );

    if (profile.requireProcessingControls && unsupportedControls.length) {
      errors.push(`Browser controls are unavailable for: ${unsupportedControls.join(", ")}.`);
    } else if (unsupportedControls.length) {
      warnings.push(`Browser controls are unavailable for: ${unsupportedControls.join(", ")}.`);
    }

    if (profile.requireConfirmedDisabledProcessing && notConfirmedOff.length) {
      errors.push(`Microphone processing was not confirmed off: ${notConfirmedOff.join(", ")}.`);
    } else if (notConfirmedOff.length) {
      warnings.push(`Microphone processing was not confirmed off: ${notConfirmedOff.join(", ")}.`);
    }

    return {
      supported: errors.length === 0,
      profileId: profile.id,
      processingDisabled: unsupportedControls.length === 0 && notConfirmedOff.length === 0,
      unsupportedControls,
      notConfirmedOff,
      errors,
      warnings,
      contentHint: track && "contentHint" in track ? track.contentHint : null,
      settings,
      capabilities: callTrackMethod(track, "getCapabilities"),
      constraints: callTrackMethod(track, "getConstraints")
    };
  }

  function applyMicrophoneTrackHints(track) {
    if (track && "contentHint" in track) {
      try {
        track.contentHint = "music";
      } catch (error) {
        // The explicit capture constraints remain the primary control.
      }
    }
  }

  function qualifyAudioContext(context, profileId, sampleRate = targetSampleRate) {
    const profile = getProfile(profileId);
    const actualSampleRate = context ? context.sampleRate : null;
    const errors = [];
    const warnings = [];

    if (actualSampleRate !== sampleRate) {
      const message = `The AudioContext is ${actualSampleRate || "unknown"} Hz; sensing is designed for ${sampleRate} Hz.`;
      if (profile.requireTargetContextSampleRate) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
    }

    return {
      supported: errors.length === 0,
      targetSampleRate: sampleRate,
      actualSampleRate,
      errors,
      warnings
    };
  }

  global.webAgentRecordingProfiles = Object.freeze({
    targetSampleRate,
    requiredProcessingFeatures: requiredProcessingFeatures.slice(),
    list: () => Object.values(profiles),
    normalizeProfileId,
    getProfile,
    createMicrophoneRequest,
    applyMicrophoneTrackHints,
    qualifyMicrophoneTrack,
    qualifyAudioContext
  });
})(window);
