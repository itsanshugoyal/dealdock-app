import { prisma } from "../client";

/**
 * SYSTEM-CONTEXT retention queries (PRD §6.11, §5.7 — the privacy promises
 * as code, verified by the M5 deletion drill):
 *  - account deletion: 7-day grace after deletionRequestedAt → hard delete
 *  - post-cancellation: ledger read-only 30 days after currentPeriodEnd → hard delete
 * Hard delete = the Organization row cascades through every child table
 * (seats, accounts, threads, messages, classifications, drafts, ledger,
 * voice profiles, voice rules, draft feedback, offers, speaking voices,
 * audio assets, audit logs, subscriptions, push subscriptions).
 *  - audio clips with an expiry: purged by the daily tick once expiresAt passes.
 */

export async function listOrgsDueHardDelete(now = new Date()) {
  const graceCutoff = new Date(now.getTime() - 7 * 864e5);
  const postCancelCutoff = new Date(now.getTime() - 30 * 864e5);

  const [requested, expired] = await Promise.all([
    prisma.organization.findMany({
      where: { deletionRequestedAt: { lte: graceCutoff } },
      select: { id: true, name: true, deletionRequestedAt: true },
    }),
    prisma.organization.findMany({
      where: {
        deletionRequestedAt: null,
        subscription: {
          status: "cancelled",
          currentPeriodEnd: { lte: postCancelCutoff },
        },
      },
      select: { id: true, name: true },
    }),
  ]);

  return [
    ...requested.map((o) => ({ orgId: o.id, reason: "deletion_requested" as const })),
    ...expired.map((o) => ({ orgId: o.id, reason: "post_cancel_expiry" as const })),
  ];
}

/** Irreversible. Cascades wipe every org-scoped row. */
export async function hardDeleteOrg(orgId: string) {
  return prisma.$transaction(async (tx) => {
    const [messageCount, ledgerCount, seats, webhookScopes] = await Promise.all([
      tx.message.count({ where: { orgId } }),
      tx.ledgerEntry.count({ where: { orgId } }),
      tx.seat.findMany({ where: { orgId }, select: { userId: true } }),
      tx.webhookEventOrg.findMany({ where: { orgId }, select: { webhookEventId: true } }),
    ]);
    await tx.organization.delete({ where: { id: orgId } });

    // A user can be a manager in another organization. Delete only identities
    // left without any seats, never a shared collaborator's account.
    const formerUserIds = [...new Set(seats.map((seat) => seat.userId))];
    const users = formerUserIds.length
      ? await tx.user.deleteMany({ where: { id: { in: formerUserIds }, seats: { none: {} } } })
      : { count: 0 };

    // Raw webhooks are deliberately global because a single provider payload
    // can fan out to multiple orgs. Remove only events that were scoped solely
    // to this deleted org; shared payloads remain for the surviving orgs.
    const formerWebhookIds = [...new Set(webhookScopes.map((scope) => scope.webhookEventId))];
    if (formerWebhookIds.length) {
      await tx.webhookEvent.deleteMany({
        where: { id: { in: formerWebhookIds }, orgScopes: { none: {} } },
      });
    }
    return {
      deletedMessages: messageCount,
      deletedLedgerEntries: ledgerCount,
      deletedUsers: users.count,
    };
  });
}

/**
 * SYSTEM-CONTEXT: delete audio clips whose expiresAt has passed, in bounded
 * batches. Messages that pointed at a purged clip lose the link via the
 * SetNull foreign key and are marked mediaStatus "unavailable" in the same
 * transaction, so the UI never offers a player for bytes that are gone.
 * Returns the number of clips removed (counts only; never content in logs).
 */
export async function purgeExpiredAudioAssets(now = new Date(), batchSize = 200) {
  let purged = 0;
  for (;;) {
    const deleted = await prisma.$transaction(async (tx) => {
      const expired = await tx.audioAsset.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true },
        orderBy: { expiresAt: "asc" },
        take: batchSize,
      });
      if (!expired.length) return 0;
      const ids = expired.map((asset) => asset.id);
      await tx.message.updateMany({
        where: { audioAssetId: { in: ids } },
        data: { mediaStatus: "unavailable" },
      });
      const result = await tx.audioAsset.deleteMany({ where: { id: { in: ids } } });
      return result.count;
    });
    purged += deleted;
    if (deleted < batchSize) return { purgedAudioAssets: purged };
  }
}

