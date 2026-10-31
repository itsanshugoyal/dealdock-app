import { prisma } from "../client";
import { Prisma } from "@prisma/client";
import { DomainError, type ClassificationLabel, type MessageOrigin, type SeatRole, type StyleCard, type VoiceMetrics } from "@dealdock/core";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { requireIgAccountInOrg, requireSeatInOrg } from "../seat-scope";
import { hasVoiceConsent, lockConsentedVoiceProfile, lockVoiceProfile } from "../voice-consent";
import { sentEditRatio, voiceMatchPct } from "../voice-match";
import { startOfZonedWeek } from "../zoned-time";
import { applyVoiceLearning, type StoredVoiceRule, type VoiceRulePlanner } from "./voice-rules";

export { hasVoiceConsent };

/**
 * The account a voice request is about: the given id (must belong to the org,
 * else `ig_account_not_in_org` → 404) or the org's first active account, then
 * any account. Null only when the org has no account at all.
 */
export async function resolveVoiceAccount(orgId: OrgId, igAccountId?: string | null): Promise<{ id: string; handle: string } | null> {
  const select = { id: true, handle: true } as const;
  const orderBy = [{ connectedAt: "asc" as const }, { id: "asc" as const }];
  if (igAccountId) {
    const account = await prisma.igAccount.findFirst({ where: { id: igAccountId, orgId }, select });
    if (!account) throw new DomainError("ig_account_not_in_org", 404);
    return account;
  }
  return (
    (await prisma.igAccount.findFirst({ where: { orgId, status: "active" }, orderBy, select })) ??
    (await prisma.igAccount.findFirst({ where: { orgId }, orderBy, select }))
  );
}

export async function listVoiceAccounts(orgId: OrgId) {
  return prisma.igAccount.findMany({ where: { orgId }, orderBy: [{ connectedAt: "asc" }, { id: "asc" }], select: { id: true, handle: true } });
}

/**
 * Consented sent-DM samples for voice modeling (PRD §6.4). Only outbound text,
 * never empty, never a message the creator excluded or an automation blast,
 * and only after the creator's durable explicit consent.
 */
export async function getSentSamples(orgId: OrgId, igAccountId: string, limit = 30) {
  const profile = await prisma.voiceProfile.findFirst({
    where: { orgId, igAccountId },
    select: { enabled: true, consentedAt: true, revokedAt: true, version: true, excludedMessageIds: true },
  });
  if (!profile || !hasVoiceConsent(profile)) return null;

  const messages = await prisma.message.findMany({
    where: {
      orgId,
      direction: "outbound",
      contentType: "text",
      text: { not: "" },
      thread: { igAccountId },
      id: { notIn: profile.excludedMessageIds },
      OR: [{ origin: null }, { origin: { not: "automation" } }],
    },
    orderBy: { sentAt: "desc" },
    take: limit,
    select: { id: true, text: true },
  });
  return { samples: messages, consentVersion: profile.version };
}

/** One outbound text message with its provenance and what it answered (the learner's CorpusMessage). */
export interface VoiceCorpusRow {
  messageId: string;
  threadId: string;
  text: string;
  sentAt: Date;
  origin: MessageOrigin;
  label: ClassificationLabel | null;
  draftKind: "reply" | "nudge" | null;
  editRatio: number | null;
  seatRole: SeatRole | null;
  inboundText: string | null;
}

/**
 * Newest outbound text messages for one account, each joined with: the draft
 * it was sent from (a linked draft always means origin "dealdock", whatever a
 * racing echo recorded) and its edit ratio, the approving seat's role, and
 * the inbound message it answered (text or voice-note transcript) with that
 * message's (reviewed) label. Ignored handles never contribute. Not
 * consent-gated: callers check.
 */
