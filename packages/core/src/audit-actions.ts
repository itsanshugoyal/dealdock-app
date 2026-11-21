/**
 * Every action string the backend writes to the audit log (AuditLog.action),
 * so the Activity screen can describe each one and the demo store records
 * the same names. AuditRow.action stays a plain string on the wire: rows
 * written before an action was renamed, or by a newer API, must still render.
 */
export const AUDIT_ACTIONS = [
  // Replies and sorting
  "message.sent",
  "classification.reviewed",
  "thread.state_changed",
  "nudge.dismissed",
  // Coach pipeline: a stage set by hand (or moved by a tool that reported back), a reported payment matched or dismissed
  "thread.lead_stage_changed",
  "lead_event.matched",
  "lead_event.dismissed",
  // Comment leads: a private reply sent or skipped, expired leads cleared
  "comment_lead.sent",
  "comment_lead.skipped",
  "comment_lead.cleared",
  // Sales
  "ledger.created",
  "ledger.updated",
  "ledger.deleted",
  // Deals
  "deal.created",
  "deal.updated",
  "deal.paid",
  "deal.deleted",
  // Renewal prompts: "Not now" on pitching a brand again, or the pitch copied to send outside DealDock
  "deal.renewal_dismissed",
  "deal.renewal_copied",
  // Invoices
  "invoice.created",
  "invoice.voided",
  "invoice.paid",
  "billing.updated",
  // Offers
  "offer.created",
  "offer.updated",
  "offer.deleted",
  // The private rate-card link: made (or replaced, which ends the old one) and turned off
  "rate_card.link_created",
  "rate_card.link_turned_off",
  // Writing voice
  "voice.consent_granted",
  "voice.consent_revoked",
  "voice.learning_paused",
  "voice.learning_resumed",
  "voice.style_overridden",
  "voice.sample_excluded",
  "voice.sample_included",
  "voice.rule_created",
  "voice.rule_updated",
  "voice.rule_pinned",
  "voice.rule_muted",
  "voice.rule_deleted",
  // Speaking voice
  "voice.clone_created",
  "voice.clone_failed",
  "voice.clone_revoked",
  "voice.disclosure_enabled",
  "voice.disclosure_disabled",
  // Settings, team and account
  "organization.created",
  "onboarding.profile_saved",
  "settings.region_changed",
  "settings.goal_changed",
  "settings.ignore_list_changed",
  "settings.comment_keywords_changed",
  "settings.voice_enabled",
  "settings.voice_disabled",
  "seat.invited",
  "seat.removed",
  "ig.disconnected",
  "email.disconnected",
  "lead_source.connected",
  "lead_source.removed",
  "billing.cancel_requested",
  "account.deletion_requested",
  "account.deletion_cancelled",
  // System (no seat): scheduler bookkeeping
  "nudge.due",
  "digest.weekly_sent",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}
