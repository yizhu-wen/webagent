const { test, expect } = require("@playwright/test");

const pixelImage =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

function buildDopplerColumn(time) {
  const frequencies = [];
  const leftPower = [];
  const rightPower = [];
  for (let index = 0; index < 256; index += 1) {
    const frequency = -41.6667 + index * (83.3334 / 256);
    frequencies.push(frequency);
    leftPower.push(Math.max(-30, -Math.abs(frequency - 8) * 1.5));
    rightPower.push(Math.max(-30, -Math.abs(frequency + 11) * 1.3));
  }
  return {
    type: "doppler",
    time,
    window_chirps: 64,
    hop_chirps: 8,
    slow_rate_hz: 83.3333,
    latency_seconds: 0.384,
    db_floor: -30,
    frequencies_hz: frequencies,
    left_power_db: leftPower,
    right_power_db: rightPower,
    left_selected_bins: Array.from({ length: 12 }, (_, index) => index),
    right_selected_bins: Array.from({ length: 12 }, (_, index) => index + 12)
  };
}

test("renders separate realtime left and right micro-Doppler heatmaps", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Live Micro-Doppler" })).toBeVisible();
  const canvas = page.locator("#dopplerCanvas");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("height", "520");
  await expect(canvas).toHaveAttribute(
    "aria-label",
    "Live left and right ultrasonic micro-Doppler heatmaps"
  );

  const debugState = await page.evaluate((columns) => {
    const renderer = window.WebAgentMicroDoppler.create({
      canvas: document.getElementById("dopplerCanvas"),
      statusNode: document.getElementById("dopplerStatus"),
      timelineDurationSeconds: 40,
      timelineTickSeconds: 5,
      stillRegions: [],
      getMarkers: () => []
    });
    columns.forEach((column) => renderer.append(column, null));
    window.__dopplerRendererForTest = renderer;
    return renderer.getDebugState();
  }, [buildDopplerColumn(4), buildDopplerColumn(4.096)]);

  expect(debugState.points).toBe(2);
  expect(debugState.latest.leftPower).toHaveLength(256);
  expect(debugState.latest.rightPower).toHaveLength(256);
  await expect(page.locator("#dopplerStatus")).toContainText("64-chirp window");
  await page.waitForTimeout(50);

  const renderedColorCount = await page.evaluate(() => {
    const canvasNode = document.getElementById("dopplerCanvas");
    const context = canvasNode.getContext("2d");
    const pixels = context.getImageData(88, 32, 714, 406).data;
    const colors = new Set();
    for (let index = 0; index < pixels.length; index += 64) {
      colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`);
    }
    return colors.size;
  });
  expect(renderedColorCount).toBeGreaterThan(8);
});

test("renders processed feature figures on the sensing page", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#featureVisualizationPanel")).toBeHidden();
  await expect(page.locator("#fileStatus")).toContainText("Ultrasound chirp ready");
  await page.evaluate(({ image }) => {
    const result = {
      figures: [
        {
          name: "01_range_time_energy.png",
          url: image,
          description: "Matched-filter return energy over distance and time."
        },
        {
          name: "stage4_signal_events_phase_change.png",
          url: image,
          description: "Phase change with action markers."
        }
      ],
      predictions: {
        windowSeconds: 0.5,
        strideSeconds: 0.25,
        predictions: [
          {
            windowIndex: 1,
            startSeconds: 1,
            endSeconds: 1.5,
            predictedLabel: "hand_wave",
            confidence: 0.91
          },
          {
            windowIndex: 2,
            startSeconds: 1.25,
            endSeconds: 1.75,
            predictedLabel: "no_event",
            confidence: 0.73
          }
        ]
      }
    };
    window.webAgentSensing.renderGeneratedFigures(result);
    window.webAgentSensing.renderWindowPredictions(result);
  }, { image: pixelImage });

  const panel = page.locator("#featureVisualizationPanel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".feature-visualization-item")).toHaveCount(2);
  await expect(panel).toContainText("Range Time Energy");
  await expect(panel).toContainText("Phase Change");
  await expect(panel).toContainText("model feature pipeline");
  await expect(panel.locator("#windowPredictionBody tr")).toHaveCount(2);
  await expect(panel).toContainText("hand_wave");
  await expect(panel).toContainText("91.0%");

  const desktopColumns = await panel.locator(".feature-visualization-grid").evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length
  );
  expect(desktopColumns).toBe(1);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => {
    const grid = document.querySelector(".feature-visualization-grid");
    return {
      columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      overflows: document.documentElement.scrollWidth > window.innerWidth
    };
  });
  expect(mobileLayout).toEqual({ columns: 1, overflows: false });
});

test("renders processed feature figures on experiment pages", async ({ page }) => {
  await page.goto("/experiments/");

  await page.evaluate(({ image }) => {
    const result = {
      figures: [
        {
          name: "04_model_input_maps.png",
          url: image,
          description: "Exact pooled model inputs."
        }
      ],
      predictions: {
        windowSeconds: 0.5,
        strideSeconds: 0.25,
        predictions: [
          {
            windowIndex: 1,
            startSeconds: 1,
            endSeconds: 1.5,
            predictedLabel: "click_tap",
            confidence: 0.84
          }
        ]
      }
    };
    window.experimentSensing.renderGeneratedFigures(result);
    window.experimentSensing.renderWindowPredictions(result);
  }, { image: pixelImage });

  const panel = page.locator("[data-feature-visualization-panel]");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".feature-visualization-item")).toHaveCount(1);
  await expect(panel).toContainText("Model Input Maps");
  await expect(panel.locator("[data-window-prediction-body] tr")).toHaveCount(1);
  await expect(panel).toContainText("click_tap");
});
