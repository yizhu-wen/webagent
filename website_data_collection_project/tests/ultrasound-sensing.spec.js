const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const { readStoredZipEntries } = require("./zip-helpers");

const SITE = "/LOCALDEV01/";
// The panel is deliberately absent from the landing page, so anything that
// drives the controls has to start from one of the task pages.
const TASK_PAGE = "/LOCALDEV01/forums";

// The sensing panel stops itself after 40 seconds. Replace only that one timer
// so the export path can be exercised without waiting out a full session.
async function installDurationLimitTimerTestHook(page) {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const durationTimerId = 40000;
    let durationTimerCallback = null;

    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 40000) {
        durationTimerCallback = () => callback(...args);
        return durationTimerId;
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
    window.clearTimeout = (timerId) => {
      if (timerId === durationTimerId) {
        durationTimerCallback = null;
        return;
      }
      nativeClearTimeout(timerId);
    };
    window.__triggerDurationLimitForTest = () => {
      const callback = durationTimerCallback;
      durationTimerCallback = null;
      if (callback) {
        callback();
      }
    };
  });
}

async function waitForSensingApi(page) {
  await page.waitForFunction(() => Boolean(window.webAgentSensing));
}

test("shows only the session controls, and nothing on the home page", async ({ page }) => {
  await page.goto(SITE);
  await waitForSensingApi(page);

  const panel = page.locator("#ultrasoundSensing");
  await expect(panel).toBeHidden();

  await page.locator('nav .links a[data-route="/forums"]').click();
  await expect(page).toHaveURL(/forums/);
  await expect(panel).toBeVisible();

  // The heading and the two session buttons are the whole visible panel.
  await expect(page.locator("#startSensingBtn")).toBeVisible();
  await expect(page.locator("#startSensingBtn")).toBeEnabled();
  await expect(page.locator("#downloadSensingSession")).toBeVisible();
  await expect(page.locator("#downloadSensingSession")).toBeDisabled();
  await expect(page.locator("#ultrasoundSensing details")).toBeHidden();
  await expect(page.locator("#recordingProfile")).toBeHidden();

  // The status lines stay in the DOM as role="status" live regions, clipped to
  // a pixel, so assistive technology still gets microphone and export errors.
  const clipped = await page.evaluate(() => ["startSensingHint", "micStatus", "fileStatus"]
    .map((id) => {
      const element = document.getElementById(id);
      const rect = element.getBoundingClientRect();
      return {
        id,
        inDom: true,
        role: element.getAttribute("role"),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    }));
  for (const status of clipped) {
    expect(status.role, `${status.id} stays a live region`).toBe("status");
    expect(status.width, `${status.id} is clipped`).toBeLessThanOrEqual(1);
    expect(status.height, `${status.id} is clipped`).toBeLessThanOrEqual(1);
  }
  // Still written to, even though it is not displayed.
  await expect(page.locator("#fileStatus")).toContainText("chirp ready");

  // Going back to the landing page hides it again.
  await page.locator('nav .links a[data-route="/"]').click();
  await expect(panel).toBeHidden();
});

test("keeps a running session reachable from the home page", async ({ page }) => {
  await installDurationLimitTimerTestHook(page);
  await page.goto(TASK_PAGE);
  await waitForSensingApi(page);

  const panel = page.locator("#ultrasoundSensing");
  const startButton = page.locator("#startSensingBtn");
  await startButton.click();
  await expect(startButton).toHaveText("Stop sensing");

  // Navigating home mid-session must not strand the recording: the panel stays
  // on screen so it can always be stopped.
  await page.locator('nav .links a[data-route="/"]').click();
  await expect(page).not.toHaveURL(/forums/);
  await expect(panel).toBeVisible();
  await expect(startButton).toHaveText("Stop sensing");

  await page.evaluate(() => window.__triggerDurationLimitForTest());
  await expect(startButton).toHaveText("Start sensing", { timeout: 60000 });

  // Once the session is over the landing page is clear again.
  await expect(panel).toBeHidden();
});

test("answers the requests a public deployment attracts", async ({ request }) => {
  // A HEAD request used to kill the connection thread outright, because the
  // handler read a robots.txt that did not exist. Crawlers and uptime checks
  // send HEAD before anything else.
  const head = await request.head("/");
  expect(head.status()).toBe(200);

  // The static lookup is scoped to a website version, so an unversioned
  // /robots.txt would otherwise fall through to the 404 page as text/html.
  const robots = await request.get("/robots.txt");
  expect(robots.ok()).toBe(true);
  expect(robots.headers()["content-type"]).toContain("text/plain");
  expect(await robots.text()).toContain("Disallow: /");
});

test("serves the chirp and sensing assets from the website server", async ({ request }) => {
  const health = await request.get("/healthz");
  expect(health.ok()).toBe(true);
  expect(await health.json()).toMatchObject({ ok: true });

  const chirp = await request.post("/api/send-wav");
  expect(chirp.ok()).toBe(true);
  expect(chirp.headers()["content-type"]).toBe("audio/wav");
  expect((await chirp.body()).subarray(0, 4).toString("ascii")).toBe("RIFF");

  for (const asset of [
    "sensing/sensing.js",
    "sensing/sensing.css",
    "sensing/recording-profile.js",
    "sensing/micro-doppler-visualization.js",
    "sensing/audio-frame-worklet.js"
  ]) {
    const response = await request.get(`${SITE}${asset}`);
    expect(response.ok(), `${asset} should be served`).toBe(true);
    // A module script served as text/html is rejected by the browser.
    expect(response.headers()["content-type"], `${asset} content type`)
      .toBe(asset.endsWith(".css") ? "text/css" : "text/javascript");
  }
});

test("requests unprocessed audio for the strict ultrasonic profile", async ({ page }) => {
  await page.goto(TASK_PAGE);
  await waitForSensingApi(page);

  // The picker is no longer on screen, so the profile comes from storage and
  // defaults to the strict one.
  expect(await page.evaluate(() => window.webAgentSensing.getRecordingProfile().id))
    .toBe("ultrasonic");
  expect(await page.evaluate(
    () => window.webAgentSensing.getRecordingProfile().requireProcessingControls
  )).toBe(true);

  const audio = await page.evaluate(
    () => window.webAgentRecordingProfiles
      .createMicrophoneRequest("ultrasonic").constraints.audio
  );
  // Browser voice processing would destroy the 19-24 kHz band, so the strict
  // profile pins each processing feature off rather than merely preferring it.
  expect(audio.echoCancellation).toEqual({ exact: false });
  expect(audio.noiseSuppression).toEqual({ exact: false });
  expect(audio.autoGainControl).toEqual({ exact: false });

  // The compatibility profile only prefers them off, so it can still open a
  // microphone on browsers that refuse the exact constraints.
  const compatibleAudio = await page.evaluate(
    () => window.webAgentRecordingProfiles
      .createMicrophoneRequest("compatible").constraints.audio
  );
  expect(compatibleAudio.echoCancellation).toBe(false);

  // Selecting it remains possible without the picker, which is how a run that
  // needs the fallback is configured.
  await page.evaluate(() => localStorage.setItem("webagentRecordingProfile", "compatible"));
  await page.reload();
  await waitForSensingApi(page);
  expect(await page.evaluate(() => window.webAgentSensing.getRecordingProfile().id))
    .toBe("compatible");
});

test("records, stops at the duration limit, and exports a session archive", async ({ page }, testInfo) => {
  await installDurationLimitTimerTestHook(page);

  const downloads = [];
  page.on("download", (download) => downloads.push(download));

  await page.goto(TASK_PAGE);
  await waitForSensingApi(page);

  const startButton = page.locator("#startSensingBtn");
  await expect(startButton).toHaveText("Start sensing");
  await expect(startButton).toHaveAttribute("aria-pressed", "false");

  await startButton.click();

  await expect(startButton).toHaveText("Stop sensing");
  await expect(startButton).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => window.webAgentSensing.isActive()))
    .toBe(true);
  await expect.poll(() => page.evaluate(() => window.webAgentSensing.isPlaybackActive()))
    .toBe(true);
  expect(await page.evaluate(() => window.webAgentSensing.getMaximumSensingDurationSeconds()))
    .toBe(40);
  expect(await page.evaluate(() => window.webAgentSensing.isDurationLimitTimerActive()))
    .toBe(true);

  // The session is tracked so exported metadata can be tied to the task pages.
  const session = await page.evaluate(() => window.webAgentSensing.getSession());
  expect(session).toMatchObject({ startPath: TASK_PAGE });
  expect(session.sessionId).toBeTruthy();

  // Capture at least a second of audio so the spectrogram and the exported WAV
  // are built from real frames rather than an almost-empty buffer.
  const sampleRate = await page.evaluate(
    () => window.webAgentSensing.getTargetSampleRate()
  );
  await expect.poll(
    () => page.evaluate(() => window.webAgentSensing.getRecordedFrameCount()),
    { timeout: 30000 }
  ).toBeGreaterThan(sampleRate);

  await page.evaluate(() => window.__triggerDurationLimitForTest());

  await expect(startButton).toHaveText("Start sensing", { timeout: 60000 });
  await expect(startButton).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.webAgentSensing.isActive())).toBe(false);

  const fileNames = await page.evaluate(
    () => window.webAgentSensing.getPreparedSessionFileNames()
  );
  expect(fileNames).toContain("metadata.json");
  expect(fileNames.some((name) => /^recording_\d{8}_\d{6}\.wav$/.test(name))).toBe(true);
  expect(fileNames.some((name) => /^recording_spectrogram_\d{8}_\d{6}\.png$/.test(name)))
    .toBe(true);

  const archiveName = await page.evaluate(
    () => window.webAgentSensing.getPreparedSessionArchiveName()
  );
  expect(archiveName).toMatch(/^ultrasound_localdev01_forums_\d{8}_\d{6}\.zip$/);

  await expect.poll(() => downloads.length, { timeout: 30000 }).toBeGreaterThan(0);
  const archiveDownload = downloads[downloads.length - 1];
  expect(archiveDownload.suggestedFilename()).toBe(archiveName);

  const archivePath = path.join(testInfo.outputDir, archiveDownload.suggestedFilename());
  await archiveDownload.saveAs(archivePath);
  const entries = readStoredZipEntries(archivePath);
  const entryNames = [...entries.keys()];

  expect(entryNames).toContain("metadata.json");
  const wavName = entryNames.find((name) => /^recording_\d{8}_\d{6}\.wav$/.test(name));
  expect(wavName).toBeTruthy();
  const wav = entries.get(wavName);
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
  // A second of 16-bit stereo audio is far larger than a bare header.
  expect(wav.length).toBeGreaterThan(sampleRate * 2);

  // These figures are rendered from canvases inside the hidden settings
  // disclosure, so they prove that hiding it did not break the export.
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const pattern of [
    /^recording_spectrogram_\d{8}_\d{6}\.png$/,
    /^recording_live_micro_doppler_left_\d{8}_\d{6}\.png$/,
    /^recording_live_micro_doppler_right_\d{8}_\d{6}\.png$/
  ]) {
    const name = entryNames.find((entry) => pattern.test(entry));
    expect(name, `${pattern} should be exported`).toBeTruthy();
    const png = entries.get(name);
    expect(png.subarray(0, 8), `${name} is a PNG`).toEqual(pngSignature);
    // A blank or zero-sized canvas would compress to almost nothing.
    expect(png.length, `${name} has image content`).toBeGreaterThan(1000);
  }

  const metadata = JSON.parse(entries.get("metadata.json").toString("utf8"));
  expect(metadata).toMatchObject({
    website_version: "LOCALDEV01",
    maximum_duration_sec: 40,
    recording_profile: "ultrasonic"
  });
  expect(metadata.sensing_session_id).toBe(session.sessionId);

  // The retry control must be usable if the automatic download was blocked.
  await expect(page.locator("#downloadSensingSession")).toBeEnabled();
  expect(fs.statSync(archivePath).size).toBeGreaterThan(0);
});
