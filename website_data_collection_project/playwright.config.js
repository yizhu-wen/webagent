const path = require("path");
const { defineConfig, devices } = require("@playwright/test");

// Playwright's own Chromium is optional here: set this to a local Chrome/Edge
// binary to run the suite without downloading a browser bundle.
const browserExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

// A dedicated port and upload directory keep the suite from touching a running
// development server or the collected recordings in ultrasound/uploads/.
const testPort = Number(process.env.SENSING_TEST_PORT || 34568);
const baseURL = `http://127.0.0.1:${testPort}/`;

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 90000,
  expect: {
    timeout: 10000
  },
  webServer: {
    command: `python honey_website/local_server.py -p ${testPort}`,
    url: `${baseURL}healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
    env: {
      SENSING_UPLOAD_DIR: path.join(__dirname, "test-results", "sensing-uploads")
    }
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    acceptDownloads: true,
    launchOptions: {
      ...(browserExecutablePath ? { executablePath: browserExecutablePath } : {}),
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required"
      ]
    }
  },
  reporter: [["list"], ["html", { open: "never" }]]
});
