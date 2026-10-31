import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CLASSIFICATION_LABELS,
  DRAFT_CHIPS,
  type MeasuredStyle,
  type StyleCard,
  type VoicePreviewResponse,
  type VoiceSampleDto,
  type VoiceStudio,
} from "@dealdock/core";
import {
  composeStyleCard,
  createPipeline,
  draftScope,
  extractStyleCard,
  MIN_VOICE_SAMPLES,
  normalizeForSim,
  planSeedRules,
  planVoiceRefresh,
  retrieveVoiceContext,
  selectVoiceSamples,
} from "@dealdock/ai";
import {
  createUserVoiceRule,
  deleteVoiceRule,
  enqueueVoiceRefresh,
  getCreatorContext,
  getDraftVoiceContext,
  getSpeakingVoiceSummary,
  getVoiceMetrics,
  getVoiceProfileState,
  listVoiceAccounts,
  listVoiceRules,
  loadVoiceCorpus,
  refreshVoiceProfile,
  setLearningPaused,
  setSampleExcluded,
  setStyleOverrides,
  setVoiceConsent,
  toVoiceRuleDto,
  updateVoiceRule,
  type OrgId,
  type VoiceCorpusRow,
} from "@dealdock/db";
import { requireAuth } from "../auth";
import { isSpeechConfigured } from "../feature-flags";
import { AccountRef, IgAccountId, requireIgAccount, requirePermission, requireWritable } from "../guards";

/**
 * Your voice (F2): the Voice Studio read model, the creator's controls over
 * what DealDock learned (style edits, rules, samples, pause, consent), the
 * refresh that turns their own messages into a style card, and a preview
 * draft that is never stored or sendable. Every account id is validated
 * against the caller's org; omitted, it is the org's first active account.
 */

const SCOPES = ["all", "nudge", ...CLASSIFICATION_LABELS] as const;
const StyleOverrides = z
  .object({
    greeting: z.string().max(80).optional(),
    tone: z.string().max(120).optional(),
    sentenceLength: z.enum(["short", "medium", "long"]).optional(),
    signoff: z.string().max(80).optional(),
    emojiUsage: z.enum(["none", "light", "heavy"]).optional(),
    codeSwitching: z.string().max(160).optional(),
    characteristicPhrases: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
    avoidPhrases: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  })
  .strict();
const RuleBody = z.object({
  igAccountId: IgAccountId.optional(),
  text: z.string().trim().min(1).max(120),
  scope: z.enum(SCOPES).optional(),
  // e.g. "greeting:heyy" from a learned-style hint; omitted for a rule typed by hand.
  key: z.string().trim().regex(/^[a-z_]+:[^\r\n]{1,110}$/).optional(),
  status: z.enum(["active", "pinned"]).optional(),
});
const RulePatch = z
  .object({
    text: z.string().trim().min(1).max(120).optional(),
    status: z.enum(["candidate", "active", "pinned", "muted"]).optional(),
    scope: z.enum(SCOPES).optional(),
  })
  .refine((patch) => patch.text !== undefined || patch.status !== undefined || patch.scope !== undefined, "nothing to change");
const PreviewBody = z.object({
  igAccountId: IgAccountId.optional(),
  inboundText: z.string().trim().min(1).max(2000),
  label: z.enum(CLASSIFICATION_LABELS),
  chips: z.array(z.enum(DRAFT_CHIPS)).max(4).optional(),
  instruction: z.string().trim().max(200).optional(),
});

/** Above this many usable samples a manual refresh runs in the worker instead of the request. */
const SYNC_REFRESH_MAX_SAMPLES = 60;
const NOT_ENOUGH_SAMPLES_HINT = "Send a few replies first — DealDock needs at least 3 of your own messages to learn how you text.";
const SCAN_SETTLE_MS = 2 * 60_000;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The stored card (v1 or v2 JSON) as the API's StyleCard. */
function toStyleCard(card: Record<string, unknown>): StyleCard {
  const text = (key: string) => (typeof card[key] === "string" ? (card[key] as string) : "");
  const length = card["sentenceLength"];
  const emoji = card["emojiUsage"];
  return {
    greeting: text("greeting"),
    tone: text("tone"),
    sentenceLength: length === "short" || length === "long" ? length : "medium",
    signoff: text("signoff"),
    emojiUsage: emoji === "light" || emoji === "heavy" ? emoji : "none",
    codeSwitching: text("codeSwitching"),
    characteristicPhrases: stringList(card["characteristicPhrases"]),
    ...(Array.isArray(card["avoidPhrases"]) ? { avoidPhrases: stringList(card["avoidPhrases"]) } : {}),
  };
}

function measuredOf(card: Record<string, unknown> | null): MeasuredStyle[] {
  const list = card?.["measured"];
  return Array.isArray(list)
    ? list.filter((m): m is MeasuredStyle => typeof m === "object" && m !== null && typeof (m as MeasuredStyle).scope === "string" && Array.isArray((m as MeasuredStyle).topOpeners))
    : [];
}

