const { test, expect } = require("@playwright/test");

const expectedActivities = [
  ["keyboard_activity", "Keyboard"],
  ["touchpad_click", "Touchpad click"],
  ["touchpad_scroll", "Touchpad scroll"],
  ["touchpad_pointer_move", "Pointer move"],
  ["sitting_still", "Sitting still"],
  ["hand_wave", "Hand wave"],
  ["body_motion", "Body motion"]
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

for (const [activityId, label] of expectedActivities) {
  test(`${label} opens its dedicated guided task`, async ({ page }) => {
    await page.goto(`/collection.html?activity=${activityId}`);
    await expect(page.getByRole("heading", { name: label })).toBeVisible();
    await expect(page.locator(`input[value="${activityId}"]`)).toBeChecked();
    await expect(page.locator("#activityGuidance")).not.toBeEmpty();
    await expect(page.locator("#collectionTimeline")).toBeVisible();
    await expect(page.locator("#collectionTimeline")).toHaveAttribute("aria-valuenow", "0.00");
    await expect(page.locator("#startSensingBtn")).toBeVisible();
    await expect(page.locator(".activity-choice")).toBeHidden();
  });
}

test("keyboard task shows the assigned sentence and typing field", async ({ page }) => {
  await page.goto("/collection.html?activity=keyboard_activity");
  await expect(page.locator("#keyboardTask")).toBeVisible();
  await expect(page.locator("#typingSentenceSelect option")).toHaveCount(10);
  await expect(page.locator("#typingSentenceText")).toContainText("Mr. Bennet");
  await expect(page.locator("#typingInput")).toBeDisabled();
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
