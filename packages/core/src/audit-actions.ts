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
  // Sales
  "ledger.created",
  "ledger.updated",
  "ledger.deleted",
  // Offers
  "offer.created",
  "offer.updated",
  "offer.deleted",
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
  "settings.voice_enabled",
  "settings.voice_disabled",
  "seat.invited",
  "seat.removed",
  "ig.disconnected",
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