export async function loadVoiceCorpus(orgId: OrgId, igAccountId: string, limit = 400): Promise<VoiceCorpusRow[]> {
  const take = Math.max(1, Math.min(1000, Math.floor(limit)));
  // The draft's edit columns come back raw: its ratio is sentEditRatio's, the
  // one every voice-match number uses, never a second formula in SQL.
  const rows = await prisma.$queryRaw<Array<Omit<VoiceCorpusRow, "editRatio"> & {
    draftBody: string | null;
    draftEditDistance: number | null;
    draftEditRatio: number | null;
  }>>`
    SELECT m."id" AS "messageId", m."threadId", m."text", m."sentAt",
      CASE WHEN d."id" IS NOT NULL THEN 'dealdock' ELSE COALESCE(m."origin"::text, 'native') END AS "origin",
      COALESCE(d."label"::text, COALESCE(c."overrideLabel", c."label")::text, t."topLabel"::text) AS "label",
      d."kind"::text AS "draftKind",
      d."body" AS "draftBody", d."editDistance" AS "draftEditDistance", d."editRatio" AS "draftEditRatio",
      s."role"::text AS "seatRole",
      NULLIF(COALESCE(NULLIF(btrim(prev."text"), ''), prev."transcript"), '') AS "inboundText"
    FROM "Message" m
    JOIN "Thread" t ON t."id" = m."threadId" AND t."orgId" = m."orgId"
    LEFT JOIN "Draft" d ON d."sentMessageId" = m."id"
    LEFT JOIN "Seat" s ON s."id" = d."sentBySeatId"
    LEFT JOIN LATERAL (
      SELECT i."id", i."text", i."transcript" FROM "Message" i
      WHERE i."orgId" = m."orgId" AND i."threadId" = m."threadId" AND i."direction" = 'inbound' AND i."sentAt" <= m."sentAt"
      ORDER BY i."sentAt" DESC, i."id" DESC
      LIMIT 1
    ) prev ON TRUE
    LEFT JOIN "Classification" c ON c."messageId" = prev."id"
    WHERE m."orgId" = ${orgId} AND t."igAccountId" = ${igAccountId}
      AND m."direction" = 'outbound' AND m."contentType" = 'text' AND btrim(m."text") <> ''
      AND NOT EXISTS (
        SELECT 1 FROM "IgnoreListEntry" g
        WHERE g."orgId" = m."orgId" AND (g."igAccountId" IS NULL OR g."igAccountId" = t."igAccountId")
          AND g."handle" = lower(regexp_replace(t."participantHandle", '^@', ''))
      )
    ORDER BY m."sentAt" DESC, m."id" DESC
    LIMIT ${take}::int`;
  return rows.map(({ draftBody, draftEditDistance, draftEditRatio, ...row }) => ({
    ...row,
    editRatio: draftBody === null ? null : sentEditRatio({ body: draftBody, editDistance: draftEditDistance, editRatio: draftEditRatio }),
  }));
}

export interface VoiceProfileState {
  igAccountId: string;
  consent: { granted: boolean; consentedAt: Date | null; revokedAt: Date | null };
  learningPaused: boolean;
  refreshedAt: Date | null;
  lastDistilledAt: Date | null;
  styleCard: Record<string, unknown> | null;
  styleOverrides: Partial<StyleCard>;
  excludedMessageIds: string[];
  /** Consent version; saveStyleCard refuses a card computed under an older one. */
  version: number;
}

export async function getVoiceProfileState(orgId: OrgId, igAccountId: string): Promise<VoiceProfileState> {
  const profile = await prisma.voiceProfile.findFirst({ where: { orgId, igAccountId } });
  const granted = hasVoiceConsent(profile);
  return {
    igAccountId,
    consent: { granted, consentedAt: profile?.consentedAt ?? null, revokedAt: profile?.revokedAt ?? null },
    learningPaused: profile?.learningPaused ?? false,
    refreshedAt: profile?.refreshedAt ?? null,
    lastDistilledAt: profile?.lastDistilledAt ?? null,
    // A card is voice-derived data: never surfaced without consent.
    styleCard: granted ? ((profile?.styleCard as Record<string, unknown> | null) ?? null) : null,
    styleOverrides: granted ? ((profile?.styleOverrides as Partial<StyleCard> | null) ?? {}) : {},
    excludedMessageIds: profile?.excludedMessageIds ?? [],
    version: profile?.version ?? 0,
  };
}

export async function saveStyleCard(
  orgId: OrgId,
  igAccountId: string,
  styleCard: Record<string, unknown>,
  sampleMessageIds: string[],
  expectedConsentVersion: number
) {
  return prisma.$transaction(async (tx) => {
    // Revocation updates this same row. Lock before checking consent so a
    // refresh either commits first and is cleared by revocation, or observes
    // revocation and refuses to restore the discarded samples.
    const profile = await lockVoiceProfile(tx, orgId, igAccountId);
    if (!profile) throw new DomainError("voice profile not found", 404);
    if (!hasVoiceConsent(profile)) throw new DomainError("voice_consent_required", 409);
    if (profile.version !== expectedConsentVersion) throw new DomainError("voice_consent_changed", 409);
    return tx.voiceProfile.update({
      where: { id: profile.id },
      data: { styleCard: styleCard as never, sampleMessageIds, version: profile.version + 1, refreshedAt: new Date() },
    });
  });
}