/** DRILL-ONLY: backdate a deletion request to simulate the grace elapsing. */
export async function backdateDeletionRequest(orgId: string, daysAgo: number) {
  await prisma.organization.update({
    where: { id: orgId },
    data: { deletionRequestedAt: new Date(Date.now() - daysAgo * 864e5) },
  });
}

/**
 * DRILL-ONLY: put one row in every redesign table (voice rule, draft +
 * feedback, offer, speaking voice, audio clips incl. one already expired) so
 * the deletion drill proves they are exported without bytes, purged on
 * expiry and removed by the org cascade. Needs an org with a message.
 */
export async function seedDrillCoverageRows(orgId: string, igAccountId: string, seatId: string) {
  await prisma.$transaction(async (tx) => {
    const message = await tx.message.findFirst({ where: { orgId }, orderBy: { sentAt: "asc" } });
    if (!message) throw new Error("drill_needs_a_message");
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { currencyCode: true } });
    const clip = { mimeType: "audio/mp4", bytes: new Uint8Array([0, 1, 2, 3]), sizeBytes: 4, sha256: "0".repeat(64) };
    const voiceNote = await tx.audioAsset.create({ data: { orgId, kind: "inbound", durationMs: 1000, ...clip } });
    await tx.audioAsset.create({
      data: { orgId, kind: "tts", text: "drill preview", expiresAt: new Date(Date.now() - 60_000), ...clip },
    });
    await tx.message.update({
      where: { id: message.id },
      data: { audioAssetId: voiceNote.id, mediaStatus: "ready", transcript: "drill transcript", durationMs: 1000 },
    });
    const draft = await tx.draft.create({
      data: {
        orgId, threadId: message.threadId, replyToMessageId: message.id, body: "drill draft",
        modelVersion: "drill", promptVersion: "drill", chips: ["too_long"],
      },
    });
    await tx.draftFeedback.create({ data: { orgId, draftId: draft.id, seatId, chips: ["too_long"], note: "drill" } });
    await tx.voiceRule.create({
      data: { orgId, igAccountId, key: "drill", text: "drill rule", source: "user", status: "pinned" },
    });
    await tx.offer.create({
      data: {
        orgId, igAccountId, name: "drill offer", dealType: "coaching",
        priceMinMinor: 100n, priceMaxMinor: 200n, currencyCode: org.currencyCode,
      },
    });
    await tx.speakingVoice.create({
      data: {
        orgId, igAccountId, provider: "mock", status: "ready", consentStatement: "drill consent",
        consentedAt: new Date(), consentSeatId: seatId, sampleSeconds: 1, sampleAssetIds: [voiceNote.id],
      },
    });
  });
}

/** Drill support: prove-it's-gone check after a hard delete. */
export async function countOrgResidue(orgId: string) {
  const [
    org, accounts, threads, messages, classifications, drafts, sendIntents, ledger, audit, subs, ignores, outbox,
    webhookScopes, voice, checkpoints, pushes, billingEvents,
    voiceRules, draftFeedback, offers, speakingVoices, audioAssets,
  ] =
    await Promise.all([
      prisma.organization.count({ where: { id: orgId } }),
      prisma.igAccount.count({ where: { orgId } }),
      prisma.thread.count({ where: { orgId } }),
      prisma.message.count({ where: { orgId } }),
      prisma.classification.count({ where: { orgId } }),
      prisma.draft.count({ where: { orgId } }),
      prisma.sendIntent.count({ where: { orgId } }),
      prisma.ledgerEntry.count({ where: { orgId } }),
      prisma.auditLog.count({ where: { orgId } }),
      prisma.subscription.count({ where: { orgId } }),
      prisma.ignoreListEntry.count({ where: { orgId } }),
      prisma.outboxEvent.count({ where: { orgId } }),
      prisma.webhookEventOrg.count({ where: { orgId } }),
      prisma.voiceProfile.count({ where: { orgId } }),
      prisma.ingestionCheckpoint.count({ where: { orgId } }),
      prisma.pushSubscription.count({ where: { orgId } }),
      prisma.billingEventReceipt.count({where:{orgId}}),
      prisma.voiceRule.count({ where: { orgId } }),
      prisma.draftFeedback.count({ where: { orgId } }),
      prisma.offer.count({ where: { orgId } }),
      prisma.speakingVoice.count({ where: { orgId } }),
      prisma.audioAsset.count({ where: { orgId } }),
    ]);
  return {
    org, accounts, threads, messages, classifications, drafts, sendIntents, ledger, audit, subs, ignores, outbox,
    webhookScopes, voice, checkpoints, pushes, billingEvents,
    voiceRules, draftFeedback, offers, speakingVoices, audioAssets,
  };
}
