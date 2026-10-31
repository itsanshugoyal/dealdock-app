import { Queue, Worker, type Job } from "bullmq";
import { createHash } from "node:crypto";
import { z } from "zod";
import { QUEUES } from "@dealdock/core";
import {
  analyzeEdit,
  composeStyleCard,
  distillEditRules,
  draftScope,
  editEvidence,
  extractStyleCard,
  MIN_VOICE_SAMPLES,
  planRuleUpdates,
  planSeedRules,
  planVoiceRefresh,
  type RuleEvidence,
} from "@dealdock/ai";
import {
  applyVoiceLearning,
  asOrgId,
  countEditedSendsSince,
  getDraftForLearning,
  getVoiceProfileState,
  listDistillationBatch,
  listVoiceRefreshCandidates,
  listVoiceRules,
  loadVoiceCorpus,
  refreshVoiceProfile,
  type OrgId,
} from "@dealdock/db";
import { PIPELINE_JOB_OPTIONS, redisConnection } from "../connection";

export const VoiceLearnJob = z.object({ orgId: z.string(), draftId: z.string() });
export const VoiceRefreshJob = z.object({ orgId: z.string(), igAccountId: z.string(), reason: z.string().optional() });

const DISTILL_AFTER_EDITS = 5; // Fyxer's "batch of five" (research 04 §4.2)
const WEEK_MS = 7 * 24 * 60 * 60_000;

function ruleIdsOf(generationContext: unknown): string[] {
  const rules = (generationContext as { rules?: unknown } | null)?.rules;
  return Array.isArray(rules) ? rules.flatMap((r) => (typeof (r as { id?: unknown })?.id === "string" ? [(r as { id: string }).id] : [])) : [];
}

function signalTexts(editSignals: unknown): string[] {
  const signals = (editSignals as { signals?: unknown } | null)?.signals;
  return Array.isArray(signals) ? signals.flatMap((s) => (typeof (s as { text?: unknown })?.text === "string" ? [(s as { text: string }).text] : [])) : [];
}

/**
 * One human-approved send → deterministic edit signals → rule evidence (and
 * a check of the rules that shaped the draft against what was sent). Consent,
 * pause and once-per-draft are enforced inside applyVoiceLearning.
 */
export async function learnFromSend(data: z.infer<typeof VoiceLearnJob>, now = new Date()) {
  const orgId = asOrgId(data.orgId);
  const draft = await getDraftForLearning(orgId, data.draftId);
  if (!draft || draft.status !== "sent" || draft.finalText === null) return { skipped: "not_sent" };
  if (draft.learnedAt) return { skipped: "already_learned" };
  const finalText = draft.finalText;
  const seatRole = draft.sentBy?.role ?? null;
  // The ratio was measured at send; a legacy draft without one is measured here.
  const analysis = analyzeEdit(draft.body, finalText, draft.editRatio);
  const evidence = editEvidence(analysis, {
    scope: draftScope({ kind: draft.kind, label: draft.label }),
    draftId: draft.id,
    threadId: draft.threadId,
    seatRole,
  });
  const appliedRuleIds = ruleIdsOf(draft.generationContext);
  const result = await applyVoiceLearning(
    orgId,
    draft.thread.igAccountId,
    {
      draftId: draft.id,
      editSignals: {
        kind: analysis.kind,
        editRatio: analysis.editRatio,
        signals: analysis.signals.map(({ key, text, weight, before, after }) => ({ key, text, weight, before, after })),
      },
      plan: (rules) => planRuleUpdates(rules, evidence, now, { appliedRuleIds, finalText, draftId: draft.id, threadId: draft.threadId, seatRole }),
    },
    now
  );
  if (result.outcome !== "applied") return { outcome: result.outcome };
  const distilled = await distillIfDue(orgId, draft.thread.igAccountId, now);
  return { outcome: result.outcome, changed: result.changed, signals: analysis.signals.length, distilled };
}

/**
 * Claude batch distillation once ≥ 5 edited sends piled up since the last run
 * (only with a configured model). Claude proposes; each proposal becomes
 * evidence on the drafts it cites and the deterministic rules decide whether
 * anything activates. A failed call is retried at the next send.
 */