/**
 * Explicit, auditable opt-in/out for sampling sent DMs. Revocation wipes every
 * voice-derived artifact for THIS account in the same transaction: card,
 * samples, learned and authored rules, draft feedback, exclusions, hand edits
 * and the draft provenance (generation context, edit signals); live drafts are
 * discarded. A sibling Roster account is untouched.
 */
export async function setVoiceConsent(
  orgId: OrgId,
  igAccountId: string,
  seatId: string,
  consented: boolean
) {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    await requireIgAccountInOrg(orgId, igAccountId, tx);

    const now = new Date();
    const profile = await tx.voiceProfile.upsert({
      where: { igAccountId },
      create: {
        orgId,
        igAccountId,
        enabled: consented,
        consentedAt: consented ? now : null,
        revokedAt: consented ? null : now,
        sampleMessageIds: [],
      },
      update: consented
        ? { enabled: true, consentedAt: now, revokedAt: null, version: { increment: 1 } }
        : {
            enabled: false,
            revokedAt: now,
            styleCard: Prisma.JsonNull,
            sampleMessageIds: [],
            excludedMessageIds: [],
            styleOverrides: Prisma.DbNull,
            version: { increment: 1 },
          },
    });
    if (!consented) {
      await tx.draft.updateMany({where:{orgId,thread:{igAccountId},status:{in:["ready","edited"]}},data:{status:"discarded"}});
      await tx.voiceRule.deleteMany({ where: { orgId, igAccountId } });
      await tx.draftFeedback.deleteMany({ where: { orgId, draft: { thread: { igAccountId } } } });
      await tx.draft.updateMany({
        where: { orgId, thread: { igAccountId }, OR: [{ generationContext: { not: Prisma.DbNull } }, { editSignals: { not: Prisma.DbNull } }] },
        data: { generationContext: Prisma.DbNull, editSignals: Prisma.DbNull },
      });
    }
    await writeAudit(tx, {
      orgId,
      seatId,
      action: consented ? "voice.consent_granted" : "voice.consent_revoked",
      entityType: "voice_profile",
      entityId: profile.id,
    });
    return profile;
  });
}

/** Creator-owned edits to the style card (PUT replaces the whole override object). */
export async function setStyleOverrides(orgId: OrgId, seatId: string, igAccountId: string, overrides: Partial<StyleCard>) {
  await requireSeatInOrg(orgId, seatId);
  await prisma.$transaction(async (tx) => {
    const profile = await lockConsentedVoiceProfile(tx, orgId, igAccountId);
    await tx.voiceProfile.update({ where: { id: profile.id }, data: { styleOverrides: overrides as never } });
    await writeAudit(tx, {
      orgId, seatId, action: "voice.style_overridden", entityType: "voice_profile", entityId: profile.id, detail: { keys: Object.keys(overrides) },
    });
  });
}

/** "Not me" on one sample (Voice Studio): the message stops counting as style evidence. */
export async function setSampleExcluded(orgId: OrgId, seatId: string, igAccountId: string, messageId: string, excluded: boolean) {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    const message = await tx.message.findFirst({
      where: { id: messageId, orgId, direction: "outbound", thread: { igAccountId } },
      select: { id: true },
    });
    if (!message) throw new DomainError("sample_not_found", 404);
    const profile = await lockConsentedVoiceProfile(tx, orgId, igAccountId);
    const current = new Set(profile.excludedMessageIds);
    if (excluded) current.add(messageId);
    else current.delete(messageId);
    await tx.voiceProfile.update({ where: { id: profile.id }, data: { excludedMessageIds: [...current] } });
    await writeAudit(tx, {
      orgId, seatId, action: excluded ? "voice.sample_excluded" : "voice.sample_included", entityType: "message", entityId: messageId,
    });
    return { excluded };
  });
}

/** Pause/resume learning: drafts keep using existing rules; no new evidence while paused. */
export async function setLearningPaused(orgId: OrgId, seatId: string, igAccountId: string, paused: boolean) {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    const profile = await tx.voiceProfile.findFirst({ where: { orgId, igAccountId }, select: { id: true } });
    if (!profile) throw new DomainError("voice_profile_not_found", 404);
    await tx.voiceProfile.update({ where: { id: profile.id }, data: { learningPaused: paused } });
    await writeAudit(tx, {
      orgId, seatId, action: paused ? "voice.learning_paused" : "voice.learning_resumed", entityType: "voice_profile", entityId: profile.id,
    });
    return { paused };
  });
}

