import { expect, it } from "vitest";
import { FEATURE_FLAGS, featureFlags, isFeatureEnabled } from "../src/feature-flags";

it("uses each flag's default when its env var is unset", () => {
  expect(featureFlags({})).toEqual({ invoices: true, humanAgent: false, insights: false, commentLeads: false });
});

it("switches only on exactly \"true\" or \"false\"", () => {
  expect(isFeatureEnabled("invoices", { FEATURE_INVOICES_ENABLED: "false" })).toBe(false);
  expect(isFeatureEnabled("invoices", { FEATURE_INVOICES_ENABLED: "true" })).toBe(true);
  expect(isFeatureEnabled("commentLeads", { META_COMMENTS_ENABLED: "true" })).toBe(true);
  expect(isFeatureEnabled("commentLeads", { META_COMMENTS_ENABLED: "false" })).toBe(false);
});

it("keeps the default for junk values", () => {
  for (const junk of ["", "1", "0", "TRUE", "yes", " true", "off"]) {
    expect(isFeatureEnabled("invoices", { FEATURE_INVOICES_ENABLED: junk }), junk).toBe(true);
    expect(isFeatureEnabled("humanAgent", { META_HUMAN_AGENT_ENABLED: junk }), junk).toBe(false);
  }
});

it("keeps the Meta flags on their original env vars", () => {
  expect([FEATURE_FLAGS.humanAgent.env, FEATURE_FLAGS.insights.env, FEATURE_FLAGS.commentLeads.env]).toEqual(["META_HUMAN_AGENT_ENABLED", "META_INSIGHTS_ENABLED", "META_COMMENTS_ENABLED"]);
});
