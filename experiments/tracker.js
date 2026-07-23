(() => {
  const trackingConfig = {
    maxCompatibilityEvents: 10000
  };
  const trackedEventNames = new Set(["keydown", "pointer_move", "scroll", "click"]);
  const eventLog = [];
  const keyboardEvents = [];
  const cursorEvents = [];
  const keyDownTimes = new Map();
  const sessionId = createTrackingId();
  let startedAt = null;
  let startedEpochSeconds = null;
  let startedPerformanceMs = null;
  let lastKeyDownTime = null;
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

  function getTrackedKeyName(event) {
    const key = typeof event.key === "string" && event.key.length
      ? event.key
      : "Unidentified";
    if (key.length === 1 && key !== " ") {
      return key;
    }

    const codeAliases = {
      AltLeft: "Key.alt",
      AltRight: "Key.alt_r",
      ControlLeft: "Key.ctrl",
      ControlRight: "Key.ctrl_r",
      MetaLeft: "Key.cmd",
      MetaRight: "Key.cmd_r",
      ShiftLeft: "Key.shift",
      ShiftRight: "Key.shift_r"
    };
    if (codeAliases[event.code]) {
      return codeAliases[event.code];
    }

    const keyAliases = {
      " ": "Key.space",
      ArrowDown: "Key.down",
      ArrowLeft: "Key.left",
      ArrowRight: "Key.right",
      ArrowUp: "Key.up",
      Backspace: "Key.backspace",
      CapsLock: "Key.caps_lock",
      Delete: "Key.delete",
      End: "Key.end",
      Enter: "Key.enter",
      Escape: "Key.esc",
      Home: "Key.home",
      Insert: "Key.insert",
      PageDown: "Key.page_down",
      PageUp: "Key.page_up",
      Tab: "Key.tab"
    };
    if (keyAliases[key]) {
      return keyAliases[key];
    }
    return `Key.${key.toLowerCase().replace(/\s+/g, "_")}`;
  }

  function getRelativeTrackingTime(event) {
    if (!Number.isFinite(startedPerformanceMs)) {
      return 0;
    }
    const eventTime = event && Number.isFinite(event.timeStamp)
      ? event.timeStamp
      : performance.now();
    return Math.max(0, (eventTime - startedPerformanceMs) / 1000);
  }

  function getPythonButtonName(button) {
    return {
      0: "Button.left",
      1: "Button.middle",
      2: "Button.right",
      3: "Button.x1",
      4: "Button.x2"
    }[button] || `Button.${button}`;
  }

  function getScreenPoint(event) {
    return {
      x: Number.isFinite(event.screenX) ? event.screenX : event.clientX,
      y: Number.isFinite(event.screenY) ? event.screenY : event.clientY
    };
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

    if (eventLog.length >= trackingConfig.maxCompatibilityEvents) {
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

  function trackPointerMove(event) {
    if (!interactionTrackingEnabled) {
      return;
    }
    const point = getScreenPoint(event);
    const t = getRelativeTrackingTime(event);
    cursorEvents.push({ type: "move", x: point.x, y: point.y, t });
    trackEvent("pointer_move", {
      pointerType: event.pointerType || "mouse",
      x: point.x,
      y: point.y,
      target: getElementDescriptor(event.target)
    });
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
      startedPerformanceMs = startedPerformanceMs ?? performance.now();
    }
  }

  function beginTrackingSession() {
    eventLog.length = 0;
    keyboardEvents.length = 0;
    cursorEvents.length = 0;
    keyDownTimes.clear();
    lastKeyDownTime = null;
    const startDate = new Date();
    startedAt = startDate.toISOString();
    startedEpochSeconds = startDate.getTime() / 1000;
    startedPerformanceMs = performance.now();
    setInteractionTrackingEnabled(true);
  }

  function prepareTrackingData(timestampSlug = buildDownloadTimestamp()) {
    const downloadedAt = new Date();
    const payload = {
      keyboardEvents: keyboardEvents.slice(),
      cursorEvents: cursorEvents.slice()
    };
    const downloadedEpochSeconds = downloadedAt.getTime() / 1000;
    const osEventLog = buildOsLevelEventLog(eventLog.slice(), downloadedEpochSeconds);
    return {
      payload,
      keyboardEvents: payload.keyboardEvents,
      cursorEvents: payload.cursorEvents,
      osEventLog,
      timestampSlug,
      downloadedEpochSeconds,
      files: [
        {
          name: "keyboard_events.json",
          blob: new Blob([JSON.stringify(payload.keyboardEvents, null, 2)], { type: "application/json" })
        },
        {
          name: "cursor_events.json",
          blob: new Blob([JSON.stringify(payload.cursorEvents, null, 2)], { type: "application/json" })
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

    const trackPointerButton = (event, pressed) => {
      if (!interactionTrackingEnabled) {
        return;
      }
      const point = getScreenPoint(event);
      const t = getRelativeTrackingTime(event);
      const button = getPythonButtonName(event.button);
      cursorEvents.push({
        type: "click",
        x: point.x,
        y: point.y,
        button,
        pressed,
        t
      });
      trackEvent("click", {
        x: point.x,
        y: point.y,
        button,
        pressed,
        pointerType: event.pointerType || "mouse",
        target: getElementDescriptor(event.target)
      });
    };
    document.addEventListener("pointerdown", (event) => {
      trackPointerButton(event, true);
    }, true);
    document.addEventListener("pointerup", (event) => {
      trackPointerButton(event, false);
    }, true);

    document.addEventListener("wheel", (event) => {
      if (!interactionTrackingEnabled) {
        return;
      }
      const point = getScreenPoint(event);
      const t = getRelativeTrackingTime(event);
      const dx = -event.deltaX;
      const dy = -event.deltaY;
      cursorEvents.push({ type: "scroll", x: point.x, y: point.y, dx, dy, t });
      trackEvent("scroll", {
        x: point.x,
        y: point.y,
        dx,
        dy,
        target: getElementDescriptor(event.target)
      });
    }, { passive: true, capture: true });

    document.addEventListener("keydown", (event) => {
      if (!interactionTrackingEnabled) {
        return;
      }
      const key = getTrackedKeyName(event);
      const identity = event.code || key;
      if (event.repeat || keyDownTimes.has(identity)) {
        return;
      }
      const t = getRelativeTrackingTime(event);
      keyboardEvents.push({
        event: "down",
        key,
        t,
        flight_sec: lastKeyDownTime === null ? null : t - lastKeyDownTime
      });
      keyDownTimes.set(identity, t);
      lastKeyDownTime = t;
      trackEvent("keydown", {
        key,
        code: event.code || "",
        target: getElementDescriptor(event.target)
      });
    }, true);

    document.addEventListener("keyup", (event) => {
      if (!interactionTrackingEnabled) {
        return;
      }
      const key = getTrackedKeyName(event);
      const identity = event.code || key;
      const t = getRelativeTrackingTime(event);
      const downTime = keyDownTimes.has(identity) ? keyDownTimes.get(identity) : null;
      keyDownTimes.delete(identity);
      keyboardEvents.push({
        event: "up",
        key,
        t,
        dwell_sec: downTime === null ? null : t - downTime
      });
    }, true);
  }

  window.interactionTracker = {
    trackEvent,
    prepareTrackingData,
    downloadTrackingData,
    getEvents: () => eventLog.slice(),
    getKeyboardEvents: () => keyboardEvents.slice(),
    getCursorEvents: () => cursorEvents.slice(),
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