const WEEKS = 8;

/**
 * Voice Studio metrics from sent drafts of one account over the last 8 weeks
 * of the org's calendar (Monday-to-Monday in its timezone, as Insights):
 * voice match (voice-match.ts), sent as-is, mean edit ratio, weekly trend and
 * per-label split (nudges separately). Percentages are 0–100; null with no
 * sends — the UI decides how many sends it needs before showing a number.
 * A week's `weekStart` is the instant its local Monday begins.
 */
export async function getVoiceMetrics(orgId: OrgId, igAccountId: string, now = new Date()): Promise<VoiceMetrics> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
  if (!org) throw new DomainError("org_not_found", 404);
  // WEEKS + 1 boundaries: the last one is next Monday, the end of this week.
  const bounds = Array.from({ length: WEEKS + 1 }, (_, i) => startOfZonedWeek(now, org.timezone, WEEKS - 1 - i));
  const drafts = await prisma.draft.findMany({
    where: { orgId, status: "sent", thread: { igAccountId }, sentAt: { gte: bounds[0]! } },
    select: { sentAt: true, editRatio: true, editDistance: true, body: true, label: true, kind: true },
  });
  const sent = drafts.flatMap((d) => {
    const ratio = sentEditRatio(d);
    return ratio === null || !d.sentAt ? [] : [{ ...d, sentAt: d.sentAt, ratio }];
  });
  const matchPct = (rows: typeof sent) => voiceMatchPct(rows.map((r) => r.ratio));
  const weekly = bounds.slice(0, WEEKS).map((start, i) => {
    const end = bounds[i + 1]!;
    const rows = sent.filter((r) => r.sentAt >= start && r.sentAt < end);
    return { weekStart: start.toISOString(), sent: rows.length, voiceMatchPct: matchPct(rows) };
  });
  const groups = new Map<ClassificationLabel | "nudge", typeof sent>();
  for (const row of sent) {
    const key = row.kind === "nudge" ? "nudge" : row.label;
    if (key) groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return {
    sentCount: sent.length,
    voiceMatchPct: matchPct(sent),
    sentAsIsPct: sent.length ? Math.round((sent.filter((r) => r.ratio === 0).length / sent.length) * 100) : null,
    avgEditRatio: sent.length ? Math.round((sent.reduce((sum, r) => sum + r.ratio, 0) / sent.length) * 1000) / 1000 : null,
    weekly,
    byLabel: [...groups].map(([label, rows]) => ({ label, sent: rows.length, voiceMatchPct: matchPct(rows) })),
  };
}

export const VOICE_LEARN_OUTBOX_KIND = "voice.learn";
export const VOICE_REFRESH_OUTBOX_KIND = "voice.refresh";

/**
 * Ask the worker to re-measure this account's voice (style card + seed rules).
 * `delayMs` holds the row back (the dispatcher only leases rows whose lease
 * time has passed) so e.g. a just-scheduled history scan can land first.
 */
export async function enqueueVoiceRefresh(orgId: OrgId, igAccountId: string, options: { reason: string; delayMs?: number }) {
  await requireIgAccountInOrg(orgId, igAccountId);
  const now = Date.now();
  return prisma.outboxEvent.create({
    data: {
      orgId,
      kind: VOICE_REFRESH_OUTBOX_KIND,
      dedupeKey: `${VOICE_REFRESH_OUTBOX_KIND}:${igAccountId}:${options.reason}:${now}:${Math.random().toString(36).slice(2, 10)}`,
      payload: { orgId, igAccountId, reason: options.reason },
      ...(options.delayMs ? { leaseExpiresAt: new Date(now + options.delayMs) } : {}),
    },
    select: { id: true },
  });
}

/**
 * SYSTEM CONTEXT (cross-org, scheduler only): accounts whose weekly voice
 * refresh is due — consented, enabled, learning not paused, with at least
 * `minSamples` outbound text messages (the consumer applies the full filter).
 */
export async function listVoiceRefreshCandidates(minSamples = 3, limit = 500) {
  const profiles = await prisma.voiceProfile.findMany({
    where: { enabled: true, consentedAt: { not: null }, revokedAt: null, learningPaused: false },
    select: { orgId: true, igAccountId: true },
    orderBy: { refreshedAt: { sort: "asc", nulls: "first" } },
    take: limit,
  });
  const out: Array<{ orgId: string; igAccountId: string }> = [];
  for (const profile of profiles) {
    const count = await prisma.message.count({
      where: { orgId: profile.orgId, direction: "outbound", contentType: "text", thread: { igAccountId: profile.igAccountId } },
    });
    if (count >= minSamples) out.push(profile);
  }
  return out;
}

