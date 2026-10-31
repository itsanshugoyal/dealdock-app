import { Worker, type Job } from "bullmq";
import { IngestionJob, QUEUES } from "@dealdock/core";
import {
  asOrgId,
  completeInboundMedia,
  touchWebhookCheckpoint,
  upsertInboundMessage,
  getIngestionOutboxPayload,
  type OrgId,
} from "@dealdock/db";
import {
  InboundMediaError,
  SpeechProviderError,
  createSpeechProvider,
  downloadInboundAudio,
  wavDurationMs,
  type Transcript,
} from "@dealdock/speech";
import { redisConnection } from "../connection";

/**
 * Ingestion consumer: webhook/backfill events → Thread + Message rows
 * (idempotent via igMessageId — ARCHITECTURE.md §4.3), then inbound messages
 * are handed to the classification queue.
 */
export function startIngestionWorker() {
  const worker = new Worker(
    QUEUES.ingestion,
    async (job: Job) => {
      let payload=job.data;
      if (typeof payload?.ingressEventId === "string" && typeof payload?.orgId === "string") {
        const scoped=await getIngestionOutboxPayload(asOrgId(payload.orgId),payload.ingressEventId);
        if (!scoped) return {skipped:"ingress_deleted"};
        payload={...(scoped as object),orgId:payload.orgId};
      } else if (process.env.NODE_ENV === "production") {
        throw new Error("production_ingestion_requires_a_durable_reference");
      }
      const data = IngestionJob.parse(payload);
      const orgId = asOrgId(data.orgId);

      const result = await upsertInboundMessage(orgId, {
        igAccountId: data.igAccountId,
        igThreadId: data.igThreadId,
        participantHandle: data.participantHandle,
        participantIgId: data.participantIgId,
        igMessageId: data.igMessageId,
        direction: data.direction,
        contentType: data.contentType,
        text: data.text,
        sentAt: new Date(data.sentAt),
        raw: data.raw,
        source: data.source,
        mediaUrl: data.contentType === "audio" ? data.mediaUrl : undefined,
        threadSource: data.threadSource,
      });

      await touchWebhookCheckpoint(orgId, data.igAccountId);

      // Meta's media links expire: fetch a new voice note now. Its
      // classification hand-off is held until this settles (see
      // VOICE_NOTE_CLASSIFICATION_HOLD_MS), so the classifier gets the transcript.
      if ("mediaPending" in result && result.mediaPending && data.mediaUrl) {
        await settleVoiceNote(orgId, result.messageId, data.mediaUrl);
      }

      // `upsertInboundMessage` writes the classification outbox row in the
      // same DB transaction as the message. The dispatcher publishes that
      // row only after commit and can recover it after a crash.
      return result;
    },
    {
      connection: redisConnection(),
      concurrency: 10,
    }
  );

  worker.on("failed", (job, err) => {
    // Message bodies never enter logs (ARCHITECTURE.md §8).
    console.error(`ingestion job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}

/**
 * Download (allowlisted Meta CDN, 25 MB cap) and keep a voice note, then
 * transcribe it when a speech provider is configured. A failed download
 * settles the message as failed/unavailable, which keeps today's "needs your
 * ear" review routing. Logs carry ids and error codes only — never audio or text.
 */
async function settleVoiceNote(orgId: OrgId, messageId: string, mediaUrl: string) {
  let audio;
  try {
    audio = await downloadInboundAudio(mediaUrl, { allowMockScheme: process.env.NODE_ENV !== "production" });
  } catch (error) {
    const reason = error instanceof InboundMediaError ? error.reason : "failed";
    console.warn(`voice note ${messageId} not stored: ${error instanceof InboundMediaError ? error.code : "download_error"}`);
    await completeInboundMedia(orgId, messageId, { status: reason === "unavailable" ? "unavailable" : "failed" });
    return;
  }

  let transcript: Transcript | undefined;
  const speech = createSpeechProvider();
  if (speech) {
    try {
      transcript = await speech.transcribe(audio);
    } catch (error) {
      console.warn(`voice note ${messageId} not transcribed: ${error instanceof SpeechProviderError ? error.code : "transcribe_error"}`);
    }
  }

  await completeInboundMedia(orgId, messageId, {
    status: "ready",
    audio: { ...audio, durationMs: wavDurationMs(audio.bytes) ?? transcript?.durationMs ?? null },
    transcript: transcript?.text || null,
    transcriptLanguage: transcript?.language ?? null,
  });
}
