/**
 * The Settings page sections in page order: `id` is the section's anchor
 * (/settings#id), `label` its name in the page index and the command palette,
 * `feature` the registry flag that hides it everywhere while off.
 * Kept out of the page module because app-router page files may not export
 * anything but the page.
 */
import type { FeatureFlags } from "@dealdock/core";

export const SETTINGS_SECTIONS = [
  { id: "instagram", label: "Instagram" },
  { id: "email", label: "Email" },
  { id: "comment-leads", label: "Comment leads" },
  { id: "business", label: "What you sell" },
  { id: "billing", label: "Billing details", feature: "invoices" },
  { id: "tools", label: "Booking and payment links" },
  { id: "notifications", label: "Notifications" },
  { id: "region", label: "Follow-ups & region" },
  { id: "goal", label: "Monthly goal" },
  { id: "skip", label: "People to skip" },
  { id: "team", label: "Team" },
  { id: "plan", label: "Plan" },
  { id: "appearance", label: "Appearance" },
  { id: "data", label: "Your data" },
] as const;

/** The sections this workspace has: the page, its index and the palette all list these. */
export function visibleSettingsSections(features: FeatureFlags) {
  return SETTINGS_SECTIONS.filter((section) => !("feature" in section) || features[section.feature]);
}

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
