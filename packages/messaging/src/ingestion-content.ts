import type { IngestionJob } from "@dealdock/core";
import type { RemoteMessage } from "./provider";

const MAX_MEDIA_URL = 4096;
const MAX_MEDIA_KIND = 40;

/**
 * The ingestion outbox dedupe key for one platform message on one connected
 * account. The webhook and the Graph backfill share it, so a message both
 * deliver is written and ingested once. Account ids are unique across orgs.
 */
export function ingestionDedupeKey(igAccountId: string, platformMessageId: string): string {
  return `instagram:ingestion:${igAccountId}:${platformMessageId}`;
}

/**
 * The content fields of an IngestionJob for a parsed or fetched message,
 * shared by the webhook and the Graph backfill so both store voice notes
 * alike. Values that would fail the job's validation are dropped (the note
 * is then "unavailable") instead of losing the whole message.
 */
export function ingestionContent(
  message: RemoteMessage
): Pick<IngestionJob, "contentType" | "mediaUrl" | "mediaKind" | "threadSource"> {
  const media = message.media;
  return {
    // Voice notes are detected by attachment type, never by MIME (often video/mp4).
    contentType: media?.kind === "audio" ? "audio" : message.text ? "text" : "attachment",
    ...(media?.url && media.url.length <= MAX_MEDIA_URL ? { mediaUrl: media.url } : {}),
    ...(media ? { mediaKind: media.kind.slice(0, MAX_MEDIA_KIND) || "unknown" } : {}),
    ...(message.threadSource ? { threadSource: message.threadSource } : {}),
  };
}
