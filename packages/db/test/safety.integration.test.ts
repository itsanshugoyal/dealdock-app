import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const shouldRun = process.env.RUN_DB_INTEGRATION === "1";
if (shouldRun && !process.env.TEST_DATABASE_URL) {
  throw new Error("RUN_DB_INTEGRATION=1 requires TEST_DATABASE_URL");
}

describe.runIf(shouldRun && Boolean(process.env.TEST_DATABASE_URL))("Postgres safety invariants", () => {
  let db: typeof import("../src/index");
  let prisma: typeof import("../src/client").prisma;
  const organizations: string[] = [];

  async function organization(currencyCode = "INR", timezone = "Asia/Kolkata") {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const created = await db.createOrganizationWithCreator({
      name: `Safety ${nonce}`,
      currencyCode,
      timezone,
      creator: { clerkUserId: `test-creator-${nonce}`, email: `creator-${nonce}@example.test` },
      igAccount: { igUserId: `test-ig-${nonce}`, handle: `creator_${nonce}`, accountType: "creator" },
    });
    organizations.push(created.org.id);
    return created;
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

  it("freezes currency, keeps money safe, deduplicates close-outs, and uses org-local months", async () => {
    const created = await organization("USD", "Pacific/Kiritimati");
    const orgId = db.asOrgId(created.org.id);
    const inbound = await db.upsertInboundMessage(orgId, {
      igAccountId: created.igAccount.id,
      igThreadId: "thread-ledger",
      participantHandle: "buyer",
      participantIgId: "buyer-1",
      igMessageId: `message-ledger-${created.org.id}`,
      direction: "inbound",
      text: "I want to buy",
      sentAt: new Date("2026-01-31T23:30:00.000Z"),
    });
    if (!("threadId" in inbound)) throw new Error("inbound write failed");
    await expect(db.updateRegion(orgId, created.seat.id, { currencyCode: "INR" })).rejects.toThrow("currency_immutable_for_organization");
    const closeInput = {
      threadId: inbound.threadId,
      seatId: created.seat.id,
      amountMinor: 12_345,
      dealType: "coaching" as const,
      idempotencyKey: `close-${created.org.id}`,
    };
    await Promise.all([db.closeDeal(orgId, closeInput), db.closeDeal(orgId, closeInput)]);
    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { orgId: created.org.id } });
    await prisma.ledgerEntry.update({ where: { id: entry.id }, data: { closedAt: new Date("2026-01-31T23:30:00.000Z") } });
    const ledger = await db.getLedger(orgId, "2026-02");
    expect(ledger.currencyCode).toBe("USD");
    expect(ledger.totalMinor).toBe(12_345);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]!.currencyCode).toBe("USD");
    await expect(db.updateLedgerEntry(orgId, { entryId: entry.id, seatId: created.seat.id, amountMinor: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow("safe_integer");
  });

  it("isolates review items, honors account-specific ignore rules, and preserves a human decision", async () => {
    const created = await organization();
    const orgId = db.asOrgId(created.org.id);
    await db.setIgnoreList(orgId, created.seat.id, ["ignored_sender"], created.igAccount.id);
    const ignored = await db.upsertInboundMessage(orgId, {
      igAccountId: created.igAccount.id, igThreadId: "ignored-thread", participantHandle: "@ignored_sender",
      participantIgId: "ignored", igMessageId: `ignored-${created.org.id}`, direction: "inbound", text: "Paid collab", sentAt: new Date(),
    });
    expect(ignored).toMatchObject({ skipped: "ignored" });

    const incoming = await db.upsertInboundMessage(orgId, {
      igAccountId: created.igAccount.id, igThreadId: "review-thread", participantHandle: "reviewer",
      participantIgId: "reviewer", igMessageId: `review-${created.org.id}`, direction: "inbound", text: "Can we work together?", sentAt: new Date(),
    });
    if (!("messageId" in incoming)) throw new Error("inbound write failed");
    const classification = await db.saveClassification(orgId, {
      messageId: incoming.messageId, label: "uncertain", confidence: 0.2, language: "en",
      valueMinMinor: null, valueMaxMinor: null, rationale: "uncertain", modelVersion: "test", promptVersion: "test", routedTo: "review_queue",
    });
    expect(await db.listInboxThreads(orgId)).toEqual([]);
    await expect(db.saveClassification(orgId, {
      messageId: incoming.messageId, label: "brand_deal", confidence: 0.2, language: "en",
      valueMinMinor: 1, valueMaxMinor: 2, rationale: "bad", modelVersion: "test", promptVersion: "test", routedTo: "inbox",
    })).rejects.toThrow("low_confidence_must_route_to_review_queue");
    await db.reviewClassification(orgId, { classificationId: classification.id, seatId: created.seat.id, outcome: "overridden", overrideLabel: "brand_deal" });
    const inbox = await db.listInboxThreads(orgId);
    expect(inbox).toHaveLength(1);
    await db.saveClassification(orgId, {
      messageId: incoming.messageId, label: "spam", confidence: 0.99, language: "en",
      valueMinMinor: null, valueMaxMinor: null, rationale: "late retry", modelVersion: "test2", promptVersion: "test2", routedTo: "inbox",
    });
    const persisted = await prisma.classification.findUniqueOrThrow({ where: { id: classification.id } });
    expect(persisted.label).toBe("brand_deal");
  });

  it("keeps ambiguous human-approved sends unretryable and hard-deletes all org residue", async () => {
    const created = await organization();
    const orgId = db.asOrgId(created.org.id);
    await expect(db.setVoiceEnabled(orgId, created.seat.id, true)).rejects.toThrow("voice_consent_required");
    await db.setVoiceConsent(orgId, created.igAccount.id, created.seat.id, true);
    await db.setVoiceEnabled(orgId, created.seat.id, true);
    const incoming = await db.upsertInboundMessage(orgId, {
      igAccountId: created.igAccount.id, igThreadId: "send-thread", participantHandle: "buyer",
      participantIgId: "buyer", igMessageId: `send-${created.org.id}`, direction: "inbound", text: "Hello", sentAt: new Date(),
    });
    if (!("threadId" in incoming)) throw new Error("inbound write failed");
    const draft = await db.createDraft(orgId, { threadId: incoming.threadId, body: "Hello!", modelVersion: "test", promptVersion: "test" });
    const claimed = await db.createSendIntentClaim(orgId, { draftId: draft.id, seatId: created.seat.id, finalText: "Hello!", idempotencyKey: `intent-${created.org.id}` });
    expect(claimed.claimed).toBe(true);
    await db.markSendIntentUnknown(orgId, claimed.intentId, "timeout after request body");
    const retry = await db.createSendIntentClaim(orgId, { draftId: draft.id, seatId: created.seat.id, finalText: "Hello!", idempotencyKey: `intent-${created.org.id}` });
    expect(retry).toMatchObject({ claimed: false, status: "unknown" });
    await db.hardDeleteOrg(created.org.id);
    organizations.splice(organizations.indexOf(created.org.id), 1);
    expect(await db.countOrgResidue(created.org.id)).toEqual({
      org: 0, accounts: 0, threads: 0, messages: 0, classifications: 0, drafts: 0, sendIntents: 0,
      ledger: 0, audit: 0, subs: 0, billingEvents: 0, ignores: 0, outbox: 0, webhookScopes: 0, voice: 0, checkpoints: 0, pushes: 0,
      voiceRules: 0, draftFeedback: 0, offers: 0, speakingVoices: 0, audioAssets: 0,
    });
  });
  it("refuses invalid region settings without breaking the existing workspace calendar", async () => {
    const created = await organization();
    const orgId = db.asOrgId(created.org.id);
    await expect(db.updateRegion(orgId, created.seat.id, { timezone: "Mars/Olympus" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(db.updateRegion(orgId, created.seat.id, { locale: "not a locale" })).rejects.toMatchObject({ statusCode: 400 });
    expect(await db.getOrganization(orgId)).toMatchObject({ timezone: "Asia/Kolkata", locale: "en-IN" });
    expect((await db.getLedger(orgId)).timezone).toBe("Asia/Kolkata");
  });
  it("counts one leak-scan opportunity per unanswered thread using its latest qualifying message", async () => {
    const created = await organization();
    const orgId = db.asOrgId(created.org.id);
    async function classified(suffix: string, sentAt: string, min: number) {
      const message = await db.upsertInboundMessage(orgId, {
        igAccountId: created.igAccount.id, igThreadId: "leak-same-thread", participantHandle: "buyer",
        participantIgId: "buyer", igMessageId: `leak-${suffix}-${created.org.id}`,
        direction: "inbound", text: "Interested", sentAt: new Date(sentAt),
      });
      if (!("messageId" in message)) throw new Error("leak scan fixture failed");
      await db.saveClassification(orgId, {
        messageId: message.messageId, label: "brand_deal", confidence: 0.99, language: "en",
        valueMinMinor: min, valueMaxMinor: min * 2, rationale: "enquiry", modelVersion: "test",
        promptVersion: "test", routedTo: "inbox", source: "leak_scan",
      });
    }
    // Save out of message order to prove selection is by message time.
    await classified("new", "2026-03-02T00:00:00.000Z", 200);
    await classified("old", "2026-03-01T00:00:00.000Z", 100);
    const summary = await db.getLeakScanSummary(orgId);
    expect(summary).toMatchObject({ scannedCount: 2, commerceCount: 1, totalMinMinor: 200 });
    expect(summary.topThreads).toHaveLength(1);
    expect(summary.topThreads[0]).toMatchObject({ handle: "buyer", estValueMaxMinor: 400 });
  });

});
