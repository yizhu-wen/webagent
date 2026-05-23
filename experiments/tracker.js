(() => {
  const trackingConfig = {
    maxEvents: 10000,
    pointerMoveThrottleMs: 120,
    doubleTapWindowMs: 320,
    doublePressWindowMs: 900,
    tapMaxDurationMs: 300,
    tapMaxDistancePx: 10,
    pressMinDurationMs: 300,
    longPressMinDurationMs: 650,
    dragMinDistancePx: 8,
    swipeMinDistancePx: 40,
    swipeMaxDurationMs: 700,
    pinchMinScaleDelta: 0.04
  };
  const eventLog = [];
  const sessionId = createTrackingId();
  let startedAt = null;
  let startedEpochSeconds = null;
  const activePointers = new Map();
  let lastTap = null;
  let lastPress = null;
  let pendingClickGesture = null;
  let pinchSession = null;
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

  function getFormFields(form) {
    return Array.from(form.elements)
      .filter((element) => element.name)
      .map((element) => ({
        name: element.name,
        tag: element.tagName.toLowerCase(),
        type: element.type || ""
      }));
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
      props.gesture ? `gesture=${props.gesture}` : "",
      props.key ? `key=${props.key}` : "",
      props.code ? `code=${props.code}` : "",
      Number.isFinite(props.location) ? `location=${props.location}` : "",
      props.repeat ? "repeat=true" : "",
      props.altKey ? "altKey=true" : "",
      props.ctrlKey ? "ctrlKey=true" : "",
      props.metaKey ? "metaKey=true" : "",
      props.shiftKey ? "shiftKey=true" : "",
      props.pointerType ? `pointerType=${props.pointerType}` : "",
      Number.isFinite(props.pointerCount) ? `pointerCount=${props.pointerCount}` : "",
      Number.isFinite(props.button) ? `button=${props.button}` : "",
      Number.isFinite(props.buttons) ? `buttons=${props.buttons}` : "",
      Number.isFinite(props.pressure) ? `pressure=${props.pressure.toFixed(3)}` : "",
      Number.isFinite(props.x) ? `x=${props.x}` : "",
      Number.isFinite(props.y) ? `y=${props.y}` : "",
      Number.isFinite(props.pageX) ? `pageX=${props.pageX}` : "",
      Number.isFinite(props.pageY) ? `pageY=${props.pageY}` : "",
      Number.isFinite(props.dx) ? `dx=${props.dx}` : "",
      Number.isFinite(props.dy) ? `dy=${props.dy}` : "",
      Number.isFinite(props.deltaX) ? `deltaX=${props.deltaX.toFixed(1)}` : "",
      Number.isFinite(props.deltaY) ? `deltaY=${props.deltaY.toFixed(1)}` : "",
      Number.isFinite(props.deltaZ) ? `deltaZ=${props.deltaZ.toFixed(1)}` : "",
      Number.isFinite(props.deltaMode) ? `deltaMode=${props.deltaMode}` : "",
      Number.isFinite(props.distance) ? `distance=${props.distance.toFixed(1)}` : "",
      Number.isFinite(props.durationMs) ? `durationMs=${props.durationMs.toFixed(1)}` : "",
      Number.isFinite(props.scale) ? `scale=${props.scale.toFixed(3)}` : "",
      props.direction ? `direction=${props.direction}` : "",
      props.value !== undefined ? `value=${props.value}` : "",
      props.method ? `method=${props.method}` : "",
      props.actionPath ? `actionPath=${props.actionPath}` : "",
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

  function downloadOsLevelEventLog(events, downloadedEpochSeconds, timestampSlug) {
    const osEventLog = buildOsLevelEventLog(events, downloadedEpochSeconds);
    const downloadUrl = URL.createObjectURL(new Blob([osEventLog], {
      type: "text/plain"
    }));
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `os_event_log_${timestampSlug}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    return osEventLog;
  }

  function trackEvent(name, properties = {}, options = {}) {
    if (!interactionTrackingEnabled && !options.force) {
      return;
    }

    if (eventLog.length >= trackingConfig.maxEvents) {
      eventLog.shift();
    }

    const eventDate = new Date();
    eventLog.push({
      id: createTrackingId(),
      sessionId,
      name,
      timestamp: eventDate.toISOString(),
      epochSeconds: eventDate.getTime() / 1000,
      page: getPageInfo(),
      viewport: getViewportInfo(),
      properties
    });
  }

  function getPointProperties(event) {
    return {
      pointerId: event.pointerId,
      pointerType: event.pointerType || "unknown",
      isPrimary: event.isPrimary,
      button: event.button,
      buttons: event.buttons,
      pressure: Number.isFinite(event.pressure) ? event.pressure : 0,
      x: event.clientX,
      y: event.clientY,
      pageX: event.pageX,
      pageY: event.pageY,
      target: getElementDescriptor(event.target)
    };
  }

  function getDirection(dx, dy) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? "right" : "left";
    }
    return dy >= 0 ? "down" : "up";
  }

  function getPointerDistance(a, b) {
    return Math.hypot(a.lastX - b.lastX, a.lastY - b.lastY);
  }

  function getPointerCenter(a, b) {
    return {
      x: (a.lastX + b.lastX) / 2,
      y: (a.lastY + b.lastY) / 2,
      pageX: (a.lastPageX + b.lastPageX) / 2,
      pageY: (a.lastPageY + b.lastPageY) / 2
    };
  }

  function getPointerPair() {
    const pointers = Array.from(activePointers.values());
    return pointers.length === 2 ? pointers : null;
  }

  function updatePinchTracking() {
    const pair = getPointerPair();
    if (!pair) {
      return;
    }

    const [a, b] = pair;
    const distance = getPointerDistance(a, b);
    const center = getPointerCenter(a, b);

    if (!pinchSession) {
      pinchSession = {
        startDistance: distance,
        startCenter: center,
        lastCenter: center,
        lastScale: 1,
        startTime: performance.now(),
        target: a.target || b.target
      };
      trackEvent("pinch_start", {
        gesture: "pinch",
        pointerCount: 2,
        distance,
        scale: 1,
        ...center,
        target: pinchSession.target
      });
      return;
    }

    const scale = distance / Math.max(1, pinchSession.startDistance);
    pinchSession.lastCenter = center;
    if (Math.abs(scale - pinchSession.lastScale) < trackingConfig.pinchMinScaleDelta) {
      return;
    }

    pinchSession.lastScale = scale;
    trackEvent("pinch_change", {
      gesture: "pinch",
      pointerCount: 2,
      distance,
      scale,
      ...center,
      target: pinchSession.target
    });
  }

  function endPinchTracking() {
    if (!pinchSession) {
      return;
    }

    const center = pinchSession.lastCenter || pinchSession.startCenter;
    const dx = center.x - pinchSession.startCenter.x;
    const dy = center.y - pinchSession.startCenter.y;
    const distance = Math.hypot(dx, dy);
    const durationMs = performance.now() - pinchSession.startTime;

    if (distance >= trackingConfig.swipeMinDistancePx && Math.abs(pinchSession.lastScale - 1) < 0.15) {
      trackEvent("two_finger_swipe", {
        gesture: "two_finger_swipe",
        pointerCount: 2,
        x: center.x,
        y: center.y,
        pageX: center.pageX,
        pageY: center.pageY,
        dx,
        dy,
        distance,
        durationMs,
        direction: getDirection(dx, dy),
        target: pinchSession.target
      });
    }

    trackEvent("pinch_end", {
      gesture: "pinch",
      pointerCount: activePointers.size,
      scale: pinchSession.lastScale,
      durationMs,
      target: pinchSession.target
    });
    pinchSession = null;
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
    activePointers.clear();
    lastTap = null;
    lastPress = null;
    pendingClickGesture = null;
    pinchSession = null;
    setInteractionTrackingEnabled(true);
  }

  function rememberClickGesture(name, properties, time) {
    pendingClickGesture = {
      name,
      time,
      x: properties.x,
      y: properties.y,
      properties: {
        ...properties,
        gesture: name,
        inferredFrom: "pointer_duration"
      }
    };
  }

  function takePendingClickGesture(event) {
    if (!pendingClickGesture) {
      return null;
    }

    const ageMs = performance.now() - pendingClickGesture.time;
    const distance = Math.hypot(event.clientX - pendingClickGesture.x, event.clientY - pendingClickGesture.y);
    if (ageMs > 500 || distance > trackingConfig.tapMaxDistancePx * 3) {
      pendingClickGesture = null;
      return null;
    }

    const gesture = pendingClickGesture;
    pendingClickGesture = null;
    return gesture;
  }

  function buildTrackingFileName(timestampSlug) {
    const slug = document.body.dataset.siteSlug || "experiment";
    return `tracking_data_${slug}_${timestampSlug}.json`;
  }

  function downloadTrackingData(timestampSlug = buildDownloadTimestamp()) {
    trackEvent("tracking_data_downloaded", {
      eventCount: eventLog.length
    });

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
    const downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    }));
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = buildTrackingFileName(timestampSlug);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    const downloadedEpochSeconds = downloadedAt.getTime() / 1000;
    const osEventLog = downloadOsLevelEventLog(events, downloadedEpochSeconds, timestampSlug);
    return {
      payload,
      osEventLog,
      timestampSlug,
      downloadedEpochSeconds
    };
  }

  function setupInteractionTracking() {
    document.addEventListener("pointerdown", (event) => {
      const pointer = {
        pointerId: event.pointerId,
        pointerType: event.pointerType || "unknown",
        startX: event.clientX,
        startY: event.clientY,
        startPageX: event.pageX,
        startPageY: event.pageY,
        lastX: event.clientX,
        lastY: event.clientY,
        lastPageX: event.pageX,
        lastPageY: event.pageY,
        startTime: performance.now(),
        lastMoveTrackAt: 0,
        target: getElementDescriptor(event.target),
        dragging: false
      };
      activePointers.set(event.pointerId, pointer);
      trackEvent("pointer_down", getPointProperties(event));
    }, true);

    document.addEventListener("pointermove", (event) => {
      const pointer = activePointers.get(event.pointerId);
      if (!pointer) {
        return;
      }

      pointer.lastX = event.clientX;
      pointer.lastY = event.clientY;
      pointer.lastPageX = event.pageX;
      pointer.lastPageY = event.pageY;
      const dx = event.clientX - pointer.startX;
      const dy = event.clientY - pointer.startY;
      const distance = Math.hypot(dx, dy);

    if (activePointers.size === 2) {
      updatePinchTracking();
      return;
    }

      if (distance < trackingConfig.dragMinDistancePx) {
        return;
      }

      const now = performance.now();
      if (!pointer.dragging) {
        pointer.dragging = true;
        trackEvent("drag_start", {
          gesture: "drag",
          pointerId: event.pointerId,
          pointerType: pointer.pointerType,
          x: pointer.startX,
          y: pointer.startY,
          pageX: pointer.startPageX,
          pageY: pointer.startPageY,
          target: pointer.target
        });
      }

      if (now - pointer.lastMoveTrackAt >= trackingConfig.pointerMoveThrottleMs) {
        pointer.lastMoveTrackAt = now;
        trackEvent("drag_move", {
          gesture: "drag",
          pointerId: event.pointerId,
          pointerType: pointer.pointerType,
          x: event.clientX,
          y: event.clientY,
          pageX: event.pageX,
          pageY: event.pageY,
          dx,
          dy,
          distance,
          direction: getDirection(dx, dy),
          target: pointer.target
        });
      }
    }, { passive: true, capture: true });

    document.addEventListener("pointerup", (event) => {
      const pointer = activePointers.get(event.pointerId);
      if (!pointer) {
        return;
      }

      const now = performance.now();
      const dx = event.clientX - pointer.startX;
      const dy = event.clientY - pointer.startY;
      const distance = Math.hypot(dx, dy);
      const durationMs = now - pointer.startTime;
      const direction = getDirection(dx, dy);
      const base = {
        pointerId: event.pointerId,
        pointerType: pointer.pointerType,
        x: event.clientX,
        y: event.clientY,
        pageX: event.pageX,
        pageY: event.pageY,
        dx,
        dy,
        distance,
        durationMs,
        direction,
        target: pointer.target
      };

      trackEvent("pointer_up", { ...getPointProperties(event), durationMs });

      if (pointer.dragging) {
        trackEvent("drag_end", { gesture: "drag", ...base });
      } else if (distance <= trackingConfig.tapMaxDistancePx && durationMs <= trackingConfig.tapMaxDurationMs) {
        trackEvent("tap", { gesture: "tap", ...base });
        let clickGestureName = "tap_to_click";
        if (
          lastTap &&
          now - lastTap.time <= trackingConfig.doubleTapWindowMs &&
          Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= trackingConfig.tapMaxDistancePx * 2
        ) {
          trackEvent("double_tap", {
            gesture: "double_tap",
            pointerType: pointer.pointerType,
            x: event.clientX,
            y: event.clientY,
            pageX: event.pageX,
            pageY: event.pageY,
            intervalMs: now - lastTap.time,
            target: pointer.target
          });
          lastTap = null;
          clickGestureName = "double_tap_to_click";
        } else {
          lastTap = { time: now, x: event.clientX, y: event.clientY };
        }
        rememberClickGesture(clickGestureName, base, now);
      } else if (distance >= trackingConfig.swipeMinDistancePx && durationMs <= trackingConfig.swipeMaxDurationMs) {
        trackEvent("swipe", { gesture: "swipe", pointerCount: activePointers.size || 1, ...base });
      } else if (durationMs >= trackingConfig.longPressMinDurationMs) {
        trackEvent("long_press", { gesture: "long_press", ...base });
        rememberClickGesture("long_press_to_click", base, now);
        lastPress = null;
      } else if (durationMs >= trackingConfig.pressMinDurationMs) {
        trackEvent("press", { gesture: "press", ...base });
        let clickGestureName = "press_to_click";
        if (
          lastPress &&
          now - lastPress.time <= trackingConfig.doublePressWindowMs &&
          Math.hypot(event.clientX - lastPress.x, event.clientY - lastPress.y) <= trackingConfig.tapMaxDistancePx * 2
        ) {
          trackEvent("double_press", {
            gesture: "double_press",
            pointerType: pointer.pointerType,
            x: event.clientX,
            y: event.clientY,
            pageX: event.pageX,
            pageY: event.pageY,
            intervalMs: now - lastPress.time,
            durationMs,
            target: pointer.target
          });
          lastPress = null;
          clickGestureName = "double_press_to_click";
        } else {
          lastPress = { time: now, x: event.clientX, y: event.clientY };
        }
        rememberClickGesture(clickGestureName, base, now);
      }

      activePointers.delete(event.pointerId);
      if (activePointers.size < 2) {
        endPinchTracking();
      }
    }, true);

    document.addEventListener("pointercancel", (event) => {
      const pointer = activePointers.get(event.pointerId);
      trackEvent("pointer_cancel", {
        ...getPointProperties(event),
        target: pointer ? pointer.target : getElementDescriptor(event.target)
      });
      activePointers.delete(event.pointerId);
      if (activePointers.size < 2) {
        endPinchTracking();
      }
    }, true);

    document.addEventListener("click", (event) => {
      const inferredClickGesture = takePendingClickGesture(event);
      if (inferredClickGesture) {
        trackEvent(inferredClickGesture.name, {
          ...inferredClickGesture.properties,
          clickX: event.clientX,
          clickY: event.clientY,
          button: event.button
        });
      }
      trackEvent("click", {
        gesture: "click",
        x: event.clientX,
        y: event.clientY,
        pageX: event.clientX + window.scrollX,
        pageY: event.clientY + window.scrollY,
        button: event.button,
        target: getElementDescriptor(event.target)
      });
    }, true);

    document.addEventListener("dblclick", (event) => {
      trackEvent("double_click", {
        gesture: "double_click",
        x: event.clientX,
        y: event.clientY,
        pageX: event.clientX + window.scrollX,
        pageY: event.clientY + window.scrollY,
        button: event.button,
        target: getElementDescriptor(event.target)
      });
    }, true);

    document.addEventListener("wheel", (event) => {
      trackEvent(event.ctrlKey ? "wheel_pinch" : "wheel_swipe", {
        gesture: event.ctrlKey ? "pinch" : "wheel_swipe",
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        x: event.clientX,
        y: event.clientY,
        pageX: event.clientX + window.scrollX,
        pageY: event.clientY + window.scrollY,
        target: getElementDescriptor(event.target)
      });
    }, { passive: true, capture: true });

    document.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLInputElement) || event.target.type !== "range") {
        return;
      }
      trackEvent("range_input", {
        gesture: "range_input",
        value: event.target.value,
        min: event.target.min,
        max: event.target.max,
        step: event.target.step,
        target: getElementDescriptor(event.target)
      });
    }, true);

    document.addEventListener("change", (event) => {
      if (!(event.target instanceof HTMLInputElement) || event.target.type !== "range") {
        return;
      }
      trackEvent("range_change", {
        gesture: "range_change",
        value: event.target.value,
        min: event.target.min,
        max: event.target.max,
        step: event.target.step,
        target: getElementDescriptor(event.target)
      });
    }, true);

    document.addEventListener("dragstart", (event) => {
      trackEvent("native_drag_start", {
        gesture: "native_drag",
        x: event.clientX,
        y: event.clientY,
        pageX: event.clientX + window.scrollX,
        pageY: event.clientY + window.scrollY,
        target: getElementDescriptor(event.target)
      });
    }, true);

    document.addEventListener("drop", (event) => {
      trackEvent("native_drop", {
        gesture: "native_drag",
        x: event.clientX,
        y: event.clientY,
        pageX: event.clientX + window.scrollX,
        pageY: event.clientY + window.scrollY,
        target: getElementDescriptor(event.target)
      });
    }, true);

    document.addEventListener("dragend", (event) => {
      trackEvent("native_drag_end", {
        gesture: "native_drag",
        x: event.clientX,
        y: event.clientY,
        pageX: event.clientX + window.scrollX,
        pageY: event.clientY + window.scrollY,
        target: getElementDescriptor(event.target)
      });
    }, true);

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

    document.addEventListener("submit", (event) => {
      trackEvent("form_submit", {
        gesture: "form_submit",
        target: getElementDescriptor(event.target),
        method: event.target.method || "get",
        actionPath: event.target.action ? new URL(event.target.action, window.location.href).pathname : "",
        fields: getFormFields(event.target)
      });
    }, true);
  }

  window.interactionTracker = {
    trackEvent,
    downloadTrackingData,
    getEvents: () => eventLog.slice(),
    getSessionId: () => sessionId,
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
