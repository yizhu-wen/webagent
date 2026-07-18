(() => {
  const trackingConfig = {
    maxEvents: 10000,
    pointerMoveThrottleMs: 120,
    scrollThrottleMs: 120
  };
  const trackedEventNames = new Set(["keydown", "pointer_move", "scroll", "click"]);
  const eventLog = [];
  const sessionId = createTrackingId();
  let startedAt = null;
  let startedEpochSeconds = null;
  let lastPointerMoveTrackAt = 0;
  let lastPointerMovePoint = null;
  let lastScrollTrackAt = 0;
  let lastScrollPoint = null;
  let interactionTrackingEnabled = false;

  function createTrackingId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `event_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function getTrackingTarget(element) {
    if (!(element instanceof Element)) {
      return null;
    }

    return element.closest("button, a, input, select, textarea, label, form, [data-track-label]") || element;
  }

  function getElementDescriptor(element) {
    const target = getTrackingTarget(element);
    if (!target) {
      return null;
    }

    const descriptor = {
      tag: target.tagName.toLowerCase()
    };

    if (target.id) {
      descriptor.id = target.id;
    }
    if (target.classList.length) {
      descriptor.classes = Array.from(target.classList).slice(0, 5);
    }
    if (target.getAttribute("name")) {
      descriptor.name = target.getAttribute("name");
    }
    if (target.getAttribute("type")) {
      descriptor.type = target.getAttribute("type");
    }
    if (target.getAttribute("role")) {
      descriptor.role = target.getAttribute("role");
    }
    if (target.getAttribute("aria-label")) {
      descriptor.ariaLabel = target.getAttribute("aria-label");
    }
    if (target.dataset.trackLabel) {
      descriptor.label = target.dataset.trackLabel.slice(0, 80);
    } else if (target.matches("button, a, label, input[type='button'], input[type='submit']")) {
      const visibleLabel = (target.innerText || target.value || "").trim();
      if (visibleLabel) {
        descriptor.label = visibleLabel.slice(0, 80);
      }
    }

    return descriptor;
  }

  function getSafeKey(event) {
    if (typeof event.key !== "string" || event.key.length === 0) {
      return "Unidentified";
    }
    return event.key.length === 1 ? "character" : event.key;
  }

  function sanitizePipeValue(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .replace(/\|/g, "/")
      .trim()
      .slice(0, 500);
  }

  function describeTargetForPipe(target) {
    if (!target) {
      return "";
    }

    const parts = [target.tag || "element"];
    if (target.id) {
      parts.push(`#${target.id}`);
    }
    if (target.name) {
      parts.push(`name=${target.name}`);
    }
    if (target.type) {
      parts.push(`type=${target.type}`);
    }
    if (target.label) {
      parts.push(`label=${target.label}`);
    }
    return sanitizePipeValue(parts.join(" "));
  }

  function getEpochSeconds(event) {
    if (Number.isFinite(event.epochSeconds)) {
      return event.epochSeconds;
    }

    const parsed = Date.parse(event.timestamp || "");
    return Number.isFinite(parsed) ? parsed / 1000 : Date.now() / 1000;
  }

  function getOsEventTag(event) {
    return event.name.toUpperCase();
  }

  function getOsEventValue(event) {
    const props = event.properties || {};
    return sanitizePipeValue([
      props.key ? `key=${props.key}` : "",
      props.code ? `code=${props.code}` : "",
      Number.isFinite(props.location) ? `location=${props.location}` : "",
      props.repeat ? "repeat=true" : "",
      props.altKey ? "altKey=true" : "",
      props.ctrlKey ? "ctrlKey=true" : "",
      props.metaKey ? "metaKey=true" : "",
      props.shiftKey ? "shiftKey=true" : "",
      props.pointerType ? `pointerType=${props.pointerType}` : "",
      Number.isFinite(props.button) ? `button=${props.button}` : "",
      Number.isFinite(props.buttons) ? `buttons=${props.buttons}` : "",
      Number.isFinite(props.pressure) ? `pressure=${props.pressure.toFixed(3)}` : "",
      Number.isFinite(props.x) ? `x=${props.x}` : "",
      Number.isFinite(props.y) ? `y=${props.y}` : "",
      Number.isFinite(props.pageX) ? `pageX=${props.pageX}` : "",
      Number.isFinite(props.pageY) ? `pageY=${props.pageY}` : "",
      Number.isFinite(props.dx) ? `dx=${props.dx}` : "",
      Number.isFinite(props.dy) ? `dy=${props.dy}` : "",
      Number.isFinite(props.movementX) ? `movementX=${props.movementX.toFixed(1)}` : "",
      Number.isFinite(props.movementY) ? `movementY=${props.movementY.toFixed(1)}` : "",
      Number.isFinite(props.deltaX) ? `deltaX=${props.deltaX.toFixed(1)}` : "",
      Number.isFinite(props.deltaY) ? `deltaY=${props.deltaY.toFixed(1)}` : "",
      Number.isFinite(props.scrollX) ? `scrollX=${props.scrollX.toFixed(1)}` : "",
      Number.isFinite(props.scrollY) ? `scrollY=${props.scrollY.toFixed(1)}` : "",
      describeTargetForPipe(props.target)
    ].filter(Boolean).join(" "));
  }

  function getPageInfo() {
    return {
      path: window.location.pathname,
      title: document.title,
      visibilityState: document.visibilityState
    };
  }

  function getViewportInfo() {
    return {
      width: window.innerWidth,
      height: window.innerHeight
    };
  }

  function buildDownloadTimestamp() {
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

  function buildOsLevelEventLog(events, downloadedEpochSeconds) {
    const startEpoch = Number.isFinite(startedEpochSeconds)
      ? startedEpochSeconds
      : getEpochSeconds(events[0] || {});

    const lines = [
      `# start_epoch | ${startEpoch.toFixed(6)}`,
      `# downloaded_epoch | ${downloadedEpochSeconds.toFixed(6)}`,
      `# session_id | ${sessionId}`,
      "# schema | webagent_os_events_v1",
      "# format | EVENT | VALUE | EPOCH_SECONDS",
      "# scope | browser_page_events_not_global_os_hooks"
    ];

    for (const event of events) {
      lines.push(`${getOsEventTag(event)} | ${getOsEventValue(event)} | ${getEpochSeconds(event).toFixed(6)}`);
    }

    return `${lines.join("\n")}\n`;
  }

  function downloadPreparedArtifacts(files) {
    for (const file of Array.isArray(files) ? files : []) {
      if (!file || !file.name || !file.blob) {
        continue;
      }
      const downloadUrl = URL.createObjectURL(file.blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    }
  }

  function trackEvent(name, properties = {}) {
    if (!interactionTrackingEnabled || !trackedEventNames.has(name)) {
      return;
    }

    if (eventLog.length >= trackingConfig.maxEvents) {
      eventLog.shift();
    }

    const eventDate = new Date();
    const trackedEvent = {
      id: createTrackingId(),
      sessionId,
      name,
      timestamp: eventDate.toISOString(),
      epochSeconds: eventDate.getTime() / 1000,
      page: getPageInfo(),
      viewport: getViewportInfo(),
      properties
    };
    eventLog.push(trackedEvent);
    window.dispatchEvent(new CustomEvent("webagent:track-event", {
      detail: trackedEvent
    }));
  }

  function getPointerMoveProperties(event) {
    const movementX = Number.isFinite(event.movementX) ? event.movementX : 0;
    const movementY = Number.isFinite(event.movementY) ? event.movementY : 0;
    const dx = lastPointerMovePoint ? event.clientX - lastPointerMovePoint.x : movementX;
    const dy = lastPointerMovePoint ? event.clientY - lastPointerMovePoint.y : movementY;
    return {
      pointerId: event.pointerId,
      pointerType: event.pointerType || "mouse",
      isPrimary: event.isPrimary,
      buttons: event.buttons,
      pressure: Number.isFinite(event.pressure) ? event.pressure : 0,
      x: event.clientX,
      y: event.clientY,
      pageX: event.pageX,
      pageY: event.pageY,
      dx,
      dy,
      movementX,
      movementY,
      target: getElementDescriptor(event.target)
    };
  }

  function trackPointerMove(event) {
    if (!interactionTrackingEnabled) {
      return;
    }

    const now = performance.now();
    if (now - lastPointerMoveTrackAt < trackingConfig.pointerMoveThrottleMs) {
      return;
    }

    const properties = getPointerMoveProperties(event);
    if (
      lastPointerMovePoint &&
      properties.dx === 0 &&
      properties.dy === 0 &&
      properties.movementX === 0 &&
      properties.movementY === 0
    ) {
      return;
    }

    lastPointerMoveTrackAt = now;
    lastPointerMovePoint = {
      x: event.clientX,
      y: event.clientY,
      pageX: event.pageX,
      pageY: event.pageY,
      time: now
    };
    trackEvent("pointer_move", properties);
  }

  function setInteractionTrackingEnabled(enabled) {
    if (interactionTrackingEnabled === enabled) {
      return;
    }

    interactionTrackingEnabled = enabled;
    if (enabled) {
      const startDate = new Date();
      startedAt = startedAt || startDate.toISOString();
      startedEpochSeconds = startedEpochSeconds ?? startDate.getTime() / 1000;
    }
  }

  function beginTrackingSession() {
    eventLog.length = 0;
    const startDate = new Date();
    startedAt = startDate.toISOString();
    startedEpochSeconds = startDate.getTime() / 1000;
    lastPointerMoveTrackAt = 0;
    lastPointerMovePoint = null;
    lastScrollTrackAt = 0;
    lastScrollPoint = null;
    setInteractionTrackingEnabled(true);
  }

  function buildTrackingFileName(timestampSlug) {
    const slug = document.body.dataset.siteSlug || "experiment";
    return `tracking_data_${slug}_${timestampSlug}.json`;
  }

  function prepareTrackingData(timestampSlug = buildDownloadTimestamp()) {
    const events = eventLog.slice();
    const downloadedAt = new Date();
    const payload = {
      schemaVersion: 1,
      sessionId,
      startedAt,
      startEpochSeconds: startedEpochSeconds,
      downloadedAt: downloadedAt.toISOString(),
      downloadedEpochSeconds: downloadedAt.getTime() / 1000,
      eventCount: events.length,
      trackingConfig: { ...trackingConfig },
      page: getPageInfo(),
      events
    };
    const downloadedEpochSeconds = downloadedAt.getTime() / 1000;
    const osEventLog = buildOsLevelEventLog(events, downloadedEpochSeconds);
    return {
      payload,
      osEventLog,
      timestampSlug,
      downloadedEpochSeconds,
      files: [
        {
          name: buildTrackingFileName(timestampSlug),
          blob: new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
        },
        {
          name: `os_event_log_${timestampSlug}.txt`,
          blob: new Blob([osEventLog], { type: "text/plain" })
        }
      ]
    };
  }

  function downloadTrackingData(timestampSlug = buildDownloadTimestamp()) {
    const artifacts = prepareTrackingData(timestampSlug);
    downloadPreparedArtifacts(artifacts.files);
    return artifacts;
  }

  function setupInteractionTracking() {
    document.addEventListener("pointermove", (event) => {
      trackPointerMove(event);
    }, { passive: true, capture: true });

    document.addEventListener("click", (event) => {
      trackEvent("click", {
        x: event.clientX,
        y: event.clientY,
        pageX: event.pageX,
        pageY: event.pageY,
        button: event.button,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        target: getElementDescriptor(event.target)
      });
    }, true);

    window.addEventListener("scroll", (event) => {
      if (!interactionTrackingEnabled) {
        return;
      }
      const now = performance.now();
      if (now - lastScrollTrackAt < trackingConfig.scrollThrottleMs) {
        return;
      }
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      trackEvent("scroll", {
        scrollX,
        scrollY,
        deltaX: lastScrollPoint ? scrollX - lastScrollPoint.x : 0,
        deltaY: lastScrollPoint ? scrollY - lastScrollPoint.y : 0,
        target: getElementDescriptor(event.target)
      });
      lastScrollTrackAt = now;
      lastScrollPoint = { x: scrollX, y: scrollY };
    }, { passive: true });

    document.addEventListener("keydown", (event) => {
      trackEvent("keydown", {
        key: getSafeKey(event),
        code: event.code || "",
        location: event.location,
        repeat: event.repeat,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        target: getElementDescriptor(event.target)
      });
    }, true);

  }

  window.interactionTracker = {
    trackEvent,
    prepareTrackingData,
    downloadTrackingData,
    getEvents: () => eventLog.slice(),
    getSessionId: () => sessionId,
    createTrackingId,
    isEnabled: () => interactionTrackingEnabled,
    setEnabled: setInteractionTrackingEnabled,
    beginSession: beginTrackingSession
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupInteractionTracking);
  } else {
    setupInteractionTracking();
  }
})();