/** The newest samples with the weight each one carries, plus the ones the creator excluded (so they can undo it). */
function studioSamples(corpus: VoiceCorpusRow[], excludedIds: string[]): VoiceSampleDto[] {
  const excluded = new Set(excludedIds);
  const { samples } = selectVoiceSamples(corpus, excluded);
  return [
    ...samples.slice(0, 50).map((s) => ({ messageId: s.messageId, text: s.text, sentAt: s.sentAt.toISOString(), origin: s.origin, excluded: false, weight: s.weight })),
    ...corpus
      .filter((row) => excluded.has(row.messageId))
      .slice(0, 50)
      .map((row) => ({ messageId: row.messageId, text: row.text, sentAt: row.sentAt.toISOString(), origin: row.origin, excluded: true, weight: 0 })),
  ].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

async function voiceStudio(orgId: OrgId, account: { id: string; handle: string }): Promise<VoiceStudio> {
  const [accounts, state, rules, metrics, speaking] = await Promise.all([
    listVoiceAccounts(orgId),
    getVoiceProfileState(orgId, account.id),
    listVoiceRules(orgId, account.id),
    getVoiceMetrics(orgId, account.id),
    getSpeakingVoiceSummary(orgId, account.id),
  ]);
  const samples = state.consent.granted ? studioSamples(await loadVoiceCorpus(orgId, account.id), state.excludedMessageIds) : [];
  return {
    igAccountId: account.id,
    handle: account.handle,
    accounts,
    consent: {
      granted: state.consent.granted,
      consentedAt: state.consent.consentedAt?.toISOString() ?? null,
      revokedAt: state.consent.revokedAt?.toISOString() ?? null,
    },
    learningPaused: state.learningPaused,
    refreshedAt: state.refreshedAt?.toISOString() ?? null,
    lastDistilledAt: state.lastDistilledAt?.toISOString() ?? null,
    styleCard: state.styleCard ? toStyleCard(state.styleCard) : null,
    overrides: state.styleOverrides,
    measured: measuredOf(state.styleCard),
    rules: rules.map(toVoiceRuleDto),
    samples,
    metrics,
    speaking,
    speechAvailable: isSpeechConfigured(),
  } satisfies VoiceStudio;
}

type RefreshResult =
  | { status: "refreshed" | "queued"; styleCard: StyleCard | null; sampleCount: number }
  | { error: "voice_modeling_disabled" | "not_enough_samples"; hint: string };

/**
 * Re-measure the account's voice from its own messages now (small sample
 * sets) or hand it to the worker. The shared db refresh runs it as "manual":
 * a paused account still gets a fresh card, but no seed rules.
 */
async function refreshVoiceNow(orgId: OrgId, igAccountId: string): Promise<RefreshResult> {
  const result = await refreshVoiceProfile(orgId, igAccountId, {
    mode: "manual",
    minSamples: MIN_VOICE_SAMPLES,
    maxInlineSamples: SYNC_REFRESH_MAX_SAMPLES,
    plan: planVoiceRefresh,
    extract: (plan) => extractStyleCard(plan.extractionTexts),
    compose: composeStyleCard,
    seed: (rules, plan, now) => planSeedRules(rules, plan.seeds, now),
  });
  switch (result.status) {
    case "refreshed":
      return { status: "refreshed", styleCard: toStyleCard(result.styleCard), sampleCount: result.sampleCount };
    case "deferred":
      await enqueueVoiceRefresh(orgId, igAccountId, { reason: "manual" });
      return { status: "queued", styleCard: result.styleCard ? toStyleCard(result.styleCard) : null, sampleCount: result.sampleCount };
    case "not_enough_samples":
      return { error: "not_enough_samples", hint: NOT_ENOUGH_SAMPLES_HINT };
    case "no_consent":
      return { error: "voice_modeling_disabled", hint: "Allow DealDock to learn from your sent messages first." };
    case "paused":
      // Only an automatic refresh stops for a pause; a manual one never reports it.
      throw new Error("manual_voice_refresh_reported_paused");
  }
}

async function sendRefresh(reply: FastifyReply, run: () => Promise<RefreshResult>) {
  try {
    const result = await run();
    if ("error" in result) {
      reply.code(409).send(result);
      return null;
    }
    return result;
  } catch (error) {
    if (error instanceof Error && (error.message === "voice_consent_required" || error.message === "voice_consent_changed")) {
      reply.code(409).send({ error: error.message, hint: "Voice consent changed during refresh. Start again if you still want to refresh your style." });
      return null;
    }
    throw error;
  }
}

export async function voiceRoutes(app: FastifyInstance) {
  const settingsWrite = { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] };

  app.get("/voice", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = AccountRef.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const account = await requireIgAccount(req.auth!.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    return voiceStudio(req.auth!.orgId, account);
  });

  /** The creator's own edits to the style card; PUT replaces the whole override set. */
  app.put("/voice/style", settingsWrite, async (req, reply) => {
    const parsed = z.object({ igAccountId: IgAccountId.optional(), overrides: StyleOverrides }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const auth = req.auth!;
    const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    await setStyleOverrides(auth.orgId, auth.seatId, account.id, parsed.data.overrides);
    return voiceStudio(auth.orgId, account);
  });

  /** A rule the creator wrote, or a learned-style hint they kept ("Yes, keep it"). */
  app.post("/voice/rules", settingsWrite, async (req, reply) => {
    const parsed = RuleBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const auth = req.auth!;
    const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    const key = parsed.data.key ?? `user:${normalizeForSim(parsed.data.text).replace(/\s+/g, "-").slice(0, 80) || "rule"}`;
    const rule = await createUserVoiceRule(auth.orgId, auth.seatId, {
      igAccountId: account.id,
      key,
      text: parsed.data.text,
      scope: parsed.data.scope ?? "all",
      status: parsed.data.status ?? "active",
    });
    return toVoiceRuleDto(rule);
  });

  /** Pin (never fades), mute ("Not me", never re-proposed), reword or re-scope a rule. */
  app.patch("/voice/rules/:id", settingsWrite, async (req, reply) => {
    const parsed = RulePatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const { id } = req.params as { id: string };
    return toVoiceRuleDto(await updateVoiceRule(req.auth!.orgId, req.auth!.seatId, id, parsed.data));
  });

  /** Delete (unlike mute) allows the habit to be learned again. */
  app.delete("/voice/rules/:id", settingsWrite, async (req) => {
    const { id } = req.params as { id: string };
    await deleteVoiceRule(req.auth!.orgId, req.auth!.seatId, id);
    return { deleted: true };
  });

  /** Include/exclude one of the creator's messages as style evidence. */
  app.put("/voice/samples/:messageId", settingsWrite, async (req, reply) => {
    const parsed = z.object({ igAccountId: IgAccountId.optional(), excluded: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const auth = req.auth!;
    const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    const { messageId } = req.params as { messageId: string };
    return setSampleExcluded(auth.orgId, auth.seatId, account.id, messageId, parsed.data.excluded);
  });

  /** Refresh the style card from the creator's own messages (sync for small sets, else queued). */
  app.post("/voice/refresh", settingsWrite, async (req, reply) => {
    const parsed = AccountRef.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const auth = req.auth!;
    const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    const result = await sendRefresh(reply, () => refreshVoiceNow(auth.orgId, account.id));
    if (!result) return reply;
    return { styleCard: result.styleCard, sampleCount: result.sampleCount, status: result.status };
  });

  /** Pause learning: drafts keep using what was learned; nothing new is learned. */
  app.put("/voice/learning", settingsWrite, async (req, reply) => {
    const parsed = z.object({ igAccountId: IgAccountId.optional(), paused: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const auth = req.auth!;
    const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    return setLearningPaused(auth.orgId, auth.seatId, account.id, parsed.data.paused);
  });

  /** "Try it": a draft for a sample DM in the creator's voice. Never stored, never sendable. */
  app.post("/voice/preview", { preHandler: [requireAuth, requireWritable, requirePermission("send")] }, async (req, reply) => {
    const parsed = PreviewBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const auth = req.auth!;
    const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    const creator = await getCreatorContext(auth.orgId, account.id);
    if (!creator.voiceEnabled) return reply.code(409).send({ error: "voice_modeling_disabled" });
    const now = new Date();
    // The creator context carries the consent retrieval needs; the profile is not read twice.
    const pools = await getDraftVoiceContext(auth.orgId, account.id, now, creator);
    const query = { inboundText: parsed.data.inboundText, scope: draftScope({ kind: "reply", label: parsed.data.label }), now };
    const result = await createPipeline().draft({
      kind: "reply",
      classificationLabel: parsed.data.label,
      threadHistory: [{ direction: "inbound", text: parsed.data.inboundText }],
      creator,
      ...retrieveVoiceContext(query, pools),
      chips: parsed.data.chips,
      instruction: parsed.data.instruction,
    });
    return {
      body: result.body,
      context: result.context ?? { rules: [], exemplars: [], offers: [], lessons: [], missingFacts: [] },
    } satisfies VoicePreviewResponse;
  });

  // ── Settings-era paths, same contract (moved here from routes/settings.ts) ──

  /** Explicit per-account consent; granting it starts the first style read automatically. */
  app.put("/settings/voice/consent", settingsWrite, async (req, reply) => {
    const parsed = z.object({ igAccountId: IgAccountId.optional(), consented: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const auth = req.auth!;
    const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    await setVoiceConsent(auth.orgId, account.id, auth.seatId, parsed.data.consented);
    if (parsed.data.consented) await enqueueVoiceRefresh(auth.orgId, account.id, { reason: "consent" });
    return { consented: parsed.data.consented };
  });
}

/** Leak-scan history lands through ingestion a little after the scan job; refresh once it has settled. */
export async function scheduleVoiceRefreshAfterScan(orgId: OrgId, igAccountId: string) {
  await enqueueVoiceRefresh(orgId, igAccountId, { reason: "leak_scan", delayMs: SCAN_SETTLE_MS });
}
