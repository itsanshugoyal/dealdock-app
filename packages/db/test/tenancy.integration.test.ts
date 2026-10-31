import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const shouldRun = process.env.RUN_DB_INTEGRATION === "1";
if (shouldRun && !process.env.TEST_DATABASE_URL) {
  throw new Error("RUN_DB_INTEGRATION=1 requires TEST_DATABASE_URL");
}

describe.runIf(shouldRun && Boolean(process.env.TEST_DATABASE_URL))("Postgres tenancy, deletion, and delivery invariants", () => {
  let db: typeof import("../src/index");
  let prisma: typeof import("../src/client").prisma;
  const organizations: string[] = [];

  async function organization(label: string) {
    const nonce = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const created = await db.createOrganizationWithCreator({
      name: `Tenant ${nonce}`,
      creator: { clerkUserId: `creator-${nonce}`, email: `${nonce}@example.test` },
      igAccount: { igUserId: `ig-${nonce}`, handle: `handle_${nonce}`, accountType: "creator" },
    });
    organizations.push(created.org.id);
    return created;
  }

  async function inbound(org: Awaited<ReturnType<typeof organization>>, suffix: string) {
    const result = await db.upsertInboundMessage(db.asOrgId(org.org.id), {
      igAccountId: org.igAccount.id,
      igThreadId: `thread-${suffix}`,
      participantHandle: `buyer_${suffix}`,
      participantIgId: `buyer-id-${suffix}`,
      igMessageId: `message-${suffix}-${org.org.id}`,
      direction: "inbound",
      text: "Paid enquiry",
      sentAt: new Date(),
    });
    if (!("messageId" in result) || !("threadId" in result)) throw new Error("inbound fixture failed");
    return result;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    vi.resetModules();
    db = await import("../src/index");
    ({ prisma } = await import("../src/client"));
  });

  afterAll(async () => {
    for (const orgId of organizations.splice(0)) await db.hardDeleteOrg(orgId).catch(() => undefined);
    await prisma?.$disconnect();
  });

  it("never lets one org read, write, classify, or review another org's account/message", async () => {
    const alpha = await organization("alpha");
    const beta = await organization("beta");
    const alphaId = db.asOrgId(alpha.org.id);
    const betaId = db.asOrgId(beta.org.id);
    const alphaInbound = await inbound(alpha, "alpha");
    const betaInbound = await inbound(beta, "beta");

    await expect(db.upsertInboundMessage(alphaId, {
      igAccountId: beta.igAccount.id,
      igThreadId: "wrong-account",
      participantHandle: "not-allowed",
      participantIgId: "not-allowed",
      igMessageId: `wrong-account-${alpha.org.id}`,
      direction: "inbound",
      text: "must not persist",
      sentAt: new Date(),
    })).rejects.toThrow("not in org");
    await expect(db.saveClassification(alphaId, {
      messageId: betaInbound.messageId,
      label: "brand_deal", confidence: 0.99, language: "en",
      valueMinMinor: 10, valueMaxMinor: 20, rationale: "wrong org", modelVersion: "test", promptVersion: "test", routedTo: "inbox",
    })).rejects.toThrow("not in org");

    const betaReview = await db.saveClassification(betaId, {
      messageId: betaInbound.messageId,
      label: "uncertain", confidence: 0.1, language: "en",
      valueMinMinor: null, valueMaxMinor: null, rationale: "review", modelVersion: "test", promptVersion: "test", routedTo: "review_queue",
    });
    await expect(db.reviewClassification(alphaId, {
      classificationId: betaReview.id,
      seatId: alpha.seat.id,
      outcome: "confirmed",
    })).rejects.toThrow("not in org");
    expect(await db.listReviewQueue(alphaId)).toEqual([]);
    const alphaReview = await db.saveClassification(alphaId, {
      messageId: alphaInbound.messageId,
      label: "uncertain", confidence: 0.1, language: "en",
      valueMinMinor: null, valueMaxMinor: null, rationale: "review", modelVersion: "test", promptVersion: "test", routedTo: "review_queue",
    });
    await expect(db.reviewClassification(alphaId, {
      classificationId: alphaReview.id,
      seatId: beta.seat.id,
      outcome: "confirmed",
    })).rejects.toThrow("reviewer_seat_not_in_org");
    expect(await db.getThreadDetail(alphaId, betaInbound.threadId)).toBeNull();
    expect(await db.getThreadDetail(betaId, alphaInbound.threadId)).toBeNull();
  });

  it("adopts a listed username only on that account's placeholder threads, and lists review items with their account", async () => {
    const alpha = await organization("adopt-alpha");
    const beta = await organization("adopt-beta");
    const alphaId = db.asOrgId(alpha.org.id);
    // A webhook-only thread knows just the sender's IGSID; each account has one with the same IGSID.
    const webhookOnly = async (org: Awaited<ReturnType<typeof organization>>) => {
      const result = await db.upsertInboundMessage(db.asOrgId(org.org.id), {
        igAccountId: org.igAccount.id, igThreadId: "17841", participantHandle: "17841", participantIgId: "17841",
        igMessageId: `adopt-${org.org.id}`, direction: "inbound", text: "Rates?", sentAt: new Date(),
      });
      if (!("messageId" in result) || !result.messageId || !result.threadId) throw new Error("inbound fixture failed");
      return { messageId: result.messageId, threadId: result.threadId };
    };
    const alphaInbound = await webhookOnly(alpha);
    await webhookOnly(beta);

    expect(await db.adoptParticipantHandles(alphaId, beta.igAccount.id, [{ participantIgId: "17841", handle: "real.buyer" }])).toBe(0);
    expect(await db.adoptParticipantHandles(alphaId, alpha.igAccount.id, [
      { participantIgId: "17841", handle: "real.buyer" },
      { participantIgId: "17842", handle: "17842" },
      { participantIgId: "17843", handle: "not a handle" },
    ])).toBe(1);
    // A renamed thread is no longer a placeholder: a later listing changes nothing.
    expect(await db.adoptParticipantHandles(alphaId, alpha.igAccount.id, [{ participantIgId: "17841", handle: "someone.else" }])).toBe(0);
    const threads = await prisma.thread.findMany({ where: { orgId: { in: [alpha.org.id, beta.org.id] } }, select: { orgId: true, participantHandle: true } });
    expect(Object.fromEntries(threads.map((thread) => [thread.orgId, thread.participantHandle]))).toEqual({ [alpha.org.id]: "real.buyer", [beta.org.id]: "17841" });

    await db.saveClassification(alphaId, {
      messageId: alphaInbound.messageId,
      label: "uncertain", confidence: 0.1, language: "en",
      valueMinMinor: null, valueMaxMinor: null, rationale: "review", modelVersion: "test", promptVersion: "test", routedTo: "review_queue",
    });
    expect(await db.listReviewQueue(alphaId)).toEqual([expect.objectContaining({ threadId: alphaInbound.threadId, igAccountId: alpha.igAccount.id, handle: "real.buyer" })]);
  });

  it("revokes per-account voice consent immediately, including samples and draft creation", async () => {
    const created = await organization("voice");
    const orgId = db.asOrgId(created.org.id);
    const row = await inbound(created, "voice");
    await db.setVoiceConsent(orgId, created.igAccount.id, created.seat.id, true);
    await db.setVoiceEnabled(orgId, created.seat.id, true);
    const draft = await db.createDraft(orgId, { threadId: row.threadId, body: "A consented draft", modelVersion: "test", promptVersion: "test" });
    await db.setVoiceConsent(orgId, created.igAccount.id, created.seat.id, false);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("discarded");
    expect(await db.getSentSamples(orgId, created.igAccount.id)).toBeNull();
    expect((await db.getCreatorContext(orgId, created.igAccount.id)).voiceEnabled).toBe(false);
    await expect(db.createDraft(orgId, { threadId: row.threadId, body: "Must not draft", modelVersion: "test", promptVersion: "test" })).rejects.toThrow("voice_consent_required");
  });

  it("hard-deletes a ledger, outbox and exclusively-scoped webhook while cleaning its unshared user", async () => {
    const created = await organization("delete");
    const orgId = db.asOrgId(created.org.id);
    const row = await inbound(created, "delete");
    await db.closeDeal(orgId, {
      threadId: row.threadId,
      seatId: created.seat.id,
      amountMinor: 999,
      dealType: "other",
      idempotencyKey: `delete-close-${created.org.id}`,
    });
    const ingress = await db.recordWebhookIngress("instagram", { object: "instagram", test: created.org.id }, [{
      orgId,
      dedupeKey: `delete-webhook-${created.org.id}`,
      payload: { event: "test" },
    }]);
    expect(ingress.webhookEventId).toBeTruthy();
    const userId = created.user.id;
    await db.hardDeleteOrg(created.org.id);
    organizations.splice(organizations.indexOf(created.org.id), 1);
    expect(await db.countOrgResidue(created.org.id)).toEqual({
      org: 0, accounts: 0, threads: 0, messages: 0, classifications: 0, drafts: 0, sendIntents: 0,
      ledger: 0, audit: 0, subs: 0, billingEvents: 0, ignores: 0, outbox: 0, webhookScopes: 0, voice: 0, checkpoints: 0, pushes: 0,
      voiceRules: 0, draftFeedback: 0, offers: 0, speakingVoices: 0, audioAssets: 0,
    });
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await prisma.webhookEvent.findUnique({ where: { id: ingress.webhookEventId! } })).toBeNull();
  });

  it("makes remote-acceptance and webhook echo persistence idempotent under a concurrent race", async () => {
    const created = await organization("echo");
    const orgId = db.asOrgId(created.org.id);
    const row = await inbound(created, "echo");
    await db.setVoiceConsent(orgId, created.igAccount.id, created.seat.id, true);
    const draft = await db.createDraft(orgId, { threadId: row.threadId, body: "Hello", modelVersion: "test", promptVersion: "test" });
    const claims = await Promise.all([
      db.createSendIntentClaim(orgId, {
        draftId: draft.id, seatId: created.seat.id, finalText: "Hello!", idempotencyKey: `echo-${created.org.id}`,
      }),
      db.createSendIntentClaim(orgId, {
        draftId: draft.id, seatId: created.seat.id, finalText: "Hello!", idempotencyKey: `echo-${created.org.id}`,
      }),
    ]);
    expect(claims.filter((result) => result.claimed)).toHaveLength(1);
    expect(new Set(claims.map((result) => result.intentId)).size).toBe(1);
    const claim = claims[0]!;
    const sentAt = new Date();
    await db.markSendIntentRemoteAccepted(orgId, claim.intentId, `platform-${created.org.id}`, sentAt);
    const results = await Promise.all([
      db.persistSendIntent(orgId, { intentId: claim.intentId, platformMessageId: `platform-${created.org.id}`, sentAt }),
      db.persistSendIntent(orgId, { intentId: claim.intentId, platformMessageId: `platform-${created.org.id}`, sentAt }),
    ]);
    expect(results.filter((result) => result.persistedNow)).toHaveLength(1);
    expect(await prisma.message.count({ where: { orgId: created.org.id, igMessageId: `platform-${created.org.id}` } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { orgId: created.org.id, action: "message.sent" } })).toBe(1);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("sent");
  });

  it("refuses a stale or mismatched platform-message echo without sending the draft", async () => {
    const created = await organization("collision");
    const orgId = db.asOrgId(created.org.id);
    const row = await inbound(created, "collision");
    await db.setVoiceConsent(orgId, created.igAccount.id, created.seat.id, true);
    const draft = await db.createDraft(orgId, { threadId: row.threadId, body: "Reply", modelVersion: "test", promptVersion: "test" });
    const claim = await db.createSendIntentClaim(orgId, {
      draftId: draft.id, seatId: created.seat.id, finalText: "Reply!", idempotencyKey: `collision-${created.org.id}`,
    });
    const platformMessageId = `stale-platform-${created.org.id}`;
    const stale = await db.upsertInboundMessage(orgId, {
      igAccountId: created.igAccount.id,
      igThreadId: "another-thread",
      participantHandle: "another",
      participantIgId: "another-id",
      igMessageId: platformMessageId,
      direction: "inbound",
      text: "An unrelated message",
      sentAt: new Date(),
    });
    expect(stale).toMatchObject({ threadId: expect.any(String) });
    await expect(db.persistSendIntent(orgId, {
      intentId: claim.intentId, platformMessageId, sentAt: new Date(),
    })).rejects.toThrow("platform_message_collision_or_mismatched_echo");
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("sending");
    expect((await prisma.sendIntent.findUniqueOrThrow({ where: { id: claim.intentId } })).status).toBe("pending");
  });
  it("requires the approving seat to belong to the org and binds retries to the approved content", async () => {
    const owner = await organization("approver");
    const foreign = await organization("foreign-approver");
    const orgId = db.asOrgId(owner.org.id);
    const row = await inbound(owner, "approver");
    await db.setVoiceConsent(orgId, owner.igAccount.id, owner.seat.id, true);
    const draft = await db.createDraft(orgId, { threadId: row.threadId, body: "Reply", modelVersion: "test", promptVersion: "test" });
    const input = { draftId: draft.id, seatId: owner.seat.id, finalText: "Approved reply", idempotencyKey: `approval-${owner.org.id}` };
    await expect(db.createSendIntentClaim(orgId, { ...input, seatId: foreign.seat.id })).rejects.toThrow("send_seat_not_in_org");
    expect(await prisma.sendIntent.count({ where: { orgId: owner.org.id } })).toBe(0);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("ready");
    const claim = await db.createSendIntentClaim(orgId, input);
    await expect(db.createSendIntentClaim(orgId, { ...input, finalText: "Changed reply" })).rejects.toThrow("send_idempotency_key_conflict");
    expect(await prisma.sendIntent.count({ where: { orgId: owner.org.id } })).toBe(1);
    expect((await prisma.sendIntent.findUniqueOrThrow({ where: { id: claim.intentId } })).finalText).toBe("Approved reply");
  });

  it("rejects a second platform receipt for an already persisted intent", async () => {
    const created = await organization("receipt");
    const orgId = db.asOrgId(created.org.id);
    const row = await inbound(created, "receipt");
    await db.setVoiceConsent(orgId, created.igAccount.id, created.seat.id, true);
    const draft = await db.createDraft(orgId, { threadId: row.threadId, body: "Reply", modelVersion: "test", promptVersion: "test" });
    const claim = await db.createSendIntentClaim(orgId, { draftId: draft.id, seatId: created.seat.id, finalText: "Reply", idempotencyKey: `receipt-${created.org.id}` });
    const firstId = `receipt-first-${created.org.id}`;
    const secondId = `receipt-second-${created.org.id}`;
    const sentAt = new Date();
    await db.markSendIntentRemoteAccepted(orgId, claim.intentId, firstId, sentAt);
    await db.persistSendIntent(orgId, { intentId: claim.intentId, platformMessageId: firstId, sentAt });
    await expect(db.persistSendIntent(orgId, { intentId: claim.intentId, platformMessageId: secondId, sentAt })).rejects.toThrow("send_receipt_conflict");
    expect(await prisma.message.count({ where: { orgId: created.org.id, direction: "outbound" } })).toBe(1);
    expect((await prisma.sendIntent.findUniqueOrThrow({ where: { id: claim.intentId } })).platformMessageId).toBe(firstId);
    expect(await prisma.auditLog.count({ where: { orgId: created.org.id, action: "message.sent" } })).toBe(1);
  });

  it("reuses an exact outbound echo without creating a second message", async () => {
    const created = await organization("matching-echo");
    const orgId = db.asOrgId(created.org.id);
    const row = await inbound(created, "matching-echo");
    await db.setVoiceConsent(orgId, created.igAccount.id, created.seat.id, true);
    const draft = await db.createDraft(orgId, { threadId: row.threadId, body: "Reply", modelVersion: "test", promptVersion: "test" });
    const claim = await db.createSendIntentClaim(orgId, { draftId: draft.id, seatId: created.seat.id, finalText: "Approved", idempotencyKey: `matching-${created.org.id}` });
    const platformMessageId = `matching-platform-${created.org.id}`;
    const sentAt = new Date();
    const echo = await prisma.message.create({ data: { orgId: created.org.id, threadId: row.threadId, igMessageId: platformMessageId, direction: "outbound", text: "Approved", sentAt } });
    const result = await db.persistSendIntent(orgId, { intentId: claim.intentId, platformMessageId, sentAt });
    expect(result).toMatchObject({ messageId: echo.id, persistedNow: true });
    expect(await prisma.message.count({ where: { orgId: created.org.id, direction: "outbound" } })).toBe(1);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: draft.id } })).sentMessageId).toBe(echo.id);
  });

  it.each([
    { direction: "inbound" as const, text: "Approved" },
    { direction: "outbound" as const, text: "Different text" },
  ])("rejects a same-thread echo with mismatched direction or text: $direction / $text", async ({ direction, text }) => {
    const created = await organization("wrong-echo");
    const orgId = db.asOrgId(created.org.id);
    const row = await inbound(created, "wrong-echo");
    await db.setVoiceConsent(orgId, created.igAccount.id, created.seat.id, true);
    const draft = await db.createDraft(orgId, { threadId: row.threadId, body: "Reply", modelVersion: "test", promptVersion: "test" });
    const claim = await db.createSendIntentClaim(orgId, { draftId: draft.id, seatId: created.seat.id, finalText: "Approved", idempotencyKey: `wrong-echo-${created.org.id}` });
    const platformMessageId = `wrong-echo-platform-${created.org.id}`;
    const sentAt = new Date();
    await prisma.message.create({ data: { orgId: created.org.id, threadId: row.threadId, igMessageId: platformMessageId, direction, text, sentAt } });
    await expect(db.persistSendIntent(orgId, { intentId: claim.intentId, platformMessageId, sentAt })).rejects.toThrow("platform_message_collision_or_mismatched_echo");
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("sending");
    expect((await prisma.sendIntent.findUniqueOrThrow({ where: { id: claim.intentId } })).status).toBe("pending");
    expect(await prisma.auditLog.count({ where: { orgId: created.org.id, action: "message.sent" } })).toBe(0);
  });

  it("rejects a receipt that differs from the platform acknowledgement", async () => {
    const created = await organization("ack-receipt");
    const orgId = db.asOrgId(created.org.id);
    const row = await inbound(created, "ack-receipt");
    await db.setVoiceConsent(orgId, created.igAccount.id, created.seat.id, true);
    const draft = await db.createDraft(orgId, { threadId: row.threadId, body: "Reply", modelVersion: "test", promptVersion: "test" });
    const claim = await db.createSendIntentClaim(orgId, { draftId: draft.id, seatId: created.seat.id, finalText: "Reply", idempotencyKey: `ack-${created.org.id}` });
    const sentAt = new Date();
    const acknowledgedId = `acknowledged-${created.org.id}`;
    await db.markSendIntentRemoteAccepted(orgId, claim.intentId, acknowledgedId, sentAt);
    await expect(db.persistSendIntent(orgId, { intentId: claim.intentId, platformMessageId: `different-${created.org.id}`, sentAt })).rejects.toThrow("send_receipt_conflict");
    const intent = await prisma.sendIntent.findUniqueOrThrow({ where: { id: claim.intentId } });
    expect(intent.status).toBe("remote_accepted");
    expect(intent.platformMessageId).toBe(acknowledgedId);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("sending");
    expect(await prisma.message.count({ where: { orgId: created.org.id, direction: "outbound" } })).toBe(0);
  });

  it("clears style data when revocation races a voice refresh", async () => {
    const created = await organization("voice-race");
    const orgId = db.asOrgId(created.org.id);
    await db.setVoiceConsent(orgId, created.igAccount.id, created.seat.id, true);
    const snapshot = await db.getSentSamples(orgId, created.igAccount.id);
    if (!snapshot) throw new Error("voice fixture requires consent");
    const results = await Promise.allSettled([
      db.saveStyleCard(orgId, created.igAccount.id, { greeting: "Hi" }, ["sample-one"], snapshot.consentVersion),
      db.setVoiceConsent(orgId, created.igAccount.id, created.seat.id, false),
    ]);
    expect(results[1]?.status).toBe("fulfilled");
    if (results[0]?.status === "rejected") expect(results[0].reason.message).toBe("voice_consent_required");
    const profile = await prisma.voiceProfile.findUniqueOrThrow({ where: { igAccountId: created.igAccount.id } });
    expect(profile.enabled).toBe(false);
    expect(profile.revokedAt).not.toBeNull();
    expect(profile.styleCard).toBeNull();
    expect(profile.sampleMessageIds).toEqual([]);
    await expect(db.saveStyleCard(orgId, created.igAccount.id, { greeting: "Late" }, ["late"], snapshot.consentVersion)).rejects.toThrow("voice_consent_required");
    // Also exercise the other ordering: an in-time refresh is cleared by the
    // subsequent revocation, even if it had already committed.
    await db.setVoiceConsent(orgId, created.igAccount.id, created.seat.id, true);
    await expect(db.saveStyleCard(orgId, created.igAccount.id, { greeting: "Old consent" }, ["sample-one"], snapshot.consentVersion)).rejects.toThrow("voice_consent_changed");
    const refreshedSnapshot = await db.getSentSamples(orgId, created.igAccount.id);
    if (!refreshedSnapshot) throw new Error("voice fixture requires renewed consent");
    await db.saveStyleCard(orgId, created.igAccount.id, { greeting: "Before revocation" }, ["sample-two"], refreshedSnapshot.consentVersion);
    await db.setVoiceConsent(orgId, created.igAccount.id, created.seat.id, false);
    const revokedAgain = await prisma.voiceProfile.findUniqueOrThrow({ where: { igAccountId: created.igAccount.id } });
    expect(revokedAgain.styleCard).toBeNull();
    expect(revokedAgain.sampleMessageIds).toEqual([]);
  });

});
