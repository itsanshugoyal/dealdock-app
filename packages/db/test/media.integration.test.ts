import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const shouldRun = process.env.RUN_DB_INTEGRATION === "1";
if (shouldRun && !process.env.TEST_DATABASE_URL) {
  throw new Error("RUN_DB_INTEGRATION=1 requires TEST_DATABASE_URL");
}

/** F5/F8/F9 persistence: voice notes in, voice notes out, provenance, sender context, speaking voices. */
describe.runIf(shouldRun && Boolean(process.env.TEST_DATABASE_URL))("Voice notes, provenance and speaking voices", () => {
  let db: typeof import("../src/index");
  let prisma: typeof import("../src/client").prisma;
  const organizations: string[] = [];
  const clip = (size = 4) => new Uint8Array(size).fill(7);

  async function organization() {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const created = await db.createOrganizationWithCreator({
      name: `Media ${nonce}`,
      currencyCode: "INR",
      timezone: "Asia/Kolkata",
      creator: { clerkUserId: `media-creator-${nonce}`, email: `media-${nonce}@example.test` },
      igAccount: { igUserId: `media-ig-${nonce}`, handle: `creator_${nonce}`, accountType: "creator" },
    });
    organizations.push(created.org.id);
    return { ...created, orgId: db.asOrgId(created.org.id) };
  }

  /** A write that must create a new message (narrows the repo's result union). */
  async function created(orgId: import("../src/index").OrgId, input: Parameters<typeof db.upsertInboundMessage>[1]) {
    const result = await db.upsertInboundMessage(orgId, input);
    if (!result.messageId || !result.threadId) throw new Error(`message not created: ${JSON.stringify(result)}`);
    return { ...result, messageId: result.messageId, threadId: result.threadId };
  }

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

  it("holds a voice note's classification until its transcript is stored", async () => {
    const { orgId, igAccount } = await organization();
    const note = await created(orgId, {
      igAccountId: igAccount.id, igThreadId: "17841", participantHandle: "17841", participantIgId: "17841",
      igMessageId: `voice-${orgId}`, direction: "inbound", contentType: "audio", text: "", sentAt: new Date(),
      mediaUrl: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1", threadSource: "story",
    });
    expect(note.mediaPending).toBe(true);
    expect(await prisma.message.findUniqueOrThrow({ where: { id: note.messageId } })).toMatchObject({ contentType: "audio", mediaStatus: "pending", origin: null });
    expect(await prisma.thread.findUniqueOrThrow({ where: { id: note.threadId } })).toMatchObject({ source: "story" });
    const held = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: note.classificationOutboxId! } });
    expect(held.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    const settled = await db.completeInboundMedia(orgId, note.messageId, {
      status: "ready",
      audio: { bytes: clip(), mimeType: "audio/mp4", durationMs: 4_200 },
      transcript: "  Collab rate kya hai?  ",
      transcriptLanguage: "hi",
    });
    expect(settled.settled).toBe(true);
    const ready = await prisma.message.findUniqueOrThrow({ where: { id: note.messageId }, include: { audioAsset: true } });
    expect(ready).toMatchObject({ mediaStatus: "ready", transcript: "Collab rate kya hai?", transcriptLanguage: "hi", durationMs: 4_200 });
    expect(ready.audioAsset).toMatchObject({ kind: "inbound", mimeType: "audio/mp4", sizeBytes: 4, expiresAt: null });
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: held.id } })).leaseExpiresAt).toBeNull();
    expect(await db.getMessageForClassification(orgId, note.messageId)).toMatchObject({ contentType: "audio", transcript: "Collab rate kya hai?" });

    expect((await db.completeInboundMedia(orgId, note.messageId, { status: "failed" })).settled).toBe(false);
    const other = await organization();
    await expect(db.completeInboundMedia(other.orgId, note.messageId, { status: "failed" })).rejects.toThrow("message_not_in_org");
  });

  it("never fetches an ignored sender's voice note and marks unfetchable notes unavailable", async () => {
    const { orgId, igAccount, seat } = await organization();
    await db.setIgnoreList(orgId, seat.id, ["blocked.user"]);
    const ignored = await db.upsertInboundMessage(orgId, {
      igAccountId: igAccount.id, igThreadId: "t-ignored", participantHandle: "blocked.user", participantIgId: "999",
      igMessageId: `ignored-voice-${orgId}`, direction: "inbound", contentType: "audio", text: "", sentAt: new Date(),
      mediaUrl: "https://lookaside.fbsbx.com/x",
    });
    expect(ignored).toMatchObject({ skipped: "ignored" });
    expect(await prisma.message.findUniqueOrThrow({ where: { igMessageId: `ignored-voice-${orgId}` } })).toMatchObject({ mediaStatus: "unavailable" });
    expect(await prisma.outboxEvent.count({ where: { dedupeKey: `classification:ignored-voice-${orgId}` } })).toBe(0);

    const noUrl = await created(orgId, {
      igAccountId: igAccount.id, igThreadId: "t-nourl", participantHandle: "buyer", participantIgId: "998",
      igMessageId: `nourl-voice-${orgId}`, direction: "inbound", contentType: "audio", text: "", sentAt: new Date(),
    });
    expect(noUrl.mediaPending).toBe(false);
    expect(await prisma.message.findUniqueOrThrow({ where: { id: noUrl.messageId } })).toMatchObject({ mediaStatus: "unavailable" });
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: noUrl.classificationOutboxId! } })).leaseExpiresAt).toBeNull();
  });

  it("decides outbound provenance once, on create, and reconciles an early voice-note echo", async () => {
    const { orgId, igAccount, seat } = await organization();
    const base = { igAccountId: igAccount.id, igThreadId: "t-prov", participantHandle: "buyer", participantIgId: "buyer-1" };
    const inbound = await created(orgId, { ...base, igMessageId: `in-${orgId}`, direction: "inbound", text: "Rates?", sentAt: new Date(Date.now() - 60_000) });

    const native = await created(orgId, { ...base, igMessageId: `native-${orgId}`, direction: "outbound", text: "Typed in Instagram", sentAt: new Date() });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: native.messageId } })).toMatchObject({ origin: "native" });

    await db.setVoiceConsent(orgId, igAccount.id, seat.id, true);
    const draft = await db.createDraft(orgId, { threadId: inbound.threadId, body: "Sharing my rates now!", modelVersion: "test", promptVersion: "test" });
    const tts = await db.createAudioAsset(orgId, { kind: "tts", bytes: clip(8), mimeType: "audio/wav", durationMs: 1_500, text: "Sharing my rates now!", expiresAt: new Date(Date.now() + 86_400_000) });
    const intent = await db.createSendIntentClaim(orgId, {
      draftId: draft.id, seatId: seat.id, finalText: "Sharing my rates now!", idempotencyKey: `voice-intent-${orgId}`, asVoice: true, audioAssetId: tts.id,
    });
    await db.markSendIntentRemoteAccepted(orgId, intent.intentId, `mid.voice.${orgId}`, new Date());

    // Meta's echo of our audio has no text; it lands before the send response is persisted.
    const echo = await created(orgId, { ...base, igMessageId: `mid.voice.${orgId}`, direction: "outbound", contentType: "audio", text: "", sentAt: new Date() });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: echo.messageId } })).toMatchObject({
      origin: "dealdock", contentType: "audio", text: "Sharing my rates now!", audioAssetId: tts.id, mediaStatus: "ready",
    });
    expect(echo.mediaPending).toBe(false);
    const persisted = await db.persistSendIntent(orgId, { intentId: intent.intentId, platformMessageId: `mid.voice.${orgId}`, sentAt: new Date() });
    expect(persisted.messageId).toBe(echo.messageId);
    await db.attachVoiceNoteToMessage(orgId, echo.messageId, tts.id); // already linked: no-op

    // A replayed echo never rewrites provenance.
    expect(await db.upsertInboundMessage(orgId, { ...base, igMessageId: `native-${orgId}`, direction: "outbound", text: "Typed in Instagram", sentAt: new Date() })).toMatchObject({ skipped: "duplicate" });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: native.messageId } })).toMatchObject({ origin: "native" });

    // The disclosure's own echo may also win the race; its origin is corrected, not duplicated.
    await db.upsertInboundMessage(orgId, { ...base, igMessageId: `mid.disclosure.${orgId}`, direction: "outbound", text: "AI voice note in my voice", sentAt: new Date() });
    const disclosure = await db.recordVoiceNoteDisclosure(orgId, { threadId: inbound.threadId, platformMessageId: `mid.disclosure.${orgId}`, text: "AI voice note in my voice", sentAt: new Date() });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: disclosure.messageId } })).toMatchObject({ origin: "dealdock", direction: "outbound" });
    const other = await organization();
    await expect(db.recordVoiceNoteDisclosure(other.orgId, { threadId: inbound.threadId, platformMessageId: "x", text: "x", sentAt: new Date() })).rejects.toThrow("thread_not_in_org");
  });

  it("replaces the IGSID handle with the real username and keeps the first known source", async () => {
    const { orgId, igAccount } = await organization();
    const webhook = { igAccountId: igAccount.id, igThreadId: "1789", participantHandle: "1789", participantIgId: "1789" };
    const first = await created(orgId, { ...webhook, igMessageId: `h1-${orgId}`, direction: "inbound", text: "Hi", sentAt: new Date(Date.now() - 5_000) });
    expect(await prisma.thread.findUniqueOrThrow({ where: { id: first.threadId } })).toMatchObject({ participantHandle: "1789", source: null });

    // The backfill re-reads the same message with the conversation's username.
    expect(await db.upsertInboundMessage(orgId, { ...webhook, participantHandle: "glowherbals.in", igMessageId: `h1-${orgId}`, direction: "inbound", text: "Hi", sentAt: new Date() })).toMatchObject({ skipped: "duplicate" });
    await db.upsertInboundMessage(orgId, { ...webhook, igMessageId: `h2-${orgId}`, direction: "inbound", text: "From your ad", sentAt: new Date(), threadSource: "ad" });
    await db.upsertInboundMessage(orgId, { ...webhook, igMessageId: `h3-${orgId}`, direction: "inbound", text: "Story reply", sentAt: new Date(), threadSource: "story" });
    expect(await prisma.thread.findUniqueOrThrow({ where: { id: first.threadId } })).toMatchObject({ participantHandle: "glowherbals.in", source: "ad" });

    expect(await db.getParticipantForRefresh(orgId, first.threadId)).toMatchObject({ participantIgId: "1789", profileFetchedAt: null, igAccount: { status: "active" } });
    await db.saveParticipantProfile(orgId, first.threadId, { name: "Glow Herbals", username: "glow.herbals", avatarUrl: "http://insecure.test/a.jpg", followerCount: 48_200, verified: true, followsYou: false });
    expect(await prisma.thread.findUniqueOrThrow({ where: { id: first.threadId } })).toMatchObject({
      participantHandle: "glow.herbals", participantName: "Glow Herbals", participantAvatarUrl: null,
      participantFollowerCount: 48_200, participantVerified: true, participantFollowsYou: false,
    });
    await db.saveParticipantProfile(orgId, first.threadId, { name: null, username: "not a username!", avatarUrl: null, followerCount: null, verified: null, followsYou: null });
    expect((await prisma.thread.findUniqueOrThrow({ where: { id: first.threadId } })).participantHandle).toBe("glow.herbals");
    const other = await organization();
    await expect(db.saveParticipantProfile(other.orgId, first.threadId, { name: "x", username: null, avatarUrl: null, followerCount: null, verified: null, followsYou: null })).rejects.toThrow("thread_not_in_org");
  });

  it("runs the speaking-voice lifecycle: consent, races, disclosure and revocation", async () => {
    const { orgId, igAccount, seat } = await organization();
    const take = (durationMs: number) => ({ bytes: clip(16), mimeType: "audio/wav", durationMs });
    const start = () => db.startSpeakingVoice(orgId, {
      igAccountId: igAccount.id, seatId: seat.id, provider: "mock",
      consentStatement: "I'm Asha, I'm over 18, and I consent to DealDock creating an AI copy of my voice.",
      consentTake: take(15_000), sampleTakes: [take(35_000), take(35_000)],
    });

    const first = await start();
    expect(first.previous).toBeNull();
    expect(await db.getSpeakingVoiceSummary(orgId, igAccount.id)).toMatchObject({ status: "pending", sampleSeconds: 85, disclosureEnabled: true });
    expect(await db.completeSpeakingVoice(orgId, { voiceId: first.voiceId, seatId: seat.id, assetIds: first.assetIds, externalVoiceId: "mock-voice-1" })).toEqual({ applied: true });
    expect(await db.isSpeakingVoiceReady(orgId, igAccount.id)).toBe(true);
    expect(await db.isSpeakingVoiceReady(orgId, igAccount.id, "mock")).toBe(true);
    expect(await db.isSpeakingVoiceReady(orgId, igAccount.id, "elevenlabs")).toBe(false);
    expect(await db.getReadySpeakingVoice(orgId, igAccount.id, "mock")).toMatchObject({ status: "ready", provider: "mock", externalVoiceId: "mock-voice-1" });
    expect(await db.getReadySpeakingVoice(orgId, igAccount.id, null)).toBeNull();

    // Re-recording replaces the recordings and hands back the old vendor voice for deletion.
    const second = await start();
    expect(second.previous).toEqual({ provider: "mock", externalVoiceId: "mock-voice-1" });
    expect(await prisma.audioAsset.count({ where: { id: { in: first.assetIds } } })).toBe(0);
    // A late answer for the superseded attempt is ignored.
    expect(await db.completeSpeakingVoice(orgId, { voiceId: first.voiceId, seatId: seat.id, assetIds: first.assetIds, externalVoiceId: "stale" })).toEqual({ applied: false });
    await db.completeSpeakingVoice(orgId, { voiceId: second.voiceId, seatId: seat.id, assetIds: second.assetIds, externalVoiceId: "mock-voice-2" });

    await db.setSpeakingVoiceDisclosure(orgId, igAccount.id, seat.id, false);
    expect(await db.getSpeakingVoiceSummary(orgId, igAccount.id)).toMatchObject({ status: "ready", disclosureEnabled: false });

    const revoked = await db.revokeSpeakingVoice(orgId, igAccount.id, seat.id);
    expect(revoked).toMatchObject({ provider: "mock", externalVoiceId: "mock-voice-2" });
    expect(await prisma.audioAsset.count({ where: { id: { in: second.assetIds } } })).toBe(0);
    expect(await db.isSpeakingVoiceReady(orgId, igAccount.id)).toBe(false);
    expect(await db.getReadySpeakingVoice(orgId, igAccount.id)).toBeNull();
    expect(await db.listSpeakingVoicesToRevoke(orgId)).toHaveLength(1); // vendor copy still pending
    await db.settleVendorVoiceDeletion(orgId, revoked!.voiceId, "mock-voice-2", true);
    expect(await db.listSpeakingVoicesToRevoke(orgId)).toHaveLength(0);
    const actions = (await prisma.auditLog.findMany({ where: { orgId, entityType: "speaking_voice" } })).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["voice.clone_created", "voice.disclosure_disabled", "voice.clone_revoked"]));

    // Team seats can never record a creator's voice.
    const user = await prisma.user.create({ data: { clerkUserId: `assistant-${orgId}`, email: `assistant-${orgId}@example.test` } });
    const assistant = await prisma.seat.create({ data: { orgId, userId: user.id, role: "assistant" } });
    await expect(db.startSpeakingVoice(orgId, {
      igAccountId: igAccount.id, seatId: assistant.id, provider: "mock", consentStatement: "x".repeat(30),
      consentTake: take(15_000), sampleTakes: [take(35_000)],
    })).rejects.toThrow("creator_seat_required");
  });

  it("serves only unexpired clips through the signed-link read", async () => {
    const { orgId } = await organization();
    const live = await db.createAudioAsset(orgId, { kind: "tts", bytes: clip(), mimeType: "audio/wav", expiresAt: new Date(Date.now() + 60_000) });
    const expired = await db.createAudioAsset(orgId, { kind: "tts", bytes: clip(), mimeType: "audio/wav", expiresAt: new Date(Date.now() - 1_000) });
    expect(live.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await db.getAudioAssetForDelivery(live.id)).toMatchObject({ mimeType: "audio/wav", sizeBytes: 4 });
    expect(await db.getAudioAssetForDelivery(expired.id)).toBeNull();
    await expect(db.createAudioAsset(orgId, { kind: "tts", bytes: new Uint8Array(0), mimeType: "audio/wav" })).rejects.toThrow("audio_size_out_of_bounds");
  });
});
