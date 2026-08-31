const { test, expect } = require("@playwright/test");

const expectedActivities = [
  ["keyboard_activity", "Keyboard"],
  ["touchpad_click", "Touchpad click"],
  ["touchpad_scroll", "Touchpad scroll"],
  ["touchpad_pointer_move", "Pointer move"],
  ["sitting_still", "Sitting still"],
  ["hand_wave", "Hand wave"],
  ["body_motion", "Walking"]
];

test("landing page contains only the seven activity choices", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose an activity" })).toBeVisible();
  const links = page.locator(".activity-button");
  await expect(links).toHaveCount(7);
  await expect(links.locator("strong")).toHaveText(expectedActivities.map(([, label]) => label));
  await expect(page.locator("#startSensingBtn")).toHaveCount(0);
  await expect(page.locator("a[href*='experiments']")).toHaveCount(0);
});

test("uses the larger text scale on the landing and task pages", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => (
    window.getComputedStyle(document.documentElement).fontSize
  ))).toBe("18px");

  await page.goto("/collection.html?activity=keyboard_activity");
  await expect.poll(() => page.evaluate(() => (
    window.getComputedStyle(document.documentElement).fontSize
  ))).toBe("18px");
});

for (const [activityId, label] of expectedActivities) {
  test(`${label} opens its dedicated guided task`, async ({ page }) => {
    await page.goto(`/collection.html?activity=${activityId}`);
    await expect(page.getByRole("heading", { name: label })).toBeVisible();
    await expect(page.locator(`input[value="${activityId}"]`)).toBeChecked();
    await expect(page.locator("#activityGuidance")).not.toBeEmpty();
    await expect(page.locator("#collectionTimeline")).toBeVisible();
    await expect(page.locator("#collectionTimeline")).toHaveAttribute("aria-valuenow", "0.00");
    await expect(page.locator("#startSensingBtn")).toBeVisible();
    await expect(page.locator("#activityChoiceGroup")).toBeHidden();
    await expect(page.locator("#welcomeMessage")).toHaveCount(0);
  });
}

test("keyboard task shows the assigned sentence and typing field", async ({ page }) => {
  await page.goto("/collection.html?activity=keyboard_activity");
  await expect(page.locator("#keyboardTask")).toBeVisible();
  await expect(page.locator("#typingSentenceSelect option")).toHaveCount(10);
  await expect(page.locator("#typingSentenceText")).toContainText("Mr. Bennet");
  await expect(page.locator("#typingInput")).toBeDisabled();
  await expect(page.locator("#activityPageSummary")).toHaveCount(0);
  await expect(page.locator("#micStatus")).toHaveText("");
  await expect(page.locator("#collectionPhaseStatus")).toHaveText("");
  await expect(page.locator("#collectionPhaseCountdown")).toHaveText("");
  await expect(page.locator("#collectionTotalCountdown")).toHaveText("");
  await expect(page.locator("#collectionPromptInstruction")).toHaveText("");
  await expect(page.locator("#startSensingHint")).toHaveText("");
  await expect(page.locator("#collectionTimeline")).toBeVisible();
});

test("centers the green Start sensing button inside the task panel", async ({ page }) => {
  await page.goto("/collection.html?activity=keyboard_activity");

  const startButton = page.locator(".collection-panel #startSensingBtn");
  await expect(startButton).toBeVisible();
  const appearance = await startButton.evaluate((button) => {
    const style = window.getComputedStyle(button);
    const rectangle = button.getBoundingClientRect();
    const panelRectangle = button.closest(".collection-panel").getBoundingClientRect();
    return {
      backgroundImage: style.backgroundImage,
      color: style.color,
      centerOffset: Math.abs(
        (rectangle.left + rectangle.width / 2)
        - (panelRectangle.left + panelRectangle.width / 2)
      )
    };
  });
  expect(appearance.backgroundImage).toContain("linear-gradient");
  expect(appearance.color).toBe("rgb(255, 255, 255)");
  expect(appearance.centerOffset).toBeLessThan(2);
});

test("touchpad click uses an 18-click timestamp schedule", async ({ page }) => {
  await page.goto("/collection.html?activity=touchpad_click");

  await expect(page.locator("#activityGuidance")).toContainText("exactly 18 physical touchpad clicks");
  await expect(page.locator("#timelineAction")).toContainText("18 CLICKS");
  await expect(page.locator("#actionSchedule")).toBeVisible();
  await expect.poll(() => page.locator("#actionScheduleCaption").evaluate((element) => (
    Number.parseFloat(window.getComputedStyle(element).fontSize)
  ))).toBeGreaterThanOrEqual(18);

  const markers = page.locator("#actionScheduleMarkers .action-schedule-marker");
  await expect(markers).toHaveCount(18);
  await expect(markers.first()).toContainText("5.7s");
  await expect(markers.first()).toHaveAttribute("title", "1. Physical touchpad click at 5.7 seconds");
  await expect(markers.last()).toContainText("29.3s");
  await expect(markers.last()).toHaveAttribute("title", "18. Physical touchpad click at 29.3 seconds");
  await expect(markers.first()).toHaveClass(/next/);
  await expect(page.locator("#collectionTimeline")).toHaveAttribute(
    "aria-label",
    /18 scheduled physical clicks/
  );

  const schedule = await page.evaluate(() => (
    window.webAgentCollection.getActionSchedule("touchpad_click")
  ));
  expect(schedule).toHaveLength(18);
  expect(schedule[0].timestamp).toBe(5.7);
  expect(schedule[17].timestamp).toBe(29.3);
});

