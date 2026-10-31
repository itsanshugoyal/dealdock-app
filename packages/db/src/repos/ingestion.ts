import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { advanceThreadClocks } from "../thread-writes";

export interface InboundMessageInput {
  igAccountId: string;
  igThreadId: string;
  participantHandle: string;
  participantIgId: string;
  igMessageId: string;
  direction: "inbound" | "outbound";
  contentType?: "text" | "audio" | "attachment";
  text: string;
  sentAt: Date;
  raw?: unknown;
  source?: "live" | "leak_scan";
  /** Signed CDN URL of an inbound voice note; the worker downloads it right after this write (F8). */
  mediaUrl?: string;
  /** Where the conversation started, when Instagram says so. The first known value is kept. */
  threadSource?: "dm" | "story" | "reel" | "ad" | "link";
}

/**
 * How long a fresh voice note's classification waits for the worker to
 * download and transcribe it. The worker releases the hold as soon as it is
 * done; if the worker dies first, the hold simply lapses and the note is
 * classified without a transcript ("needs your ear") — never lost.
 */
export const VOICE_NOTE_CLASSIFICATION_HOLD_MS = 5 * 60_000;

/**
 * Idempotent ingestion write: upserts the thread, inserts the message unless
 * its igMessageId was already seen (Meta redelivers; unique constraint is the
 * dedup — ARCHITECTURE.md §4.3).
 */
