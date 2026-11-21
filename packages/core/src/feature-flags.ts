/**
 * The one feature-flag registry (see AGENTS.md "Feature flags"). The server
 * reads it from its env; the web reads the API's `features` snapshot (GET
 * /dashboard), never env. Each flag: its env var, a safe default, one line on
 * what it gates. Remove a flag once its feature is fully rolled out.
 */
export const FEATURE_FLAGS = {
  invoices: {
    env: "FEATURE_INVOICES_ENABLED",
    default: true,
    description: "GST/VAT invoices: billing details, issuing, PDFs and invoice cover notes. Off in production until a chartered accountant signs off.",
  },
  humanAgent: {
    env: "META_HUMAN_AGENT_ENABLED",
    default: false,
    description: "Instagram's 7-day HUMAN_AGENT reply window. Meta must approve the tag for this app first.",
  },
  insights: {
    env: "META_INSIGHTS_ENABLED",
    default: false,
    description: "\"Fetch from Instagram\" for post results; needs instagram_business_manage_insights through Meta App Review.",
  },
  commentLeads: {
    env: "META_COMMENTS_ENABLED",
    default: false,
    description: "Comment leads: the comments OAuth scope, webhook subscription and processing; needs instagram_business_manage_comments approved.",
  },
} as const satisfies Record<string, { env: string; default: boolean; description: string }>;

export type FeatureName = keyof typeof FEATURE_FLAGS;
export type FeatureFlags = Record<FeatureName, boolean>;
type Env = Record<string, string | undefined>;

export const FEATURE_NAMES = Object.keys(FEATURE_FLAGS) as FeatureName[];

/** Exactly "true" or "false" switches a flag; anything else (unset, "1", "TRUE") keeps its default. */
export function isFeatureEnabled(name: FeatureName, env: Env = process.env): boolean {
  const value = env[FEATURE_FLAGS[name].env];
  return value === "true" ? true : value === "false" ? false : FEATURE_FLAGS[name].default;
}

/** Every flag at once: what the API sends the web as `features`. `{}` gives the defaults. */
export function featureFlags(env: Env = process.env): FeatureFlags {
  return Object.fromEntries(FEATURE_NAMES.map((name) => [name, isFeatureEnabled(name, env)])) as FeatureFlags;
}
