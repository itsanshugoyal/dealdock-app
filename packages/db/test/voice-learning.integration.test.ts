import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { editDistance, editRatio } from "@dealdock/core";
import { startOfZonedWeek } from "../src/zoned-time";

const shouldRun = process.env.RUN_DB_INTEGRATION === "1";
if (shouldRun && !process.env.TEST_DATABASE_URL) {
  throw new Error("RUN_DB_INTEGRATION=1 requires TEST_DATABASE_URL");
}

describe.runIf(shouldRun && Boolean(process.env.TEST_DATABASE_URL))("Voice learning persistence", () => {
  let db: typeof import("../src/index");
  let prisma: typeof import("../src/client").prisma;
  const organizations: string[] = [];
  type Org = Awaited<ReturnType<typeof import("../src/index").createOrganizationWithCreator>>;
  type Planner = import("../src/index").VoiceRulePlanner;

  async function organization(suffix: string): Promise<Org> {
    const nonce = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const created = await db.createOrganizationWithCreator({
      name: `Voice ${nonce}`,
      creator: { clerkUserId: `voice-creator-${nonce}`, email: `voice-${nonce}@example.test` },
      igAccount: { igUserId: `voice-ig-${nonce}`, handle: `voice_${suffix}`, accountType: "creator" },
    });
    organizations.push(created.org.id);
    await db.setVoiceConsent(db.asOrgId(created.org.id), created.igAccount.id, created.seat.id, true);
    return created;
  }

  async function inbound(created: Org, suffix: string, igAccountId = created.igAccount.id) {
    const result = await db.upsertInboundMessage(db.asOrgId(created.org.id), {
      igAccountId,
      igThreadId: `voice-thread-${suffix}`,
      participantHandle: `buyer_${suffix}`,
      participantIgId: `buyer-${suffix}`,
      igMessageId: `voice-in-${suffix}-${created.org.id}`,
      direction: "inbound",
      text: "What are your rates for a reel?",
      sentAt: new Date(Date.now() - 60_000),
    });
    const threadId = "threadId" in result ? result.threadId : undefined;
    if (!("messageId" in result) || typeof threadId !== "string") throw new Error("inbound fixture failed");
    return { messageId: result.messageId, threadId };
  }

  async function sentDraft(created: Org, suffix: string, body: string, finalText: string) {
    const orgId = db.asOrgId(created.org.id);
    const row = await inbound(created, suffix);
    const draft = await db.createDraft(orgId, { threadId: row.threadId, body, modelVersion: "test", promptVersion: "test", label: "brand_deal" });
    const claim = await db.createSendIntentClaim(orgId, { draftId: draft.id, seatId: created.seat.id, finalText, idempotencyKey: `voice-${suffix}-${created.org.id}` });
    const platformMessageId = `voice-out-${suffix}-${created.org.id}`;
    const sentAt = new Date();
    await db.markSendIntentRemoteAccepted(orgId, claim.intentId, platformMessageId, sentAt);
    await db.persistSendIntent(orgId, { intentId: claim.intentId, platformMessageId, sentAt });
    return { draft, threadId: row.threadId, platformMessageId };
  }

  /** A fixed one-rule plan (the real math is unit-tested in @dealdock/ai). */
  const greetingPlan: Planner = (rules) => ({
    upserts: [
      {
        ...(rules[0] ? { id: rules[0].id } : {}),
        key: "greeting:heyy",
        text: "Open with “Heyy”",
        scope: "brand_deal",
        status: "candidate",
        source: "edits",
        evidence: (rules[0]?.evidence ?? 0) + 1,
        against: 0,
        distinctDrafts: 1,
        distinctThreads: 1,
        creatorEvidence: 1,
        examples: [{ before: "Thanks for reaching out!", after: "Heyy!", draftId: "d", threadId: "t" }],
        lastEvidenceAt: new Date(),
      },
    ],
    deletes: [],
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    vi.resetModules();
    db = await import("../src/index");
    ({ prisma } = await import("../src/client"));
  }, 60_000);

  afterAll(async () => {
    for (const orgId of organizations.splice(0)) {
      await db.hardDeleteOrg(orgId).catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  it("marks a send as DealDock's even when the echo arrived first, stores the edit ratio and queues learning once", async () => {
    const created = await organization("echo-first");
    const orgId = db.asOrgId(created.org.id);
    const row = await inbound(created, "echo-first");
    const body = "Thanks for reaching out! Could you share the brief?";
    const finalText = "Heyy! Could you share the brief?";
    const draft = await db.createDraft(orgId, { threadId: row.threadId, body, modelVersion: "test", promptVersion: "test" });
    const claim = await db.createSendIntentClaim(orgId, { draftId: draft.id, seatId: created.seat.id, finalText, idempotencyKey: `echo-first-${created.org.id}` });
    const platformMessageId = `echo-first-out-${created.org.id}`;
    // The webhook echo lands before the send response, so ingestion sees no receipt yet.
    await db.upsertInboundMessage(orgId, {
      igAccountId: created.igAccount.id,
      igThreadId: "voice-thread-echo-first",
      participantHandle: "buyer_echo-first",
      participantIgId: "buyer-echo-first",
      igMessageId: platformMessageId,
      direction: "outbound",
      text: finalText,
      sentAt: new Date(),
    });
    expect((await prisma.message.findUniqueOrThrow({ where: { igMessageId: platformMessageId } })).origin).toBe("native");

    const sentAt = new Date();
    await db.markSendIntentRemoteAccepted(orgId, claim.intentId, platformMessageId, sentAt);
    const measured = { editDistance: editDistance(body, finalText), editRatio: editRatio(body, finalText) };
    expect(await db.persistSendIntent(orgId, { intentId: claim.intentId, platformMessageId, sentAt })).toMatchObject({ persistedNow: true, ...measured });
    expect(await db.persistSendIntent(orgId, { intentId: claim.intentId, platformMessageId, sentAt })).toMatchObject({ persistedNow: false, ...measured });

    expect((await prisma.message.findUniqueOrThrow({ where: { igMessageId: platformMessageId } })).origin).toBe("dealdock");
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: draft.id } })).editRatio).toBeCloseTo(editRatio(body, finalText));
    expect(await prisma.outboxEvent.count({ where: { orgId: created.org.id, kind: "voice.learn" } })).toBe(1);
    expect(await prisma.outboxEvent.findUnique({ where: { dedupeKey: `voice.learn:${draft.id}` } })).toMatchObject({ payload: { orgId: created.org.id, draftId: draft.id } });
  });

  it("persists a voice-note send whose echo has no text, and records its audio", async () => {
    const created = await organization("voice-note");
    const orgId = db.asOrgId(created.org.id);
    const row = await inbound(created, "voice-note");
    const finalText = "Heyy, sending the media kit now";
    const draft = await db.createDraft(orgId, { threadId: row.threadId, body: "Sending the media kit now", modelVersion: "test", promptVersion: "test" });
    const asset = await prisma.audioAsset.create({
      data: { orgId: created.org.id, kind: "tts", mimeType: "audio/mpeg", bytes: Buffer.from("ID3"), sizeBytes: 3, durationMs: 1_200, text: finalText, sha256: "test" },
    });
    const claim = await db.createSendIntentClaim(orgId, {
      draftId: draft.id, seatId: created.seat.id, finalText, idempotencyKey: `voice-note-${created.org.id}`, asVoice: true, audioAssetId: asset.id,
    });
    const platformMessageId = `voice-note-out-${created.org.id}`;
    await db.upsertInboundMessage(orgId, {
      igAccountId: created.igAccount.id,
      igThreadId: "voice-thread-voice-note",
      participantHandle: "buyer_voice-note",
      participantIgId: "buyer-voice-note",
      igMessageId: platformMessageId,
      direction: "outbound",
      contentType: "audio",
      text: "",
      sentAt: new Date(),
    });
    const sentAt = new Date();
    await db.markSendIntentRemoteAccepted(orgId, claim.intentId, platformMessageId, sentAt);
    await db.persistSendIntent(orgId, { intentId: claim.intentId, platformMessageId, sentAt });

    expect(await prisma.message.findUniqueOrThrow({ where: { igMessageId: platformMessageId } })).toMatchObject({
      origin: "dealdock",
      contentType: "audio",
      audioAssetId: asset.id,
      transcript: finalText,
      mediaStatus: "ready",
      durationMs: 1_200,
    });
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("sent");
  });

  it("upserts creator rules by key and scope and audits every change", async () => {
    const created = await organization("rules");
    const orgId = db.asOrgId(created.org.id);
    const input = { igAccountId: created.igAccount.id, key: "greeting:heyy", text: "You open with “Heyy”", scope: "all" as const, status: "active" as const };
    const first = await db.createUserVoiceRule(orgId, created.seat.id, input);
    const again = await db.createUserVoiceRule(orgId, created.seat.id, { ...input, status: "pinned" });
    expect(again).toMatchObject({ id: first.id, status: "pinned", source: "user" });
    expect((await db.updateVoiceRule(orgId, created.seat.id, first.id, { status: "muted" })).status).toBe("muted");
    await expect(db.updateVoiceRule(orgId, created.seat.id, "missing", { status: "pinned" })).rejects.toThrow("voice_rule_not_found");
    expect(await prisma.auditLog.count({ where: { orgId: created.org.id, action: { in: ["voice.rule_created", "voice.rule_muted"] } } })).toBe(3);
    await db.deleteVoiceRule(orgId, created.seat.id, first.id);
    expect(await prisma.voiceRule.count({ where: { orgId: created.org.id } })).toBe(0);
  });

  it("learns from a send exactly once, never while paused, and never without consent", async () => {
    const created = await organization("learn");
    const orgId = db.asOrgId(created.org.id);
    const igAccountId = created.igAccount.id;
    const first = await sentDraft(created, "learn-1", "Thanks for reaching out! Share the brief?", "Heyy! Share the brief?");

    expect((await db.applyVoiceLearning(orgId, igAccountId, { draftId: first.draft.id, editSignals: { kind: "style" }, plan: greetingPlan })).outcome).toBe("applied");
    expect((await db.applyVoiceLearning(orgId, igAccountId, { draftId: first.draft.id, plan: greetingPlan })).outcome).toBe("already_learned");
    const [rule] = await db.listVoiceRules(orgId, igAccountId);
    expect(rule).toMatchObject({ key: "greeting:heyy", evidence: 1, examples: [{ before: "Thanks for reaching out!", after: "Heyy!" }] });
    expect(db.toVoiceRuleDto(rule!).examples).toEqual([{ before: "Thanks for reaching out!", after: "Heyy!" }]);
    expect(await prisma.draft.findUniqueOrThrow({ where: { id: first.draft.id } })).toMatchObject({ editSignals: { kind: "style" } });

    await db.setLearningPaused(orgId, created.seat.id, igAccountId, true);
    const second = await sentDraft(created, "learn-2", "Hello! Sure.", "Heyy! Sure.");
    expect((await db.applyVoiceLearning(orgId, igAccountId, { draftId: second.draft.id, plan: greetingPlan })).outcome).toBe("paused");
    expect((await db.listVoiceRules(orgId, igAccountId))[0]!.evidence).toBe(1);
    await db.setLearningPaused(orgId, created.seat.id, igAccountId, false);
    // A send made while paused is never learned later.
    expect((await db.applyVoiceLearning(orgId, igAccountId, { draftId: second.draft.id, plan: greetingPlan })).outcome).toBe("already_learned");

    await db.setVoiceConsent(orgId, igAccountId, created.seat.id, false);
    expect((await db.applyVoiceLearning(orgId, igAccountId, { plan: greetingPlan })).outcome).toBe("no_consent");
    expect(await prisma.voiceRule.count({ where: { orgId: created.org.id } })).toBe(0);
  });

  it("revoking consent wipes that account's rules, feedback, exclusions, hand edits and draft provenance — not a sibling's", async () => {
    const created = await organization("revoke");
    const orgId = db.asOrgId(created.org.id);
    const seat = created.seat.id;
    const own = created.igAccount.id;
    const sibling = await prisma.igAccount.create({
      data: { orgId: created.org.id, igUserId: `voice-sibling-${created.org.id}`, handle: "sibling_creator", accountType: "creator" },
    });
    await db.setVoiceConsent(orgId, sibling.id, seat, true);
    for (const igAccountId of [own, sibling.id]) {
      await db.createUserVoiceRule(orgId, seat, { igAccountId, key: "emoji:none", text: "Skip emojis", scope: "all", status: "active" });
    }
    const sent = await sentDraft(created, "revoke-sent", "Thanks! Brief?", "Heyy! Brief?");
    const row = await inbound(created, "revoke-live");
    const live = await db.createDraft(orgId, {
      threadId: row.threadId, body: "Draft body", modelVersion: "test", promptVersion: "test",
      generationContext: { rules: [], exemplars: [{ messageId: "m", text: "their words", inboundText: null }], offers: [], lessons: [], missingFacts: [] },
    });
    await db.recordDraftFeedback(orgId, { draftId: live.id, seatId: seat, chips: ["shorter"], note: "too long" });
    const outbound = await prisma.message.findUniqueOrThrow({ where: { igMessageId: sent.platformMessageId } });
    await db.setSampleExcluded(orgId, seat, own, outbound.id, true);
    await db.setStyleOverrides(orgId, seat, own, { greeting: "Heyy" });

    await db.setVoiceConsent(orgId, own, seat, false);

    expect(await prisma.voiceRule.count({ where: { igAccountId: own } })).toBe(0);
    expect(await prisma.voiceRule.count({ where: { igAccountId: sibling.id } })).toBe(1);
    expect(await prisma.draftFeedback.count({ where: { orgId: created.org.id } })).toBe(0);
    const profile = await prisma.voiceProfile.findUniqueOrThrow({ where: { igAccountId: own } });
    expect(profile.excludedMessageIds).toEqual([]);
    expect(profile.styleOverrides).toBeNull();
    expect(await prisma.draft.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ status: "discarded", generationContext: null });
    await expect(db.recordDraftFeedback(orgId, { draftId: sent.draft.id, seatId: seat, chips: ["shorter"] })).rejects.toThrow("voice_consent_required");
    await expect(db.setStyleOverrides(orgId, seat, own, { greeting: "Hi" })).rejects.toThrow("voice_consent_required");
  });

  it("reads the voice corpus with provenance and what each reply answered, minus ignored senders", async () => {
    const created = await organization("corpus");
    const orgId = db.asOrgId(created.org.id);
    const igAccountId = created.igAccount.id;
    await sentDraft(created, "corpus-1", "Thanks! Share the brief?", "Heyy! Share the brief?");
    await db.upsertInboundMessage(orgId, {
      igAccountId,
      igThreadId: "voice-thread-corpus-1",
      participantHandle: "buyer_corpus-1",
      participantIgId: "buyer-corpus-1",
      igMessageId: `voice-native-${created.org.id}`,
      direction: "outbound",
      text: "Also sending my media kit",
      sentAt: new Date(Date.now() + 1_000),
    });

    const corpus = await db.loadVoiceCorpus(orgId, igAccountId);
    expect(corpus.find((r) => r.text === "Heyy! Share the brief?")).toMatchObject({
      origin: "dealdock",
      label: "brand_deal",
      inboundText: "What are your rates for a reel?",
      editRatio: expect.any(Number),
      seatRole: "creator",
    });
    expect(corpus.find((r) => r.text === "Also sending my media kit")).toMatchObject({ origin: "native", editRatio: null });
    expect(corpus.find((r) => r.text === "Heyy! Share the brief?")!.editRatio).toBe(editRatio("Thanks! Share the brief?", "Heyy! Share the brief?"));

    // Weeks are the org's (Asia/Kolkata): Monday 00:00 local, as Insights counts them.
    const now = new Date();
    const metrics = await db.getVoiceMetrics(orgId, igAccountId, now);
    expect(metrics.sentCount).toBe(1);
    expect(metrics.weekly).toHaveLength(8);
    expect(metrics.weekly.at(-1)).toEqual({ weekStart: startOfZonedWeek(now, "Asia/Kolkata").toISOString(), sent: 1, voiceMatchPct: 0 });
    expect(metrics.weekly[0]!.weekStart).toBe(startOfZonedWeek(now, "Asia/Kolkata", 7).toISOString());

    // The context getCreatorContext loaded spares getDraftVoiceContext a second profile read.
    const creator = await db.getCreatorContext(orgId, igAccountId);
    expect(creator.excludedMessageIds).toEqual([]);
    expect(await db.getDraftVoiceContext(orgId, igAccountId, now, creator)).toEqual(await db.getDraftVoiceContext(orgId, igAccountId, now));

    await db.setIgnoreList(orgId, created.seat.id, ["@Buyer_Corpus-1"]);
    expect(await db.loadVoiceCorpus(orgId, igAccountId)).toEqual([]);
  });

  it("refreshes the voice one way for the API and the worker: automatic waits out a pause, manual re-measures but never seeds", async () => {
    const created = await organization("refresh");
    const orgId = db.asOrgId(created.org.id);
    const igAccountId = created.igAccount.id;
    const seat = created.seat.id;
    for (const n of [1, 2, 3]) {
      await db.upsertInboundMessage(orgId, {
        igAccountId, igThreadId: "voice-thread-refresh", participantHandle: "buyer_refresh", participantIgId: "buyer-refresh",
        igMessageId: `voice-refresh-${n}-${created.org.id}`, direction: "outbound", text: `Heyy! Reply number ${n}`, sentAt: new Date(Date.now() - n * 1_000),
      });
    }
    type Plan = { eligibleCount: number; sampleIds: string[] };
    const steps = (mode: "manual" | "automatic") => ({
      mode,
      minSamples: 3,
      plan: (corpus: Array<{ messageId: string }>, excluded: string[]): Plan => {
        const usable = corpus.filter((row) => !excluded.includes(row.messageId));
        return { eligibleCount: usable.length, sampleIds: usable.map((row) => row.messageId) };
      },
      extract: async () => ({ styleCard: { greeting: "Heyy" }, modelVersion: "test-model" }),
      compose: (card: Record<string, unknown>, plan: Plan) => ({ ...card, sampleCount: plan.eligibleCount }),
      seed: (rules: Parameters<Planner>[0]) => greetingPlan(rules),
    });

    await db.setLearningPaused(orgId, seat, igAccountId, true);
    expect(await db.refreshVoiceProfile(orgId, igAccountId, steps("automatic"))).toEqual({ status: "paused" });
    expect((await db.getVoiceProfileState(orgId, igAccountId)).styleCard).toBeNull();
    expect(await db.refreshVoiceProfile(orgId, igAccountId, steps("manual"))).toEqual({
      status: "refreshed", sampleCount: 3, styleCard: { greeting: "Heyy", sampleCount: 3 }, modelVersion: "test-model", seeded: 0,
    });
    expect((await db.getVoiceProfileState(orgId, igAccountId)).styleCard).toEqual({ greeting: "Heyy", sampleCount: 3 });
    expect(await db.listVoiceRules(orgId, igAccountId)).toEqual([]);

    await db.setLearningPaused(orgId, seat, igAccountId, false);
    expect(await db.refreshVoiceProfile(orgId, igAccountId, steps("automatic"))).toMatchObject({ status: "refreshed", seeded: 1 });
    expect(await db.listVoiceRules(orgId, igAccountId)).toHaveLength(1);
    expect(await db.refreshVoiceProfile(orgId, igAccountId, { ...steps("manual"), maxInlineSamples: 2 })).toEqual({
      status: "deferred", sampleCount: 3, styleCard: { greeting: "Heyy", sampleCount: 3 },
    });
    expect(await db.refreshVoiceProfile(orgId, igAccountId, { ...steps("manual"), minSamples: 4 })).toEqual({ status: "not_enough_samples", sampleCount: 3 });

    await db.setVoiceConsent(orgId, igAccountId, seat, false);
    expect(await db.refreshVoiceProfile(orgId, igAccountId, steps("manual"))).toEqual({ status: "no_consent" });
  });
});
