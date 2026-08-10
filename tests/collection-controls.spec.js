const { test, expect } = require("@playwright/test");

const expectedActivities = [
  "keyboard_activity",
  "touchpad_click",
  "touchpad_scroll",
  "touchpad_pointer_move",
  "sitting_still",
  "hand_wave",
  "body_motion"
];

const expectedSentences = [
  "Mr. Bennet was among the earliest of those who waited on Mr. Bingley.",
  "They soon know that they will grow up, and the way Wendy knew was this.",
  "His grey eyes shone and twinkled, and his usually pale face was flushed and animated.",
  "Uncle Henry never laughed. He worked hard from morning till night and did not know what joy was.",
  "There was no possibility of taking a walk that day.",
  "So, I called myself Pip, and came to be called Pip.",
  "Mrs. Rachel rapped smartly at the kitchen door and stepped in when bidden to do so.",
  "She knew that she was not going to stay at the English clergyman's house where she was taken at first.",
  "I am by birth a Genevese, and my family is one of the most distinguished of that republic.",
  "The Mole had been working very hard all the morning, spring-cleaning his little home."
];

test("requires one of seven activities and exposes all keyboard sentences", async ({ page }) => {
  await page.goto("/");

  const activityInputs = page.locator('input[name="collectionActivity"]');
  await expect(activityInputs).toHaveCount(7);
  expect(await activityInputs.evaluateAll((inputs) => inputs.map((input) => input.value))).toEqual(expectedActivities);
  expect(await activityInputs.evaluateAll((inputs) => inputs.map((input) => input.checked)))
    .toEqual([false, false, false, false, false, false, false]);
  await expect(page.locator("#startSensingBtn")).toBeVisible();
  await expect(page.locator("#startSensingBtn")).toBeDisabled();
  await expect(page.locator("#startSensingHint")).toContainText("Select one activity");
  await expect(page.locator("#collectionTimeline")).toHaveAttribute("aria-valuenow", "0.00");

  await page.locator('input[value="keyboard_activity"]').check();
  await expect(page.locator("#keyboardTask")).toBeVisible();
  await expect(page.locator("#typingSentenceSelect option")).toHaveCount(10);
  expect(await page.evaluate(() => window.webAgentCollection.getTypingSentences().map((item) => item.text)))
    .toEqual(expectedSentences);
  await expect(page.locator("#typingSentenceText")).toContainText(expectedSentences[0]);
  await page.locator("#typingSentenceSelect").selectOption("10");
  await expect(page.locator("#typingSentenceText")).toContainText(expectedSentences[9]);
  await expect(page.locator("#typingInput")).toBeDisabled();
  await expect(page.locator("#startSensingBtn")).toBeEnabled();

  await page.locator('input[value="hand_wave"]').check();
  await expect(page.locator("#keyboardTask")).toBeHidden();
  await expect(page.locator('input[value="keyboard_activity"]')).not.toBeChecked();
  await expect(page.locator('input[value="hand_wave"]')).toBeChecked();
});

test("uses exact 5-25-5 phase boundaries and keeps sitting still for the full run", async ({ page }) => {
  await page.goto("/");

  const phases = await page.evaluate(() => ({
    beforeFive: window.webAgentCollection.getPhase("keyboard_activity", 4.999),
    atFive: window.webAgentCollection.getPhase("keyboard_activity", 5),
    beforeThirty: window.webAgentCollection.getPhase("keyboard_activity", 29.999),
    atThirty: window.webAgentCollection.getPhase("keyboard_activity", 30),
    atThirtyFive: window.webAgentCollection.getPhase("keyboard_activity", 35),
    stillMiddle: window.webAgentCollection.getPhase("sitting_still", 18)
  }));

  expect(phases.beforeFive.key).toBe("initial-still");
  expect(phases.atFive.key).toBe("action");
  expect(phases.beforeThirty.key).toBe("action");
  expect(phases.atThirty.key).toBe("final-still");
  expect(phases.atThirtyFive.key).toBe("final-still");
  expect(phases.atThirtyFive.totalRemainingSeconds).toBe(0);
  expect(phases.stillMiddle.key).toBe("all-still");
  expect(phases.stillMiddle.title).toBe("SIT STILL");
  expect(await page.evaluate(() => window.webAgentCollection.getTiming())).toEqual({
    initialStillEndSeconds: 5,
    actionEndSeconds: 30,
    durationSeconds: 35
  });
});

test("locks the selected keyboard run and enables typing only when the action phase begins", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[value="keyboard_activity"]').check();
  await page.locator("#typingSentenceSelect").selectOption("3");
  await page.locator("#startSensingBtn").click();

  await expect(page.locator("#startSensingBtn")).toHaveText("Stop sensing");
  await expect(page.locator('input[name="collectionActivity"]').first()).toBeDisabled();
  await expect(page.locator("#typingSentenceSelect")).toBeDisabled();
  await expect(page.locator("#typingInput")).toBeDisabled();
  await expect(page.locator("#collectionPhaseStatus")).toHaveText("SIT STILL");
  expect(await page.evaluate(() => window.webAgentCollection.getActiveSession())).toMatchObject({
    activityId: "keyboard_activity",
    typingSentenceId: 3,
    typingSentenceSource: "The Time Machine"
  });

  await expect.poll(
    () => page.locator("#typingInput").isEnabled(),
    { timeout: 8000 }
  ).toBe(true);
  await expect(page.locator("#collectionPhaseStatus")).toHaveText("TYPE NOW");
  const progressSeconds = Number(await page.locator("#collectionTimeline").getAttribute("aria-valuenow"));
  expect(progressSeconds).toBeGreaterThanOrEqual(5);
  expect(progressSeconds).toBeLessThan(30);
  await expect(page.locator("#collectionTimeline")).toHaveClass(/is-running/);
  await page.locator("#typingInput").fill("His grey eyes");

  await page.locator("#startSensingBtn").click();
  await expect(page.locator("#startSensingBtn")).toHaveText("Start sensing", { timeout: 15000 });
  await expect(page.locator("#typingInput")).toBeDisabled();
  await expect(page.locator('input[name="collectionActivity"]').first()).toBeEnabled();
});