export async function upsertInboundMessage(orgId: OrgId, input: InboundMessageInput) {
  return prisma.$transaction(async (tx) => {
    const account = await tx.igAccount.findFirst({
      where: { id: input.igAccountId, orgId },
      select: { id: true, status: true },
    });
    if (!account) throw new Error(`IgAccount ${input.igAccountId} not in org ${orgId}`);
    // Disconnect stops ingestion immediately (PRD §6.1).
    if (account.status !== "active") return { skipped: "account_inactive" as const };

    // Webhooks only know the sender's IGSID; adopt the real username as soon
    // as any delivery (Graph history, backfill) carries one (05b gap 13).
    if (input.participantHandle && input.participantHandle !== input.participantIgId) {
      await tx.thread.updateMany({
        where: {
          orgId,
          igAccountId: input.igAccountId,
          igThreadId: input.igThreadId,
          participantHandle: input.participantIgId,
        },
        data: { participantHandle: input.participantHandle },
      });
    }

    // Dedupe before touching thread timestamps. A delayed replay must not make
    // a conversation look older, nor trigger a second classification job.
    const existing = await tx.message.findUnique({
      where: { igMessageId: input.igMessageId },
      select: { id: true, orgId: true, threadId: true },
    });
    if (existing) {
      if (existing.orgId !== orgId) throw new Error("ig_message_id_cross_org_collision");
      return { skipped: "duplicate" as const, threadId: existing.threadId };
    }

    const thread = await tx.thread.upsert({
      where: {
        igAccountId_igThreadId: {
          igAccountId: input.igAccountId,
          igThreadId: input.igThreadId,
        },
      },
      create: {
        orgId,
        igAccountId: input.igAccountId,
        igThreadId: input.igThreadId,
        participantHandle: input.participantHandle,
        participantIgId: input.participantIgId,
        lastMessageAt: input.sentAt,
        lastInboundAt: input.direction === "inbound" ? input.sentAt : null,
      },
      update: {},
    });
    // First known origin wins: a backfill may have created the thread before
    // the webhook said it started as a story reply or an ad.
    if (input.direction === "inbound" && input.threadSource) {
      await tx.thread.updateMany({ where: { id: thread.id, source: null }, data: { source: input.threadSource } });
    }

    // Backfills and webhook echoes can arrive out of order. Never move a
    // conversation/checkpoint backwards just because an older delivery won a
    // race; this applies to outbound echoes as well as inbound messages.
    await advanceThreadClocks(tx, thread.id, input.direction, input.sentAt);
    await tx.ingestionCheckpoint.upsert({
      where: { igAccountId: input.igAccountId },
      create: { orgId, igAccountId: input.igAccountId, lastIgMessageTimestamp: input.sentAt },
      update: {},
    });
    await tx.ingestionCheckpoint.updateMany({
      where: {
        orgId,
        igAccountId: input.igAccountId,
        OR: [{ lastIgMessageTimestamp: null }, { lastIgMessageTimestamp: { lt: input.sentAt } }],
      },
      data: { lastIgMessageTimestamp: input.sentAt },
    });

    // Webhook deliveries carry only the IGSID, so also match the username the
    // thread has since learned — an ignored sender's voice note must never
    // reach the downloader or a speech vendor.
    const handles = [...new Set([input.participantHandle, thread.participantHandle].map((h) => h.replace(/^@/, "").toLowerCase()))];
    const ignored = input.direction === "inbound" && Boolean(await tx.ignoreListEntry.findFirst({
      where: {
        orgId,
        handle: { in: handles },
        OR: [{ igAccountId: input.igAccountId }, { igAccountId: null }],
      },
      select: { id: true },
    }));

    // Provenance is decided once, on create (research 04 §3): an echo of our
    // own human-approved send is "dealdock", anything else typed in Instagram
    // is "native". Inbound messages carry no origin.
    const intent = input.direction === "outbound"
      ? await tx.sendIntent.findFirst({
          where: { orgId, platformMessageId: input.igMessageId },
          select: { finalText: true, asVoice: true, audioAssetId: true },
        })
      : null;
    const voiceAssetId = intent?.asVoice && intent.audioAssetId
      ? (await tx.audioAsset.findFirst({ where: { id: intent.audioAssetId, orgId }, select: { id: true } }))?.id
      : undefined;
    const contentType = voiceAssetId ? "audio" : input.contentType ?? "text";
    // Only inbound voice notes are fetched (classification needs them); ignored
    // senders' audio never reaches the downloader or a speech vendor.
    const mediaPending = contentType === "audio" && input.direction === "inbound" && !ignored && Boolean(input.mediaUrl);
    const message = await tx.message.create({
      data: {
        orgId,
        threadId: thread.id,
        igMessageId: input.igMessageId,
        direction: input.direction,
        contentType,
        // Our voice-note echo has no text: keep the approved words, which is
        // also what the send gate's receipt reconciliation compares against.
        text: voiceAssetId ? intent!.finalText : input.text,
        sentAt: input.sentAt,
        raw: input.raw as never,
        origin: input.direction === "outbound" ? (intent ? "dealdock" : "native") : null,
        ...(voiceAssetId
          ? { audioAssetId: voiceAssetId, mediaStatus: "ready" }
          : contentType === "audio"
            ? { mediaStatus: mediaPending ? "pending" : "unavailable" }
            : {}),
      },
    });

    // A fresh inbound message reopens a waiting thread — the counterparty replied.
    if (input.direction === "inbound") {
      await tx.thread.updateMany({
        where: { id: thread.id, state: "waiting", waitingSince: { lte: input.sentAt } },
        data: { state: "open", waitingSince: null, nudgeDismissedAt: null },
      });
    }

    // Retain raw inbound data for the user's export/delete rights, but make it
    // structurally impossible for ignored handles to reach AI or drafting.
    if (ignored) {
      return { skipped: "ignored" as const, threadId: thread.id };
    }

    // Classification hand-off is also durable. Redis/BullMQ publication is an
    // optimisation after commit; a worker can lease this row after a crash.
    // A voice note's hand-off is held until the worker has its transcript.
    const classificationOutbox = input.direction === "inbound"
      ? await tx.outboxEvent.upsert({
          where: { dedupeKey: `classification:${input.igMessageId}` },
          create: {
            orgId,
            kind: "classification",
            dedupeKey: `classification:${input.igMessageId}`,
            payload: { messageId: message.id, igAccountId: input.igAccountId, source: input.source ?? "live" },
            ...(mediaPending ? { leaseExpiresAt: new Date(Date.now() + VOICE_NOTE_CLASSIFICATION_HOLD_MS) } : {}),
          },
          update: {},
          select: { id: true },
        })
      : null;
    return { threadId: thread.id, messageId: message.id, classificationOutboxId: classificationOutbox?.id, mediaPending };
  });
}

