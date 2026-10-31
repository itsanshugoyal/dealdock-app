import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const shouldRun = process.env.RUN_DB_INTEGRATION === "1";
if (shouldRun && !process.env.TEST_DATABASE_URL) {
  throw new Error("RUN_DB_INTEGRATION=1 requires TEST_DATABASE_URL");
}

const DAY = 86_400_000;

describe.runIf(shouldRun && Boolean(process.env.TEST_DATABASE_URL))("Inbox v2, offers, insights, audit and schedulers", () => {
  let db: typeof import("../src/index");
  let prisma: typeof import("../src/client").prisma;
  const organizations: string[] = [];

  async function organization(label: string) {
    const nonce = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const created = await db.createOrganizationWithCreator({
      name: `Insights ${nonce}`,
      creator: { clerkUserId: `creator-${nonce}`, email: `${nonce}@example.test` },
      igAccount: { igUserId: `ig-${nonce}`, handle: `handle_${nonce}`, accountType: "creator" },
    });
    organizations.push(created.org.id);
    return { ...created, orgId: db.asOrgId(created.org.id), nonce };
  }

  async function commerceThread(
    org: Awaited<ReturnType<typeof organization>>,
    suffix: string,
    text: string,
    value: { min: number; max: number },
    sentAt = new Date(),
  ) {
    const inbound = await db.upsertInboundMessage(org.orgId, {
      igAccountId: org.igAccount.id,
      igThreadId: `thread-${suffix}`,
      participantHandle: `buyer_${suffix}`,
      participantIgId: `buyer-${suffix}-${org.nonce}`,
      igMessageId: `message-${suffix}-${org.nonce}`,
      direction: "inbound",
      text,
      sentAt,
    });
    if ("skipped" in inbound) throw new Error("inbound fixture failed");
    await db.saveClassification(org.orgId, {
      messageId: inbound.messageId, label: "brand_deal", confidence: 0.95, language: "en",
      valueMinMinor: value.min, valueMaxMinor: value.max, rationale: "brand brief", modelVersion: "test", promptVersion: "test", routedTo: "inbox",
    });
    return inbound;
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

  it("pages the inbox by value with a stable cursor, search and per-sender revenue", async () => {
    const org = await organization("inbox");
    const big = await commerceThread(org, "big", "Payment done ✅", { min: 50_000_00, max: 80_000_00 });
    await commerceThread(org, "mid", "Can you share your rate card?", { min: 10_000_00, max: 20_000_00 });
    await commerceThread(org, "small", "Interested in a collab", { min: 1_000_00, max: 2_000_00 });

    const first = await db.listInboxPage(org.orgId, { limit: 2 });
    expect(first.rows.map((row) => row.participantHandle)).toEqual(["buyer_big", "buyer_mid"]);
    expect(first.rows[0]).toMatchObject({ estValueMinMinor: 50_000_00, estValueMaxMinor: 80_000_00, dealSignal: true, preview: "Payment done ✅" });
    expect(first.rows[1]!.dealSignal).toBe(false);
    const second = await db.listInboxPage(org.orgId, { limit: 2, cursor: first.nextCursor! });
    expect(second.rows.map((row) => row.participantHandle)).toEqual(["buyer_small"]);
    expect(second.nextCursor).toBeNull();
    await expect(db.listInboxPage(org.orgId, { cursor: "not-a-cursor" })).rejects.toMatchObject({ statusCode: 400 });

    expect((await db.listInboxPage(org.orgId, { q: "RATE CARD" })).rows.map((row) => row.participantHandle)).toEqual(["buyer_mid"]);
    expect((await db.listInboxPage(org.orgId, { label: "coaching_lead" })).rows).toEqual([]);

    await db.closeDeal(org.orgId, { threadId: big.threadId, seatId: org.seat.id, amountMinor: 75_000_00, dealType: "brand", idempotencyKey: `close-${org.nonce}` });
    const closed = await db.listInboxPage(org.orgId, { state: "closed" });
    expect(closed.rows[0]).toMatchObject({ dealSignal: false, participant: { closedTotalMinor: 75_000_00, closedDeals: 1 } });
    const detail = await db.getThreadDetail(org.orgId, big.threadId);
    expect(detail).toMatchObject({ dealSignal: null, participant: { closedTotalMinor: 75_000_00 }, rationale: "brand brief" });
  });

  it("reads a row's deal signal from the same last 8 messages as the thread banner", async () => {
    const org = await organization("signal");
    const start = Date.now() - 60 * 60_000;
    const thread = await commerceThread(org, "signal", "Payment done ✅", { min: 10_000_00, max: 20_000_00 }, new Date(start));
    const reply = (n: number) => db.upsertInboundMessage(org.orgId, {
      igAccountId: org.igAccount.id,
      igThreadId: "thread-signal",
      participantHandle: "buyer_signal",
      participantIgId: `buyer-signal-${org.nonce}`,
      igMessageId: `reply-${n}-${org.nonce}`,
      direction: "outbound",
      text: `Update ${n}`,
      sentAt: new Date(start + n * 60_000),
    });
    const row = async () => (await db.listInboxPage(org.orgId)).rows.find((r) => r.threadId === thread.threadId)!;
    const banner = async () => (await db.getThreadDetail(org.orgId, thread.threadId))!.dealSignal;

    await reply(1);
    expect(await row()).toMatchObject({ preview: "Update 1", previewOutbound: true, dealSignal: true });
    expect(await banner()).toMatchObject({ phrase: "payment done" });

    // Seven more replies push the confirmation out of the window on both surfaces.
    for (let n = 2; n <= 8; n++) await reply(n);
    expect((await row()).dealSignal).toBe(false);
    expect(await banner()).toBeNull();
  });

  it("reports the leak scan idle, running until its history is classified, then done", async () => {
    const org = await organization("leak");
    const other = await organization("leak-other");
    expect(await db.getLeakScanSummary(org.orgId)).toEqual({ status: "idle", scannedCount: 0, commerceCount: 0, totalMinMinor: 0, topThreads: [] });
    await expect(db.markLeakScanStarted(org.orgId, other.igAccount.id)).rejects.toThrow("ig_account_not_in_org");

    await db.markLeakScanStarted(org.orgId, org.igAccount.id);
    expect((await db.getLeakScanSummary(org.orgId)).status).toBe("running");
    const scanned = await db.upsertInboundMessage(org.orgId, {
      igAccountId: org.igAccount.id, igThreadId: "leak-thread", participantHandle: "brand_leak", participantIgId: `brand-${org.nonce}`,
      igMessageId: `leak-${org.nonce}`, direction: "inbound", text: "Budget for two reels?", sentAt: new Date(), source: "leak_scan",
    });
    if (!("messageId" in scanned) || !scanned.messageId) throw new Error("leak fixture failed");
    await db.markLeakScanCompleted(org.orgId, org.igAccount.id);
    // Everything is queued, but a scanned message still awaits its classification.
    expect((await db.getLeakScanSummary(org.orgId)).status).toBe("running");

    await db.saveClassification(org.orgId, {
      messageId: scanned.messageId, label: "brand_deal", confidence: 0.95, language: "en", valueMinMinor: 10_000_00, valueMaxMinor: 30_000_00,
      rationale: "budget ask", modelVersion: "test", promptVersion: "test", routedTo: "inbox", source: "leak_scan",
    });
    expect(await db.getLeakScanSummary(org.orgId)).toEqual({
      status: "done", scannedCount: 1, commerceCount: 1, totalMinMinor: 10_000_00,
      topThreads: [{ threadId: scanned.threadId, handle: "brand_leak", label: "brand_deal", estValueMaxMinor: 30_000_00 }],
    });
    expect((await db.getInsights(org.orgId)).leak.baselineMinMinor).toBe(10_000_00);
  });

  it("serves GET /settings and onboarding completeness from single reads", async () => {
    const org = await organization("settings");
    await db.setMonthlyGoal(org.orgId, org.seat.id, 50_000_00);
    expect(await db.getOrgSettings(org.orgId)).toEqual({
      currencyCode: "INR", locale: "en-IN", timezone: "Asia/Kolkata", nudgeDelayDays: 3, tier: "solo", deletionRequestedAt: null,
      monthlyGoalMinor: 50_000_00,
      accounts: [{ id: org.igAccount.id, handle: org.igAccount.handle, status: "active", provider: "mock" }],
      voiceConsent: [{ igAccountId: org.igAccount.id, consented: false }],
    });
    expect(await db.getOrgSettings(db.asOrgId(`missing-${org.nonce}`))).toBeNull();

    expect((await db.getOnboardingProfile(org.orgId))?.complete).toBe(false);
    await db.upsertOnboardingProfile(org.orgId, org.seat.id, {
      businessContext: { businessSummary: "Fitness coach" }, currencyCode: "INR", locale: "en-IN", timezone: "Asia/Kolkata",
    });
    await db.setVoiceConsent(org.orgId, org.igAccount.id, org.seat.id, true);
    expect(await db.getOnboardingProfile(org.orgId)).toMatchObject({ complete: true, voiceConsent: [{ igAccountId: org.igAccount.id, consented: true }] });
    expect(await db.isOnboardingComplete(org.orgId)).toBe(true);
  });

  it("gives classification only its context, with the account's high-value bar", async () => {
    const org = await organization("classify");
    const other = await organization("classify-other");
    expect(await db.getClassifyContext(org.orgId, org.igAccount.id)).toMatchObject({
      currencyCode: "INR", styleCard: null, correctionExamples: [], voiceEnabled: false, highValueThresholdMinor: 1_00_000_00,
    });
    await db.createOffer(org.orgId, org.seat.id, { name: "Reel", dealType: "brand", priceMinMinor: 20_000_00, priceMaxMinor: 40_000_00 });
    await db.createOffer(org.orgId, org.seat.id, { name: "Call", dealType: "coaching", priceMinMinor: 5_000_00 });
    await db.setVoiceConsent(org.orgId, org.igAccount.id, org.seat.id, true);
    expect(await db.getClassifyContext(org.orgId, org.igAccount.id)).toMatchObject({ voiceEnabled: true, highValueThresholdMinor: 20_000_00 });
    await expect(db.getClassifyContext(org.orgId, other.igAccount.id)).rejects.toThrow("ig_account_not_in_org");
  });

  it("knows when the sender wrote again after a message", async () => {
    const org = await organization("newer");
    const sentAt = new Date(Date.now() - 60_000);
    const thread = await commerceThread(org, "newer", "Rates?", { min: 1_00, max: 2_00 }, sentAt);
    const write = (direction: "inbound" | "outbound", n: number) => db.upsertInboundMessage(org.orgId, {
      igAccountId: org.igAccount.id, igThreadId: "thread-newer", participantHandle: "buyer_newer", participantIgId: `buyer-newer-${org.nonce}`,
      igMessageId: `newer-${direction}-${n}-${org.nonce}`, direction, text: "Any update?", sentAt: new Date(sentAt.getTime() + n * 1_000),
    });
    expect(await db.hasNewerInbound(org.orgId, thread.threadId, sentAt)).toBe(false);
    await write("outbound", 1);
    expect(await db.hasNewerInbound(org.orgId, thread.threadId, sentAt)).toBe(false);
    await write("inbound", 2);
    expect(await db.hasNewerInbound(org.orgId, thread.threadId, sentAt)).toBe(true);
    expect(await db.hasNewerInbound(org.orgId, thread.threadId, new Date(sentAt.getTime() + 2_000))).toBe(false);
  });

  it("lists outbox rows across kinds in one query and lets exactly one dispatcher claim each", async () => {
    const org = await organization("outbox");
    const kinds = [`test-a-${org.nonce}`, `test-b-${org.nonce}`];
    const [first, second] = await Promise.all(kinds.map((kind, n) =>
      prisma.outboxEvent.create({ data: { orgId: org.org.id, kind, dedupeKey: `${kind}:${n}`, payload: { n } } }),
    ));
    const listed = await db.listRecoverableOutboxEvents(kinds, 1000);
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([{ id: first!.id, kind: kinds[0], dedupeKey: `${kinds[0]}:0` }]));

    const claims = await Promise.all([db.claimOutboxEvent(first!.id), db.claimOutboxEvent(first!.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toEqual({ id: first!.id, orgId: org.org.id, kind: kinds[0], dedupeKey: `${kinds[0]}:0`, payload: { n: 0 }, attempts: 1 });
    expect((await db.listRecoverableOutboxEvents(kinds, 1000)).map((row) => row.id)).toEqual([second!.id]);
    // An expired lease can be claimed again; a published row never.
    expect(await db.claimOutboxEvent(first!.id, 60_000, new Date(Date.now() + 120_000))).toMatchObject({ attempts: 2 });
    await db.completeOutboxEvent(first!.id);
    expect(await db.claimOutboxEvent(first!.id, 60_000, new Date(Date.now() + 600_000))).toBeNull();

    // Only rows published before the cut-off go; unpublished ones stay.
    await prisma.outboxEvent.update({ where: { id: first!.id }, data: { processedAt: new Date("2000-01-01T00:00:00.000Z") } });
    expect(await db.purgeProcessedOutbox(new Date("2000-01-02T00:00:00.000Z"))).toEqual({ purgedOutboxEvents: 1 });
    expect(await prisma.outboxEvent.findUnique({ where: { id: first!.id } })).toBeNull();
    expect(await prisma.outboxEvent.findUnique({ where: { id: second!.id } })).not.toBeNull();
  });

  it("fires a nudge once per follow-up cycle and restarts the clock on dismiss", async () => {
    const org = await organization("nudge");
    const thread = await commerceThread(org, "quiet", "Let me check with my team", { min: 1_00, max: 2_00 });
    await db.setThreadState(org.orgId, { threadId: thread.threadId, seatId: org.seat.id, state: "waiting" });
    await prisma.thread.update({ where: { id: thread.threadId }, data: { waitingSince: new Date(Date.now() - 4 * DAY) } });

    const mine = async (now = new Date()) => (await db.listNudgeCandidates(now)).filter((c) => c.threadId === thread.threadId);
    const [due] = await mine();
    expect(due).toBeDefined();
    expect((await db.getThreadDetail(org.orgId, thread.threadId))?.nudgeDue).toBe(true);
    await db.recordNudgeFired(org.orgId, thread.threadId, due!.dueAt);
    expect(await mine()).toEqual([]);

    await db.dismissNudge(org.orgId, thread.threadId, org.seat.id);
    expect((await db.getThreadDetail(org.orgId, thread.threadId))?.nudgeDue).toBe(false);
    expect(await mine(new Date(Date.now() + 3 * DAY + 60_000))).toHaveLength(1);
  });

  it("keeps offers inside the org, in its currency, with ordered prices", async () => {
    const org = await organization("offers");
    const other = await organization("offers-other");
    const offer = await db.createOffer(org.orgId, org.seat.id, { name: "Reel", dealType: "brand", priceMinMinor: 20_000_00, priceMaxMinor: 40_000_00 });
    expect(offer).toMatchObject({ currencyCode: "INR", active: true, sortOrder: 0, igAccountId: null });
    expect((await db.createOffer(org.orgId, org.seat.id, { name: "Story", dealType: "brand" })).sortOrder).toBe(1);

    await expect(db.createOffer(org.orgId, org.seat.id, { name: "X", dealType: "brand", igAccountId: other.igAccount.id })).rejects.toThrow("ig_account_not_in_org");
    await expect(db.updateOffer(org.orgId, org.seat.id, offer.id, { priceMinMinor: 50_000_00 })).rejects.toMatchObject({
      statusCode: 400, name: "DomainError", code: "offer_price_min_exceeds_max", status: 400,
    });
    await expect(db.updateOffer(other.orgId, other.seat.id, offer.id, { name: "stolen" })).rejects.toThrow("offer_not_in_org");
    await expect(db.deleteOffer(other.orgId, other.seat.id, offer.id)).rejects.toMatchObject({
      name: "DomainError", code: "offer_not_in_org", status: 404, message: "offer_not_in_org",
    });

    expect((await db.updateOffer(org.orgId, org.seat.id, offer.id, { active: false })).active).toBe(false);
    await db.deleteOffer(org.orgId, org.seat.id, offer.id);
    expect((await db.listOffers(org.orgId)).map((o) => o.name)).toEqual(["Story"]);
  });

  it("reports goal, mix, pipeline and the audit trail of a send", async () => {
    const org = await organization("insights");
    const thread = await commerceThread(org, "deal", "Let's lock it", { min: 30_000_00, max: 60_000_00 });
    await db.setMonthlyGoal(org.orgId, org.seat.id, 100_000_00);
    await db.setVoiceConsent(org.orgId, org.igAccount.id, org.seat.id, true);
    const draft = await db.createDraft(org.orgId, { threadId: thread.threadId, body: "Hello! Sharing details.", modelVersion: "test", promptVersion: "test" });
    const intent = await db.createSendIntentClaim(org.orgId, { draftId: draft.id, seatId: org.seat.id, finalText: "Heyy! Sharing details.", idempotencyKey: `send-${org.nonce}` });
    await db.markSendIntentRemoteAccepted(org.orgId, intent.intentId, `platform-${org.nonce}`, new Date());
    await db.persistSendIntent(org.orgId, { intentId: intent.intentId, platformMessageId: `platform-${org.nonce}`, sentAt: new Date() });
    await db.closeDeal(org.orgId, { threadId: thread.threadId, seatId: org.seat.id, amountMinor: 45_000_00, dealType: "brand", idempotencyKey: `close-${org.nonce}` });

    const insights = await db.getInsights(org.orgId, { months: 6 });
    expect(insights.months).toHaveLength(6);
    expect(insights.months.at(-1)).toMatchObject({ recoveredMinor: 45_000_00, deals: 1 });
    expect(insights.goal).toMatchObject({ monthlyGoalMinor: 100_000_00, mtdMinor: 45_000_00, pct: 45 });
    expect(insights.byType.find((t) => t.dealType === "brand")).toEqual({ dealType: "brand", totalMinor: 45_000_00, deals: 1 });
    expect(insights.topDeals[0]).toMatchObject({ threadId: thread.threadId, amountMinor: 45_000_00 });
    expect(insights.speed.sampleSize).toBe(1);
    expect(insights.leak.recoveredSinceJoinMinor).toBe(45_000_00);

    const audit = await db.listAuditRows(org.orgId, 10);
    const sent = audit.find((row) => row.action === "message.sent");
    expect(sent).toMatchObject({ threadId: thread.threadId, originalDraft: "Hello! Sharing details.", finalText: "Heyy! Sharing details.", asVoice: false, actor: { seatId: org.seat.id, role: "creator" } });
    expect(audit.find((row) => row.action === "ledger.created")).toMatchObject({ threadId: thread.threadId, editDistance: null });
  });

  it("queues one weekly digest per org per ISO week inside push hours", async () => {
    const org = await organization("digest");
    await db.savePushSubscription(org.orgId, org.seat.id, {
      endpoint: `https://fcm.googleapis.com/fcm/send/${org.nonce}`,
      p256dh: "B".repeat(87),
      auth: "A".repeat(22),
    });
    const mondayTenIst = new Date("2026-11-02T04:30:00Z");
    const mine = async (now: Date) => (await db.listWeeklyDigestCandidates(now)).filter((c) => c.orgId === org.org.id);
    expect(await mine(mondayTenIst)).toEqual([{ orgId: org.org.id, isoWeek: "2026-W45" }]);
    expect(await mine(new Date("2026-11-02T03:00:00Z"))).toEqual([]); // 08:30 IST, before the slot
    await db.recordWeeklyDigestSent(org.orgId, "2026-W45");
    expect(await mine(mondayTenIst)).toEqual([]);
  });
});
