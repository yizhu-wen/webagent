const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30000,
  expect: {
    timeout: 5000
  },
  webServer: {
    command: "python3 -m http.server 8010 --bind 127.0.0.1",
    url: "http://127.0.0.1:8010/",
    reuseExistingServer: !process.env.CI,
    timeout: 10000
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:8010/",
    acceptDownloads: true,
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream"
      ]
    }
  },
  reporter: [["list"], ["html", { open: "never" }]]
});
