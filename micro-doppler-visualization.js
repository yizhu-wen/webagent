(function initializeMicroDopplerVisualization(global) {
  "use strict";

  const DEFAULT_DB_FLOOR = -30;
  const TURBO_RED = [
    0.13572138,
    4.6153926,
    -42.66032258,
    132.13108234,
    -152.94239396,
    59.28637943
  ];
  const TURBO_GREEN = [
    0.09140261,
    2.19418839,
    4.84296658,
    -14.18503333,
    4.27729857,
    2.82956604
  ];
  const TURBO_BLUE = [
    0.1066733,
    12.64194608,
    -60.58204836,
    110.36276771,
    -89.90310912,
    27.34824973
  ];

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function polynomial(coefficients, value) {
    let result = 0;
    let power = 1;
    for (const coefficient of coefficients) {
      result += coefficient * power;
      power *= value;
    }
    return result;
  }

  function turboColor(normalized) {
    const value = clamp(normalized, 0, 1);
    return [
      Math.round(clamp(polynomial(TURBO_RED, value), 0, 1) * 255),
      Math.round(clamp(polynomial(TURBO_GREEN, value), 0, 1) * 255),
      Math.round(clamp(polynomial(TURBO_BLUE, value), 0, 1) * 255)
    ];
  }

  function create(options) {
    const canvas = options.canvas;
    const statusNode = options.statusNode || null;
    const timelineDurationSeconds = Number(options.timelineDurationSeconds) || 40;
    const timelineTickSeconds = Number(options.timelineTickSeconds) || 5;
    const stillRegions = Array.isArray(options.stillRegions) ? options.stillRegions : [];
    const getMarkers = typeof options.getMarkers === "function"
      ? options.getMarkers
      : () => [];
    const maximumPoints = Number(options.maximumPoints) || 1000;
    const initialStatus = options.initialStatus
      || "Start sensing to see live left/right micro-Doppler heatmaps.";

    let points = [];
    let drawPending = false;
    let lastStatusMessage = initialStatus;

    function setStatus(message) {
      lastStatusMessage = message || initialStatus;
      if (statusNode) {
        statusNode.textContent = lastStatusMessage;
      }
      queueDraw();
    }

    function reset(message) {
      points = [];
      lastStatusMessage = message || initialStatus;
      if (statusNode) {
        statusNode.textContent = lastStatusMessage;
      }
      draw();
    }

    function append(message, sessionStartEpoch) {
      const frequencies = Array.isArray(message.frequencies_hz)
        ? message.frequencies_hz.map((value) => Number(value) || 0)
        : [];
      const leftPower = Array.isArray(message.left_power_db)
        ? message.left_power_db.map((value) => Number(value))
        : [];
      const rightPower = Array.isArray(message.right_power_db)
        ? message.right_power_db.map((value) => Number(value))
        : [];
      const binCount = Math.min(
        frequencies.length,
        leftPower.length,
        rightPower.length
      );
      if (!binCount) {
        return;
      }

      const timestamp = Number(message.timestamp);
      let time = Number(message.time) || 0;
      if (Number.isFinite(timestamp) && Number.isFinite(sessionStartEpoch)) {
        time = timestamp - sessionStartEpoch;
      }
      if (!Number.isFinite(time) || time < 0) {
        time = Number(message.time) || 0;
      }
      points.push({
        time,
        timestamp: Number.isFinite(timestamp) ? timestamp : null,
        frequencies: frequencies.slice(0, binCount),
        leftPower: leftPower.slice(0, binCount),
        rightPower: rightPower.slice(0, binCount),
        dbFloor: Number.isFinite(Number(message.db_floor))
          ? Number(message.db_floor)
          : DEFAULT_DB_FLOOR,
        latencySeconds: Number(message.latency_seconds) || 0,
        leftSelectedBins: Array.isArray(message.left_selected_bins)
          ? message.left_selected_bins.slice()
          : [],
        rightSelectedBins: Array.isArray(message.right_selected_bins)
          ? message.right_selected_bins.slice()
          : []
      });
      if (points.length > maximumPoints) {
        points.splice(0, points.length - maximumPoints);
      }
      if (points.length === 1) {
        const updateMilliseconds = (
          (Number(message.hop_chirps) || 8)
          / (Number(message.slow_rate_hz) || 83.333333)
          * 1000
        );
        setStatus(
          `Live micro-Doppler running: ${Number(message.window_chirps) || 64}-chirp window, `
          + `${updateMilliseconds.toFixed(0)} ms updates, `
          + `${(Number(message.latency_seconds) * 1000 || 0).toFixed(0)} ms window-center latency.`
        );
      } else {
        queueDraw();
      }
    }

    function queueDraw() {
      if (!canvas || drawPending) {
        return;
      }
      drawPending = true;
      global.requestAnimationFrame(() => {
        drawPending = false;
        draw();
      });
    }

    function render(targetCanvas, bandDefinitions) {
      if (!targetCanvas || !bandDefinitions.length) {
        return;
      }
      const ctx = targetCanvas.getContext("2d");
      const width = targetCanvas.width;
      const height = targetCanvas.height;
      const margin = { top: 32, right: 18, bottom: 50, left: 88 };
      const gap = 32;
      const plotWidth = width - margin.left - margin.right;
      const panelHeight = Math.floor(
        (
          height
          - margin.top
          - margin.bottom
          - gap * Math.max(0, bandDefinitions.length - 1)
        ) / bandDefinitions.length
      );
      const makeArea = (index) => ({
        left: margin.left,
        top: margin.top + index * (panelHeight + gap),
        right: margin.left + plotWidth,
        bottom: margin.top + index * (panelHeight + gap) + panelHeight,
        width: plotWidth,
        height: panelHeight
      });
      const areas = bandDefinitions.map((_, index) => makeArea(index));
      const firstArea = areas[0];
      const lastArea = areas[areas.length - 1];
      const visiblePoints = points.filter(
        (point) => point.time >= 0 && point.time <= timelineDurationSeconds
      );
      const visibleMarkers = getMarkers().filter(
        (marker) => marker.time >= 0 && marker.time <= timelineDurationSeconds
      );
      const latestPoint = visiblePoints.length
        ? visiblePoints[visiblePoints.length - 1]
        : null;
      const frequencies = latestPoint ? latestPoint.frequencies : [];
      const frequencyMinimum = frequencies.length ? frequencies[0] : -41.67;
      const frequencyMaximum = frequencies.length
        ? frequencies[frequencies.length - 1]
        : 41.67;
      const dbFloor = latestPoint ? latestPoint.dbFloor : DEFAULT_DB_FLOOR;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#fffdfa";
      ctx.fillRect(0, 0, width, height);

      function xToPx(time) {
        return firstArea.left
          + (time / Math.max(timelineDurationSeconds, 1e-6)) * firstArea.width;
      }

      function drawHeatmap(area, key, title) {
        const image = ctx.createImageData(area.width, area.height);
        let pointIndex = -1;
        for (let x = 0; x < area.width; x += 1) {
          const time = (
            x / Math.max(1, area.width - 1)
          ) * timelineDurationSeconds;
          while (
            pointIndex + 1 < visiblePoints.length
            && visiblePoints[pointIndex + 1].time <= time
          ) {
            pointIndex += 1;
          }
          const point = pointIndex >= 0 ? visiblePoints[pointIndex] : null;
          const values = point ? point[key] : null;
          for (let y = 0; y < area.height; y += 1) {
            const frequencyIndex = values && values.length
              ? Math.round(
                ((area.height - 1 - y) / Math.max(1, area.height - 1))
                * (values.length - 1)
              )
              : 0;
            const power = values && values.length
              ? Number(values[frequencyIndex])
              : dbFloor;
            const normalized = (
              clamp(power, dbFloor, 0) - dbFloor
            ) / Math.max(1e-6, -dbFloor);
            const [red, green, blue] = turboColor(normalized);
            const pixel = (y * area.width + x) * 4;
            image.data[pixel] = red;
            image.data[pixel + 1] = green;
            image.data[pixel + 2] = blue;
            image.data[pixel + 3] = 255;
          }
        }
        ctx.putImageData(image, area.left, area.top);
        if (!visiblePoints.length) {
          ctx.fillStyle = "#fffdfa";
          ctx.fillRect(area.left, area.top, area.width, area.height);
        }

        ctx.save();
        for (const region of stillRegions) {
          ctx.fillStyle = "rgba(247, 244, 236, 0.24)";
          ctx.fillRect(
            xToPx(region.start),
            area.top,
            xToPx(region.end) - xToPx(region.start),
            area.height
          );
        }
        for (
          let seconds = 0;
          seconds <= timelineDurationSeconds + 1e-6;
          seconds += timelineTickSeconds
        ) {
          const x = xToPx(seconds);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.moveTo(x, area.top);
          ctx.lineTo(x, area.bottom);
          ctx.stroke();
        }
        const zeroRatio = (
          frequencyMaximum / Math.max(
            1e-6,
            frequencyMaximum - frequencyMinimum
          )
        );
        const zeroY = area.top + zeroRatio * area.height;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.78)";
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(area.left, zeroY);
        ctx.lineTo(area.right, zeroY);
        ctx.stroke();
        ctx.setLineDash([]);

        for (const marker of visibleMarkers) {
          const x = xToPx(marker.time);
          ctx.strokeStyle = marker.color || "#ffffff";
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(x, area.top);
          ctx.lineTo(x, area.bottom);
          ctx.stroke();
          ctx.save();
          ctx.translate(x + 3, area.top + 5);
          ctx.rotate(-Math.PI / 2);
          ctx.fillStyle = "#ffffff";
          ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
          ctx.shadowBlur = 3;
          ctx.font = "13px 'Segoe UI', sans-serif";
          ctx.textAlign = "right";
          ctx.textBaseline = "top";
          ctx.fillText(marker.label || marker.name || "event", 0, 0);
          ctx.restore();
        }
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = "rgba(46, 36, 28, 0.35)";
        ctx.strokeRect(area.left, area.top, area.width, area.height);
        ctx.fillStyle = "#2e241c";
        ctx.font = "17px 'Segoe UI', sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(title, area.left, area.top - 6);
        ctx.font = "13px 'Segoe UI', sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(frequencyMinimum.toFixed(1), area.left - 8, area.bottom);
        ctx.fillText("0", area.left - 8, area.top + area.height / 2);
        ctx.fillText(frequencyMaximum.toFixed(1), area.left - 8, area.top);
        ctx.save();
        ctx.translate(20, area.top + area.height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "center";
        ctx.fillText("Doppler frequency (Hz)", 0, 0);
        ctx.restore();
        ctx.restore();
      }

      bandDefinitions.forEach((definition, index) => {
        drawHeatmap(areas[index], definition.key, definition.title);
      });

      ctx.save();
      const scaleWidth = 120;
      const scaleLeft = firstArea.right - scaleWidth;
      const scaleTop = firstArea.top - 22;
      for (let x = 0; x < scaleWidth; x += 1) {
        const [red, green, blue] = turboColor(x / Math.max(1, scaleWidth - 1));
        ctx.fillStyle = `rgb(${red}, ${green}, ${blue})`;
        ctx.fillRect(scaleLeft + x, scaleTop, 1, 8);
      }
      ctx.fillStyle = "#2e241c";
      ctx.font = "12px 'Segoe UI', sans-serif";
      ctx.textBaseline = "bottom";
      ctx.textAlign = "right";
      ctx.fillText(`${dbFloor.toFixed(0)} dB`, scaleLeft - 6, scaleTop + 8);
      ctx.fillText("0 dB", firstArea.right, scaleTop + 8);

      ctx.font = "14px 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (
        let seconds = 0;
        seconds <= timelineDurationSeconds + 1e-6;
        seconds += timelineTickSeconds
      ) {
        ctx.fillText(`${seconds}s`, xToPx(seconds), lastArea.bottom + 12);
      }
      ctx.font = "15px 'Segoe UI', sans-serif";
      ctx.fillText("Recording time (s)", width / 2, height - 19);

      if (!visiblePoints.length) {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "17px 'Segoe UI', sans-serif";
        ctx.fillStyle = "#2e241c";
        ctx.fillText(lastStatusMessage, width / 2, height / 2);
      }
      ctx.restore();
    }

    function draw() {
      render(canvas, [
        { key: "leftPower", title: "Left band (19-20.5 kHz)" },
        { key: "rightPower", title: "Right band (21.5-23 kHz)" }
      ]);
    }

    function exportFigures() {
      if (!canvas || !canvas.ownerDocument) {
        return null;
      }
      const createFigure = (key, title) => {
        const figureCanvas = canvas.ownerDocument.createElement("canvas");
        figureCanvas.width = canvas.width;
        figureCanvas.height = 360;
        render(figureCanvas, [{ key, title }]);
        return figureCanvas.toDataURL("image/png");
      };
      return {
        left: createFigure("leftPower", "Left band (19-20.5 kHz)"),
        right: createFigure("rightPower", "Right band (21.5-23 kHz)")
      };
    }

    function getDebugState() {
      return {
        points: points.length,
        status: lastStatusMessage,
        latest: points.length ? points[points.length - 1] : null
      };
    }

    if (statusNode) {
      statusNode.textContent = initialStatus;
    }
    draw();

    return {
      append,
      draw,
      exportFigures,
      getDebugState,
      queueDraw,
      reset,
      setStatus
    };
  }

  global.WebAgentMicroDoppler = { create, turboColor };
})(window);
