import { Prisma } from "@prisma/client";
import { DomainError, type VoiceRuleDto, type VoiceRuleScope, type VoiceRuleSource, type VoiceRuleStatus } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { requireIgAccountInOrg, requireSeatInOrg } from "../seat-scope";
import { hasVoiceConsent, lockConsentedVoiceProfile, lockVoiceProfile } from "../voice-consent";

/**
 * Writing-style rules per account (research 04 §3, §4.3). The evidence math
 * is pure and lives in @dealdock/ai: learning writes take a planner callback
 * that maps the current rows to the rows to write, and this repo supplies the
 * transaction, the consent lock and the pause/idempotency checks.
 */

export interface VoiceRuleExampleRecord {
  before: string;
  after: string;
  draftId?: string | null;
  threadId?: string | null;
}

export interface VoiceRuleRecord {
  id?: string;
  key: string;
  text: string;
  scope: VoiceRuleScope;
  status: VoiceRuleStatus;
  source: VoiceRuleSource;
  evidence: number;
  against: number;
  distinctDrafts: number;
  distinctThreads: number;
  creatorEvidence: number;
  examples: VoiceRuleExampleRecord[];
  lastEvidenceAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type StoredVoiceRule = VoiceRuleRecord & { id: string; createdAt: Date; updatedAt: Date };

type Row = Prisma.VoiceRuleGetPayload<object>;

function examplesOf(value: Prisma.JsonValue): VoiceRuleExampleRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const e = item as Record<string, unknown>;
    return [{
      before: typeof e.before === "string" ? e.before : "",
      after: typeof e.after === "string" ? e.after : "",
      draftId: typeof e.draftId === "string" ? e.draftId : null,
      threadId: typeof e.threadId === "string" ? e.threadId : null,
    }];
  });
}

function toRecord(row: Row): StoredVoiceRule {
  return {
    id: row.id,
    key: row.key,
    text: row.text,
    scope: row.scope as VoiceRuleScope,
    status: row.status,
    source: row.source,
    evidence: row.evidence,
    against: row.against,
    distinctDrafts: row.distinctDrafts,
    distinctThreads: row.distinctThreads,
    creatorEvidence: row.creatorEvidence,
    examples: examplesOf(row.examples),
    lastEvidenceAt: row.lastEvidenceAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** API shape: ≤ 3 before → after snippets (refs without text are bookkeeping only). */
export function toVoiceRuleDto(rule: StoredVoiceRule): VoiceRuleDto {
  return {
    id: rule.id,
    key: rule.key,
    text: rule.text,
    scope: rule.scope,
    status: rule.status,
    source: rule.source,
    evidence: Math.round(rule.evidence * 100) / 100,
    against: Math.round(rule.against * 100) / 100,
    examples: rule.examples.filter((e) => e.before || e.after).slice(0, 3).map(({ before, after }) => ({ before, after })),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

const STATUS_ORDER: Record<VoiceRuleStatus, number> = { pinned: 0, active: 1, candidate: 2, muted: 3 };

export async function listVoiceRules(orgId: OrgId, igAccountId: string, options: { statuses?: VoiceRuleStatus[] } = {}): Promise<StoredVoiceRule[]> {
  const rows = await prisma.voiceRule.findMany({
    where: { orgId, igAccountId, ...(options.statuses ? { status: { in: options.statuses } } : {}) },
  });
  return rows
    .map(toRecord)
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.evidence - a.evidence || a.key.localeCompare(b.key));
}

/**
 * A rule the creator wrote or confirmed ("Yes, keep it"): upserted by
 * (account, key, scope) as creator-owned, so it never changes by itself.
 * Every rule write holds the account's VoiceProfile lock and re-checks
 * consent under it, so revocation always wins.
 */
export async function createUserVoiceRule(
  orgId: OrgId,
  seatId: string,
  input: { igAccountId: string; key: string; text: string; scope: VoiceRuleScope; status: "active" | "pinned" }
): Promise<StoredVoiceRule> {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    await requireIgAccountInOrg(orgId, input.igAccountId, tx);
    await lockConsentedVoiceProfile(tx, orgId, input.igAccountId);
    const row = await tx.voiceRule.upsert({
      where: { igAccountId_key_scope: { igAccountId: input.igAccountId, key: input.key, scope: input.scope } },
      create: { orgId, igAccountId: input.igAccountId, key: input.key, text: input.text, scope: input.scope, status: input.status, source: "user" },
      update: { text: input.text, status: input.status, source: "user" },
    });
    await writeAudit(tx, {
      orgId, seatId, action: "voice.rule_created", entityType: "voice_rule", entityId: row.id, detail: { key: row.key, scope: row.scope, status: row.status },
    });
    return toRecord(row);
  });
}

/** Pin, mute, unmute, re-scope or reword a rule. Rewording makes it the creator's own. */
export async function updateVoiceRule(
  orgId: OrgId,
  seatId: string,
  ruleId: string,
  patch: { text?: string; status?: VoiceRuleStatus; scope?: VoiceRuleScope }
): Promise<StoredVoiceRule> {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    const rule = await tx.voiceRule.findFirst({ where: { id: ruleId, orgId }, select: { id: true, igAccountId: true, key: true, scope: true } });
    if (!rule) throw new DomainError("voice_rule_not_found", 404);
    await lockConsentedVoiceProfile(tx, orgId, rule.igAccountId);
    if (patch.scope && patch.scope !== rule.scope) {
      const clash = await tx.voiceRule.findFirst({ where: { orgId, igAccountId: rule.igAccountId, key: rule.key, scope: patch.scope }, select: { id: true } });
      if (clash) throw new DomainError("voice_rule_scope_conflict", 409);
    }
    const row = await tx.voiceRule.update({
      where: { id: rule.id },
      data: {
        ...(patch.text !== undefined ? { text: patch.text, source: "user" as const } : {}),
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.scope ? { scope: patch.scope } : {}),
      },
    });
    const action = patch.status === "pinned" ? "voice.rule_pinned" : patch.status === "muted" ? "voice.rule_muted" : "voice.rule_updated";
    await writeAudit(tx, {
      orgId, seatId, action, entityType: "voice_rule", entityId: row.id, detail: { key: row.key, scope: row.scope, status: row.status },
    });
    return toRecord(row);
  });
}

