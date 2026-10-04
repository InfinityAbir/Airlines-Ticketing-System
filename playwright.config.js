// Playwright E2E configuration (Phase 6).
// Two managed servers: the local Hardhat JSON-RPC node and a static file server for frontend/.
// Tests then deploy + seed their own deterministic demo dataset before exercising PRD §15.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 180_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  outputDir: "artifacts/playwright",
  use: {
    baseURL: "http://127.0.0.1:8080",
    viewport: { width: 1440, height: 960 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { args: ["--no-sandbox"] },
  },
  webServer: [
    {
      command: "npm run node",
      url: "http://127.0.0.1:8545",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "node tests/e2e/helpers/serve.mjs frontend 8080",
      url: "http://127.0.0.1:8080/index.html",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