/**
 * "manual": the creator asked (Voice Studio refresh, resample, or a refresh
 * the API handed to the worker). "automatic": consent, a history scan or the
 * weekly tick.
 */
export type VoiceRefreshMode = "manual" | "automatic";

/** What refreshVoiceProfile reads from a plan; @dealdock/ai's VoiceRefreshPlan fits. */
export interface VoiceRefreshPlanShape {
  /** Usable samples, compared with `minSamples`. */
  eligibleCount: number;
  /** The messages the card is computed from, stored on the profile. */
  sampleIds: string[];
}

/** The @dealdock/ai steps of a refresh as callbacks, in the order they run (this package runs no model code). */
export interface VoiceRefreshSteps<Plan extends VoiceRefreshPlanShape> {
  mode: VoiceRefreshMode;
  /** Select and measure the samples (ai planVoiceRefresh). */
  plan: (corpus: VoiceCorpusRow[], excludedMessageIds: string[]) => Plan;
  /** Fewest usable samples worth learning from (ai MIN_VOICE_SAMPLES). */
  minSamples: number;
  /** More usable samples than this stops before extraction as "deferred": the API queues those for the worker. */
  maxInlineSamples?: number;
  /** The descriptive card (ai extractStyleCard): the slow, model-backed step, run outside any transaction. */
  extract: (plan: Plan) => Promise<{ styleCard: Record<string, unknown>; modelVersion: string }>;
  /** The card to store (ai composeStyleCard). */
  compose: (styleCard: Record<string, unknown>, plan: Plan, now: Date) => Record<string, unknown>;
  /** Re-seed the "samples" rules (ai planSeedRules), written through applyVoiceLearning. */
  seed: (rules: StoredVoiceRule[], plan: Plan, now: Date) => ReturnType<VoiceRulePlanner>;
}

export type VoiceRefreshResult =
  | { status: "no_consent" }
  /** An automatic refresh while learning is paused: nothing read or written. */
  | { status: "paused" }
  | { status: "not_enough_samples"; sampleCount: number }
  /** Too many samples to refresh inline; `styleCard` is the stored (consented) card. */
  | { status: "deferred"; sampleCount: number; styleCard: Record<string, unknown> | null }
  /** `seeded`: rules written (0 while learning is paused). */
  | { status: "refreshed"; sampleCount: number; styleCard: Record<string, unknown>; modelVersion: string; seeded: number };

/**
 * Re-measure an account's voice from its own messages: samples → card →
 * saved (refused if consent changed meanwhile) → "samples" rules re-seeded.
 * The one implementation behind the API's refresh and the worker's. Pause:
 * an automatic refresh does nothing while learning is paused; a manual one
 * still re-measures the card, but no refresh seeds rules while paused.
 */
export async function refreshVoiceProfile<Plan extends VoiceRefreshPlanShape>(
  orgId: OrgId,
  igAccountId: string,
  steps: VoiceRefreshSteps<Plan>,
  now = new Date(),
): Promise<VoiceRefreshResult> {
  const state = await getVoiceProfileState(orgId, igAccountId);
  if (!state.consent.granted) return { status: "no_consent" };
  if (steps.mode === "automatic" && state.learningPaused) return { status: "paused" };
  const plan = steps.plan(await loadVoiceCorpus(orgId, igAccountId), state.excludedMessageIds);
  const sampleCount = plan.eligibleCount;
  if (sampleCount < steps.minSamples) return { status: "not_enough_samples", sampleCount };
  if (steps.maxInlineSamples !== undefined && sampleCount > steps.maxInlineSamples) {
    return { status: "deferred", sampleCount, styleCard: state.styleCard };
  }
  const extracted = await steps.extract(plan);
  const styleCard = steps.compose(extracted.styleCard, plan, now);
  await saveStyleCard(orgId, igAccountId, styleCard, plan.sampleIds, state.version);
  // applyVoiceLearning re-checks the pause under the profile lock, so a pause
  // that lands mid-refresh also leaves the rules alone.
  const seeded = state.learningPaused
    ? 0
    : (await applyVoiceLearning(orgId, igAccountId, { plan: (rules) => steps.seed(rules, plan, now) }, now)).changed;
  return { status: "refreshed", sampleCount, styleCard, modelVersion: extracted.modelVersion, seeded };
}