/** Delete (unlike mute) lets the habit be learned again later. */
export async function deleteVoiceRule(orgId: OrgId, seatId: string, ruleId: string): Promise<void> {
  await requireSeatInOrg(orgId, seatId);
  await prisma.$transaction(async (tx) => {
    const rule = await tx.voiceRule.findFirst({ where: { id: ruleId, orgId }, select: { id: true, igAccountId: true, key: true, scope: true } });
    if (!rule) throw new DomainError("voice_rule_not_found", 404);
    await lockVoiceProfile(tx, orgId, rule.igAccountId);
    await tx.voiceRule.delete({ where: { id: rule.id } });
    await writeAudit(tx, {
      orgId, seatId, action: "voice.rule_deleted", entityType: "voice_rule", entityId: rule.id, detail: { key: rule.key, scope: rule.scope },
    });
  });
}

/** Maps the account's current rules to the rows to write and stale ids to delete (pure, from @dealdock/ai). */
export type VoiceRulePlanner = (rules: StoredVoiceRule[]) => { upserts: VoiceRuleRecord[]; deletes: string[] };

export type VoiceLearningOutcome = "applied" | "no_consent" | "paused" | "already_learned" | "draft_not_found";

/**
 * The one learning write. Under the VoiceProfile row lock (shared with
 * revocation and every other rule write for the account): consent must hold;
 * a draft is learned at most once (learnedAt); while learning is paused
 * nothing changes and the send is marked learned so it is never replayed.
 */
export async function applyVoiceLearning(
  orgId: OrgId,
  igAccountId: string,
  input: {
    plan: VoiceRulePlanner;
    /** The sent draft this evidence came from (idempotency + editSignals). */
    draftId?: string;
    editSignals?: unknown;
    /** Set lastDistilledAt after a Claude batch distillation. */
    distilledAt?: Date;
  },
  now = new Date()
): Promise<{ outcome: VoiceLearningOutcome; changed: number }> {
  return prisma.$transaction(async (tx) => {
    const profile = await lockVoiceProfile(tx, orgId, igAccountId);
    if (!hasVoiceConsent(profile)) return { outcome: "no_consent", changed: 0 };
    if (input.draftId) {
      const draft = await tx.draft.findFirst({ where: { id: input.draftId, orgId, thread: { igAccountId } }, select: { id: true, learnedAt: true } });
      if (!draft) return { outcome: "draft_not_found", changed: 0 };
      if (draft.learnedAt) return { outcome: "already_learned", changed: 0 };
    }
    if (profile.learningPaused) {
      if (input.draftId) await tx.draft.update({ where: { id: input.draftId }, data: { learnedAt: now } });
      return { outcome: "paused", changed: 0 };
    }

    const rows = await tx.voiceRule.findMany({ where: { orgId, igAccountId } });
    const plan = input.plan(rows.map(toRecord));
    for (const rule of plan.upserts) {
      const data = {
        key: rule.key,
        text: rule.text.slice(0, 200),
        scope: rule.scope,
        status: rule.status,
        source: rule.source,
        evidence: Math.max(0, rule.evidence),
        against: Math.max(0, rule.against),
        distinctDrafts: Math.max(0, rule.distinctDrafts),
        distinctThreads: Math.max(0, rule.distinctThreads),
        creatorEvidence: Math.max(0, rule.creatorEvidence),
        examples: rule.examples as unknown as Prisma.InputJsonValue,
        lastEvidenceAt: rule.lastEvidenceAt,
      };
      if (rule.id) {
        await tx.voiceRule.updateMany({ where: { id: rule.id, orgId, igAccountId }, data });
      } else {
        await tx.voiceRule.upsert({
          where: { igAccountId_key_scope: { igAccountId, key: rule.key, scope: rule.scope } },
          create: { orgId, igAccountId, ...data },
          update: data,
        });
      }
    }
    if (plan.deletes.length) await tx.voiceRule.deleteMany({ where: { orgId, igAccountId, id: { in: plan.deletes } } });
    if (input.draftId) {
      await tx.draft.update({
        where: { id: input.draftId },
        data: { learnedAt: now, ...(input.editSignals === undefined ? {} : { editSignals: input.editSignals as Prisma.InputJsonValue }) },
      });
    }
    if (input.distilledAt) await tx.voiceProfile.update({ where: { id: profile.id }, data: { lastDistilledAt: input.distilledAt } });
    return { outcome: "applied", changed: plan.upserts.length };
  });
}