/** Durable classification hand-off for legacy/manual producers. */
export async function enqueueClassificationOutbox(
  orgId: OrgId,
  input: { messageId: string; igAccountId: string; dedupeKey: string; source?: "live" | "leak_scan" },
) {
  return prisma.outboxEvent.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: {
      orgId,
      kind: "classification",
      dedupeKey: input.dedupeKey,
      payload: { messageId: input.messageId, igAccountId: input.igAccountId, source: input.source ?? "live" },
    },
    update: {},
    select: { id: true, dedupeKey: true },
  });
}

/** Fetch a message with the context the classification consumer needs. */
export async function getMessageForClassification(orgId: OrgId, messageId: string) {
  const m = await prisma.message.findFirst({
    where: { id: messageId, orgId, direction: "inbound" },
    include: { thread: { select: { id: true, participantHandle: true, igAccountId: true } } },
  });
  if (!m) return null;
  return {
    id: m.id,
    threadId: m.thread.id,
    igAccountId: m.thread.igAccountId,
    participantHandle: m.thread.participantHandle,
    contentType: m.contentType,
    text: m.text,
    /** Voice notes: what the sender said, when a speech provider transcribed it (F8). */
    transcript: m.transcript,
  };
}

export async function recordWebhookEvent(provider: string, payload: unknown) {
  return prisma.webhookEvent.create({
    data: { provider, payload: payload as never },
  });
}

export async function scopeWebhookEventToOrg(eventId: string, orgId: OrgId) {
  await prisma.webhookEventOrg.upsert({
    where: { webhookEventId_orgId: { webhookEventId: eventId, orgId } },
    create: { webhookEventId: eventId, orgId },
    update: {},
  });
}

export interface IngestionOutboxInput {
  orgId: OrgId;
  dedupeKey: string;
  payload: unknown;
}

/**
 * Atomically persist the raw webhook, privacy scopes, and one deduped ingress
 * record per event. Queue publication happens after this commit and can always
 * be recovered by a worker lease scan.
 */
export async function recordWebhookIngress(
  provider: string,
  payload: unknown,
  events: IngestionOutboxInput[]
) {
  return prisma.$transaction(async (tx) => {
    const uniqueEvents = [...new Map(events.map((event) => [event.dedupeKey, event])).values()];
    const prior = uniqueEvents.length
      ? await tx.outboxEvent.findMany({
          where: { dedupeKey: { in: uniqueEvents.map((event) => event.dedupeKey) } },
          select: { id: true, orgId: true, dedupeKey: true, webhookEventId: true },
        })
      : [];
    for (const row of prior) {
      const attempted = uniqueEvents.find((event) => event.dedupeKey === row.dedupeKey)!;
      if (row.orgId !== attempted.orgId) throw new Error("outbox_dedupe_key_cross_org_collision");
    }
    // Meta routinely redelivers a full webhook. Once every item already has a
    // durable outbox row, retain neither a duplicate payload nor a second
    // unprocessed WebhookEvent. The caller can ACK this idempotent result.
    if (uniqueEvents.length > 0 && prior.length === uniqueEvents.length) {
      return {
        webhookEventId: prior.find((row) => row.webhookEventId)?.webhookEventId ?? null,
        outbox: prior.map((row) => ({ id: row.id, dedupeKey: row.dedupeKey, deduplicated: true })),
        deduplicated: true,
      };
    }
    const webhook = await tx.webhookEvent.create({ data: { provider, payload: payload as never } });
    const freshEvents = uniqueEvents.filter((event) => !prior.some((row) => row.dedupeKey === event.dedupeKey));
    const uniqueOrgs = [...new Set(freshEvents.map((event) => event.orgId))];
    if (uniqueOrgs.length) {
      await tx.webhookEventOrg.createMany({
        data: uniqueOrgs.map((orgId) => ({ webhookEventId: webhook.id, orgId })),
        skipDuplicates: true,
      });
    }
    const outbox = [] as Array<{ id: string; dedupeKey: string; deduplicated: boolean }>;
    for (const event of uniqueEvents) {
      const wasPrior = prior.find((row) => row.dedupeKey === event.dedupeKey);
      const row = await tx.outboxEvent.upsert({
        where: { dedupeKey: event.dedupeKey },
        create: {
          orgId: event.orgId,
          webhookEventId: webhook.id,
          kind: "ingestion",
          dedupeKey: event.dedupeKey,
          payload: event.payload as never,
        },
        update: {},
        select: { id: true, dedupeKey: true },
      });
      outbox.push({ ...row, deduplicated: Boolean(wasPrior) });
    }
    return { webhookEventId: webhook.id, outbox, deduplicated: false };
  });
}

