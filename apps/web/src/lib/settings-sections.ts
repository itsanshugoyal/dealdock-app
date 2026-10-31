/**
 * The Settings page sections in page order: `id` is the section's anchor
 * (/settings#id), `label` its name in the page index and the command palette.
 * Kept out of the page module because app-router page files may not export
 * anything but the page.
 */
export const SETTINGS_SECTIONS = [
  { id: "instagram", label: "Instagram" },
  { id: "notifications", label: "Notifications" },
  { id: "region", label: "Follow-ups & region" },
  { id: "goal", label: "Monthly goal" },
  { id: "skip", label: "People to skip" },
  { id: "team", label: "Team" },
  { id: "plan", label: "Plan" },
  { id: "appearance", label: "Appearance" },
  { id: "data", label: "Your data" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
