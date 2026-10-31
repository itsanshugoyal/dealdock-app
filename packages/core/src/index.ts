import { z } from "zod";

export * from "./money";
export * from "./edit-distance";
export * from "./permissions";
export * from "./redis";
export * from "./push-endpoint";
export * from "./money-input";
export type * from "./api-types";
export * from "./reply-window";
export * from "./deal-signals";
export * from "./catalog";
export * from "./nudges";
export * from "./high-value";
export * from "./speaking-voice";
export * from "./audit-actions";
export * from "./errors";

/**
 * @dealdock/core — domain types, zod schemas, shared constants.
 * The leaf package: depends on nothing internal. See ARCHITECTURE.md §2.
 */

// ── Classification (PRD §6.2 — the 8 classes) ──────────────────────────────

export const CLASSIFICATION_LABELS = [
  "brand_deal",
  "coaching_lead",
  "course_inquiry",
  "other_commerce",
  "fan",
  "spam",
  "personal",
  "uncertain",
] as const;

export const ClassificationLabel = z.enum(CLASSIFICATION_LABELS);
export type ClassificationLabel = z.infer<typeof ClassificationLabel>;

/** Labels that get value estimation + reply drafts (high-intent commerce). */
export const HIGH_INTENT_LABELS: readonly ClassificationLabel[] = [
  "brand_deal",
  "coaching_lead",
  "course_inquiry",
  "other_commerce",
];

/** Below this confidence a message routes to the Review Queue, never the inbox (PRD §7.4). */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.8;

export const MessageLanguage = z.enum(["en", "hi", "hinglish", "mixed"]);
export type MessageLanguage = z.infer<typeof MessageLanguage>;

// ── Tiers & seats (PRD §6.1, §6.8, §8) ──────────────────────────────────────

export const Tier = z.enum(["solo", "studio", "roster"]);
export type Tier = z.infer<typeof Tier>;

export const SeatRole = z.enum(["creator", "assistant", "manager"]);
export type SeatRole = z.infer<typeof SeatRole>;

export const TIER_LIMITS: Record<Tier, { igAccounts: number; seats: number | null }> = {
  solo: { igAccounts: 1, seats: 1 },
  studio: { igAccounts: 1, seats: 2 },
  roster: { igAccounts: 5, seats: null }, // null = multiple manager seats, no hard cap in pilot
};

// ── Money — integer minor units, never floats (ARCHITECTURE.md §3, ADR-9) ──

export const MinorUnits = z.number().int().nonnegative().safe();
export type MinorUnits = z.infer<typeof MinorUnits>;

/** Estimated value range attached to a commerce classification (org currency). */
export const ValueRange = z.object({
  minMinor: MinorUnits,
  maxMinor: MinorUnits,
}).refine((range) => range.minMinor <= range.maxMinor, { message: "Minimum value cannot exceed maximum value." });
export type ValueRange = z.infer<typeof ValueRange>;

// ── Core message shapes (shared between messaging adapters, API, worker) ───

export const MessageDirection = z.enum(["inbound", "outbound"]);
export type MessageDirection = z.infer<typeof MessageDirection>;

export const ClassificationResult = z.object({
  label: ClassificationLabel,
  confidence: z.number().min(0).max(1),
  language: MessageLanguage,
  valueRange: ValueRange.nullable(),
  /** One-line model explanation — shown in Review cards and on badge tap (DESIGN.md principle 9). */
  rationale: z.string(),
  modelVersion: z.string(),
  promptVersion: z.string(),
});
export type ClassificationResult = z.infer<typeof ClassificationResult>;

export const ThreadState = z.enum(["open", "waiting", "closed"]);
export type ThreadState = z.infer<typeof ThreadState>;

export const DraftStatus = z.enum(["ready", "edited", "sending", "sent", "discarded"]);
export type DraftStatus = z.infer<typeof DraftStatus>;

// ── Queue names (single registry so api/worker never drift) ────────────────

export const QUEUES = {
  ingestion: "ingestion",
  classification: "classification",
  drafting: "drafting",
  backfill: "backfill",
  nudges: "nudges",
  notifications: "notifications",
  billing: "billing",
  retention: "retention",
  /** Writing-style learning: per-send edit learning, voice refresh, weekly refresh tick. */
  voiceLearning: "voice-learning",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

// ── Queue payload contracts (shared producer/consumer, zod-validated) ──────

export const IngestionJob = z.object({
  orgId: z.string(),
  igAccountId: z.string(),
  igThreadId: z.string(),
  participantHandle: z.string(),
  participantIgId: z.string(),
  igMessageId: z.string(),
  direction: MessageDirection,
  contentType: z.enum(["text", "audio", "attachment"]).default("text"),
  text: z.string(),
  /** ISO 8601 — BullMQ serializes to JSON. */
  sentAt: z.string().datetime(),
  /** live = webhook; leak_scan = onboarding backfill (PRD §5.1.6). */
  source: z.enum(["live", "leak_scan"]).default("live"),
  raw: z.unknown().optional(),
  /** Signed, expiring CDN URL of the first attachment; audio is downloaded by the worker on receipt (F8). */
  mediaUrl: z.string().min(1).max(4096).optional(),
  /** Instagram attachment type of that attachment ("audio", "image", "share", …). */
  mediaKind: z.string().min(1).max(40).optional(),
  /** Where the conversation started when Instagram says so — Thread.source (named apart from the ingestion `source`). */
  threadSource: z.enum(["dm", "story", "reel", "ad", "link"]).optional(),
});
export type IngestionJob = z.infer<typeof IngestionJob>;