/** A direct outbox write for backfill/scheduled producers (no raw webhook). */
export async function enqueueIngestionOutbox(orgId: OrgId, input: Omit<IngestionOutboxInput, "orgId">) {
  return prisma.outboxEvent.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: { orgId, kind: "ingestion", dedupeKey: input.dedupeKey, payload: input.payload as never },
    update: {},
    select: { id: true, dedupeKey: true },
  });
}

/**
 * Unpublished outbox rows whose lease is free, oldest first, for any number
 * of kinds in one query. Only what the dispatcher needs to route and claim;
 * the claim returns the payload.
 */
export async function listRecoverableOutboxEvents(kinds: string | readonly string[] = "ingestion", limit = 100, now = new Date()) {
  return prisma.outboxEvent.findMany({
    where: {
      kind: { in: typeof kinds === "string" ? [kinds] : [...kinds] },
      processedAt: null,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, kind: true, dedupeKey: true },
  });
}

/** Redis holds a tenant-scoped reference, never a copy of a customer's DM. */
export async function getIngestionOutboxPayload(orgId:OrgId,eventId:string) {
  const row=await prisma.outboxEvent.findFirst({where:{id:eventId,orgId,kind:"ingestion"},select:{payload:true}});
  return row?.payload ?? null;
}

/**
 * Lease, rather than delete, work so a worker crash remains recoverable. One
 * conditional UPDATE … RETURNING: of two racing dispatchers exactly one gets
 * the row (null for the other), with the attempt count after this claim.
 */
export async function claimOutboxEvent(id: string, leaseMs = 60_000, now = new Date()) {
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const [claimed] = await prisma.outboxEvent.updateManyAndReturn({
    where: {
      id,
      processedAt: null,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: { leasedAt: now, leaseExpiresAt, attempts: { increment: 1 }, lastError: null },
    select: { id: true, orgId: true, kind: true, dedupeKey: true, payload: true, attempts: true },
  });
  return claimed ?? null;
}

export async function completeOutboxEvent(id: string) {
  await prisma.outboxEvent.updateMany({
    where: { id, processedAt: null },
    data: { processedAt: new Date(), leaseExpiresAt: null, lastError: null },
  });
}

export async function releaseOutboxEvent(id: string, error: string, delayMs = 30_000) {
  const boundedError = error.slice(0, 500);
  await prisma.outboxEvent.updateMany({
    where: { id, processedAt: null },
    data: {
      lastError: boundedError,
      leaseExpiresAt: new Date(Date.now() + delayMs),
    },
  });
}

/**
 * SYSTEM-CONTEXT retention: rows published before `olderThan` are spent (the
 * message tables, not the outbox, dedupe a later redelivery). Unpublished
 * rows are never touched. Returns a count only.
 */
export async function purgeProcessedOutbox(olderThan: Date) {
  const purged = await prisma.outboxEvent.deleteMany({ where: { processedAt: { lt: olderThan } } });
  return { purgedOutboxEvents: purged.count };
}

export async function markWebhookProcessed(id: string, error?: string) {
  return prisma.webhookEvent.update({
    where: { id },
    data: { processedAt: new Date(), error },
  });
}

export async function touchWebhookCheckpoint(orgId: OrgId, igAccountId: string) {
  return prisma.ingestionCheckpoint.updateMany({
    where: { orgId, igAccountId },
    data: { lastWebhookAt: new Date() },
  });
}