for (const scheduledActivity of [
  {
    activityId: "touchpad_scroll",
    timelineLabel: "12 SCROLLS",
    count: 12,
    guidance: "up, down, left, right",
    labels: ["↑", "↓", "←", "→", "↑", "↓", "←", "→", "↑", "↓", "←", "→"],
    firstTimestamp: 6.0,
    lastTimestamp: 29.0
  },
  {
    activityId: "touchpad_pointer_move",
    timelineLabel: "12 MOVES",
    count: 12,
    guidance: "up, down, left, right",
    labels: ["↑", "↓", "←", "→", "↑", "↓", "←", "→", "↑", "↓", "←", "→"],
    firstTimestamp: 6.0,
    lastTimestamp: 29.0
  },
  {
    activityId: "hand_wave",
    timelineLabel: "10 WAVES",
    count: 10,
    guidance: "Repeat the two-wave pair 5 times",
    labels: ["R", "L", "R", "L", "R", "L", "R", "L", "R", "L"],
    firstTimestamp: 6.3,
    lastTimestamp: 28.8
  },
  {
    activityId: "body_motion",
    timelineLabel: "7 WALKS",
    count: 7,
    guidance: "left, right, left, right, left, right, left",
    labels: ["L", "R", "L", "R", "L", "R", "L"],
    firstTimestamp: 6.8,
    lastTimestamp: 28.2
  }
]) {
  test(`${scheduledActivity.activityId} shows its standardized action schedule`, async ({ page }) => {
    await page.goto(`/collection.html?activity=${scheduledActivity.activityId}`);

    await expect(page.locator("#activityGuidance")).toContainText(scheduledActivity.guidance);
    await expect(page.locator("#timelineAction")).toContainText(scheduledActivity.timelineLabel);
    await expect(page.locator("#actionSchedule")).toBeVisible();

    const markers = page.locator("#actionScheduleMarkers .action-schedule-marker");
    await expect(markers).toHaveCount(scheduledActivity.count);
    await expect(markers.locator(".action-schedule-label")).toHaveText(scheduledActivity.labels);

    const schedule = await page.evaluate((activityId) => (
      window.webAgentCollection.getActionSchedule(activityId)
    ), scheduledActivity.activityId);
    expect(schedule).toHaveLength(scheduledActivity.count);
    expect(schedule[0].timestamp).toBe(scheduledActivity.firstTimestamp);
    expect(schedule.at(-1).timestamp).toBe(scheduledActivity.lastTimestamp);
  });
}

test("keyboard task advances through sentences with the Next sentence button", async ({ page }) => {
  await page.goto("/collection.html?activity=keyboard_activity");

  const sentenceSelect = page.locator("#typingSentenceSelect");
  const sentenceText = page.locator("#typingSentenceText");
  const nextButton = page.getByRole("button", { name: "Next sentence" });

  await expect(sentenceSelect).toHaveValue("1");
  await expect(nextButton).toBeEnabled();
  await nextButton.click();
  await expect(sentenceSelect).toHaveValue("2");
  await expect(sentenceText).toContainText("They soon know that they will grow up");

  await sentenceSelect.selectOption("9");
  await nextButton.click();
  await expect(sentenceSelect).toHaveValue("10");
  await expect(sentenceText).toContainText("The Mole had been working very hard");
  await expect(nextButton).toBeDisabled();
  await expect(nextButton).toHaveAttribute("title", "This is the final assigned sentence.");
});

test("uses exact 5-25-5 phase boundaries", async ({ page }) => {
  await page.goto("/collection.html?activity=hand_wave");
  const phases = await page.evaluate(() => ({
    beforeFive: window.webAgentCollection.getPhase("hand_wave", 4.999).key,
    atFive: window.webAgentCollection.getPhase("hand_wave", 5).key,
    atThirty: window.webAgentCollection.getPhase("hand_wave", 30).key,
    stillMiddle: window.webAgentCollection.getPhase("sitting_still", 18).key
  }));
  expect(phases).toEqual({
    beforeFive: "initial-still",
    atFive: "action",
    atThirty: "final-still",
    stillMiddle: "all-still"
  });
});