async function distillIfDue(orgId: OrgId, igAccountId: string, now: Date): Promise<number | false> {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.DRAFT_MODEL) return false;
  const profile = await getVoiceProfileState(orgId, igAccountId);
  if (!profile.consent.granted || profile.learningPaused) return false;
  if ((await countEditedSendsSince(orgId, igAccountId, profile.lastDistilledAt)) < DISTILL_AFTER_EDITS) return false;
  try {
    const [batch, rules, corpus] = await Promise.all([
      listDistillationBatch(orgId, igAccountId, profile.lastDistilledAt, 10),
      listVoiceRules(orgId, igAccountId, { statuses: ["active", "pinned", "candidate"] }),
      loadVoiceCorpus(orgId, igAccountId, 400),
    ]);
    const proposals = await distillEditRules(
      batch.map((d) => ({
        draftId: d.id,
        scope: draftScope({ kind: d.kind, label: d.label }),
        inboundText: d.inboundText,
        draft: d.body,
        sent: d.finalText,
        signals: signalTexts(d.editSignals),
      })),
      rules,
      corpus.filter((row) => row.origin === "native").map((row) => row.text)
    );
    const byDraft = new Map(batch.map((d) => [d.id, d]));
    const evidence: RuleEvidence[] = proposals.flatMap((proposal) =>
      proposal.draftIds.map((draftId) => ({
        key: proposal.key,
        text: proposal.text,
        scope: proposal.scope,
        polarity: 1 as const,
        weight: 1,
        source: "edits" as const,
        draftId,
        threadId: byDraft.get(draftId)?.threadId ?? null,
        seatRole: byDraft.get(draftId)?.sentBy?.role ?? null,
      }))
    );
    await applyVoiceLearning(orgId, igAccountId, { distilledAt: now, plan: (current) => planRuleUpdates(current, evidence, now) }, now);
    return proposals.length;
  } catch (error) {
    // Never log DM content: the error class/message only.
    console.error(`voice distillation failed for account ${igAccountId}: ${error instanceof Error ? error.name : "unknown error"}`);
    return false;
  }
}

/**
 * Re-measure an account's voice through db refreshVoiceProfile, the same
 * refresh the API runs: provenance-filtered samples → measured habits +
 * descriptive card (Claude, or the heuristic in dev) → StyleCard v2, then
 * re-seed the "samples" rules. Skipped without consent or below 3 usable
 * samples. Consent, history-scan and weekly refreshes also skip while
 * learning is paused; one the creator asked for (handed over by the API as
 * "manual") still re-measures the card then, but seeds no rules.
 */
export async function refreshVoice(data: z.infer<typeof VoiceRefreshJob>, now = new Date()) {
  const result = await refreshVoiceProfile(
    asOrgId(data.orgId),
    data.igAccountId,
    {
      mode: data.reason === "manual" ? "manual" : "automatic",
      minSamples: MIN_VOICE_SAMPLES,
      plan: planVoiceRefresh,
      extract: (plan) => extractStyleCard(plan.extractionTexts),
      compose: composeStyleCard,
      seed: (rules, plan, at) => planSeedRules(rules, plan.seeds, at),
    },
    now,
  );
  switch (result.status) {
    case "refreshed":
      return { refreshed: true, samples: result.sampleCount, rules: result.seeded };
    case "paused":
      return { skipped: "learning_paused" };
    default:
      // no_consent or not_enough_samples ("deferred" needs maxInlineSamples, which this never sets).
      return { skipped: result.status };
  }
}

/**
 * voice-learning queue: "voice.learn" / "voice.refresh" arrive from the DB
 * outbox (crash-safe hand-off from the send gate and consent changes); a
 * weekly "voice-refresh-tick" re-measures every consented, unpaused account
 * with enough samples. Pure learning — no send capability, no Graph access.
 */
export function startVoiceLearningWorker() {
  const queue = new Queue(QUEUES.voiceLearning, { connection: redisConnection(), defaultJobOptions: PIPELINE_JOB_OPTIONS });
  void queue
    .upsertJobScheduler("voice-refresh-tick", { every: WEEK_MS }, { name: "voice-refresh-tick" })
    .catch((error: Error) => console.error(`voice refresh scheduler registration failed: ${error.message}`));

  const worker = new Worker(
    QUEUES.voiceLearning,
    async (job: Job) => {
      switch (job.name) {
        case "voice.learn":
          return learnFromSend(VoiceLearnJob.parse(job.data));
        case "voice.refresh":
          return refreshVoice(VoiceRefreshJob.parse(job.data));
        case "voice-refresh-tick": {
          const due = await listVoiceRefreshCandidates(MIN_VOICE_SAMPLES);
          const week = Math.floor(Date.now() / WEEK_MS);
          for (const account of due) {
            await queue.add(
              "voice.refresh",
              { orgId: account.orgId, igAccountId: account.igAccountId, reason: "weekly" },
              { jobId: createHash("sha256").update(`voice.refresh:weekly:${account.igAccountId}:${week}`).digest("hex") }
            );
          }
          return { enqueued: due.length };
        }
        default:
          throw new Error(`unknown voice-learning job: ${job.name}`);
      }
    },
    { connection: redisConnection(), concurrency: 2 }
  );
  worker.on("failed", (job, err) => {
    console.error(`voice-learning job ${job?.id} (${job?.name}) failed: ${err.message}`);
  });
  return {
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
