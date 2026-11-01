import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Demo UI checks use fictional data and do not seed or exercise the real API gate.
export default defineConfig(base, {
  globalSetup: undefined,
  testMatch: "**/demo-ux.spec.ts",
});
