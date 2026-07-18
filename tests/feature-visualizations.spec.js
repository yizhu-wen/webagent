const { test, expect } = require("@playwright/test");

const pixelImage =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

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
          name: "02_doppler_velocity.png",
          url: image,
          description: "Radial motion direction and speed."
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
  await expect(panel).toContainText("Doppler Velocity");
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
