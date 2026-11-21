import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Demo UI checks use fictional data and do not seed or exercise the real API gate.
export default defineConfig(base, {
  globalSetup: undefined,
  testMatch: ["**/demo-ux.spec.ts", "**/visual-polish.spec.ts", "**/deals.spec.ts", "**/email-and-safety.spec.ts", "**/invoices.spec.ts", "**/renewals-and-pipeline.spec.ts", "**/comment-leads.spec.ts", "**/rates-rights-proof.spec.ts"],
});
