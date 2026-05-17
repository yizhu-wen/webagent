(() => {
  const trackingConfig = {
    maxEvents: 10000,
    mousemoveThrottleMs: 250,
    scrollThrottleMs: 250
  };
  const eventLog = [];
  const sessionId = createTrackingId();
  let startedAt = null;
  let lastMousemoveTrackAt = 0;
  let lastScrollTrackAt = 0;
  let interactionTrackingEnabled = false;

  function createTrackingId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `event_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function getSafeUrlPath(url) {
    if (!url) {
      return "";
    }

    try {
      return new URL(url, window.location.href).pathname;
    } catch (error) {
      return "";
    }
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
    if (event.key && event.key.length > 1) {
      return event.key;
    }
    return "character";
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

  function trackEvent(name, properties = {}, options = {}) {
    if (!interactionTrackingEnabled && !options.force) {
      return;
    }

    if (eventLog.length >= trackingConfig.maxEvents) {
      eventLog.shift();
    }

    eventLog.push({
      id: createTrackingId(),
      sessionId,
      name,
      timestamp: new Date().toISOString(),
      page: getPageInfo(),
      viewport: getViewportInfo(),
      properties
    });
  }

  function setInteractionTrackingEnabled(enabled) {
    if (interactionTrackingEnabled === enabled) {
      return;
    }

    interactionTrackingEnabled = enabled;
    if (enabled) {
      startedAt = startedAt || new Date().toISOString();
      trackEvent("page_view", {
        path: window.location.pathname,
        referrerPath: getSafeUrlPath(document.referrer)
      }, { force: true });
    }
  }

  function beginTrackingSession() {
    eventLog.length = 0;
    startedAt = new Date().toISOString();
    lastMousemoveTrackAt = 0;
    lastScrollTrackAt = 0;
    setInteractionTrackingEnabled(true);
  }

  function buildTrackingFileName() {
    const slug = document.body.dataset.siteSlug || "experiment";
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
    return `tracking_data_${slug}_${date}_${time}.json`;
  }

  function downloadTrackingData() {
    trackEvent("tracking_data_downloaded", {
      eventCount: eventLog.length
    });

    const events = eventLog.slice();
    const payload = {
      schemaVersion: 1,
      sessionId,
      startedAt,
      downloadedAt: new Date().toISOString(),
      eventCount: events.length,
      trackingConfig,
      page: getPageInfo(),
      events
    };
    const downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    }));
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = buildTrackingFileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  }

  function setupInteractionTracking() {
    document.addEventListener("click", (event) => {
      trackEvent("click", {
        x: event.clientX,
        y: event.clientY,
        pageX: event.clientX + window.scrollX,
        pageY: event.clientY + window.scrollY,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        button: event.button,
        target: getElementDescriptor(event.target)
      });
    }, true);

    document.addEventListener("mousemove", (event) => {
      const now = performance.now();
      if (now - lastMousemoveTrackAt < trackingConfig.mousemoveThrottleMs) {
        return;
      }

      lastMousemoveTrackAt = now;
      trackEvent("mousemove", {
        x: event.clientX,
        y: event.clientY,
        pageX: event.clientX + window.scrollX,
        pageY: event.clientY + window.scrollY,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        movementX: event.movementX,
        movementY: event.movementY,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        target: getElementDescriptor(event.target)
      });
    }, { passive: true });

    window.addEventListener("scroll", () => {
      const now = performance.now();
      if (now - lastScrollTrackAt < trackingConfig.scrollThrottleMs) {
        return;
      }

      lastScrollTrackAt = now;
      trackEvent("scroll", {
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight
      });
    }, { passive: true });

    document.addEventListener("keydown", (event) => {
      trackEvent("keydown", {
        key: getSafeKey(event),
        code: event.code,
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
        target: getElementDescriptor(event.target),
        method: event.target.method || "get",
        actionPath: event.target.action ? new URL(event.target.action, window.location.href).pathname : "",
        fields: getFormFields(event.target)
      });
    }, true);

    document.addEventListener("visibilitychange", () => {
      trackEvent("page_visibility_change", {
        visibilityState: document.visibilityState
      });
    });

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
