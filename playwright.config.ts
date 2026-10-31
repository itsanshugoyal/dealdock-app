import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3100";

/**
 * Browser tests never mock DealDock's HTTP boundary. CI supplies a disposable
 * Postgres/Redis-backed API and enables the tightly-scoped local dev bridge.
 * Keeping the web server opt-in avoids accidentally launching a keyless app
 * against a developer's normal environment.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // tests mutate one explicit fixture org; never race approvals/sales across viewports
  forbidOnly: Boolean(process.env.CI),
  retries: 0, // Mutating a send or sale cannot safely be retried in the same fixture.
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
