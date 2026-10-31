import { toneWav } from "./wav";

/**
 * Download an inbound Instagram voice note by its signed CDN URL (research 03
 * §4.2). Meta's links expire, so the worker fetches immediately and keeps the
 * bytes. SSRF guard: https only, an allowlist of Meta CDN hosts re-checked on
 * every redirect, a hard 25 MB cap and one overall timeout. No token is ever
 * attached — this is not a Graph call. The host list comes from third-party
 * reports (Meta documents none), so treat it as provisional.
 */

const ALLOWED_HOSTS = new Set(["lookaside.fbsbx.com"]);
const ALLOWED_HOST_SUFFIXES = [".fbcdn.net", ".cdninstagram.com"];
/** Instagram's audio attachment cap; AudioAsset enforces the same bound in SQL. */
export const MAX_INBOUND_MEDIA_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
/** URL scheme of the mock adapter's fixture voice note; refused unless explicitly allowed. */
export const MOCK_MEDIA_SCHEME = "mock-media:";

/** unavailable = the link expired or is gone; rejected = unsafe or not audio; failed = transient. */
export type InboundMediaFailure = "unavailable" | "rejected" | "failed";

export class InboundMediaError extends Error {
  constructor(public readonly reason: InboundMediaFailure, public readonly code: string) {
    super(`inbound_media_${reason}: ${code}`);
    this.name = "InboundMediaError";
  }
}

export interface InboundAudio {
  bytes: Uint8Array;
  /** Sniffed from the bytes: voice notes are often labelled video/mp4. */
  mimeType: string;
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  /** Non-production only: serve the mock adapter's fixture voice note. */
  allowMockScheme?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
}

export function isAllowedMediaUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    (url.port === "" || url.port === "443") &&
    (ALLOWED_HOSTS.has(host) || ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)))
  );
}

export async function downloadInboundAudio(url: string, opts: DownloadOptions = {}): Promise<InboundAudio> {
  if (url.startsWith(MOCK_MEDIA_SCHEME)) {
    if (!opts.allowMockScheme) throw new InboundMediaError("rejected", "mock_scheme_refused");
    return { bytes: toneWav(4_000), mimeType: "audio/wav" };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_INBOUND_MEDIA_BYTES;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  let current = url;
  for (let hop = 0; ; hop += 1) {
    if (!isAllowedMediaUrl(current)) {
      throw new InboundMediaError("rejected", hop ? "redirect_host_not_allowed" : "host_not_allowed");
    }
    let res: Response;
    try {
      // Redirects are followed by hand so every hop passes the allowlist.
      res = await fetchImpl(current, { redirect: "manual", signal });
    } catch (error) {
      throw transportError(error);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location || hop >= MAX_REDIRECTS) throw new InboundMediaError("failed", "redirect_loop");
      try {
        current = new URL(location, current).toString();
      } catch {
        throw new InboundMediaError("rejected", "redirect_invalid");
      }
      continue;
    }
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      throw new InboundMediaError("unavailable", `http_${res.status}`);
    }
    if (!res.ok || !res.body) throw new InboundMediaError("failed", `http_${res.status}`);
    if (Number(res.headers.get("content-length")) > maxBytes) throw new InboundMediaError("rejected", "too_large");
    const bytes = await readCapped(res.body, maxBytes);
    const mimeType = sniffAudioMimeType(bytes);
    if (!mimeType) throw new InboundMediaError("rejected", "not_audio");
    return { bytes, mimeType };
  }
}

async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new InboundMediaError("rejected", "too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    throw error instanceof InboundMediaError ? error : transportError(error);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function transportError(error: unknown): InboundMediaError {
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return new InboundMediaError("failed", timedOut ? "timeout" : "network_error");
}

/** Container/codec from magic bytes; null when the payload is not audio we can store and play. */
export function sniffAudioMimeType(bytes: Uint8Array): string | null {
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length < 12) return null;
  if (text(0, 4) === "RIFF" && text(8, 4) === "WAVE") return "audio/wav";
  if (text(4, 4) === "ftyp") return "audio/mp4";
  if (text(0, 4) === "OggS") return "audio/ogg";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  if (text(0, 5) === "#!AMR") return "audio/amr";
  if (text(0, 3) === "ID3") return "audio/mpeg";
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0) return "audio/aac"; // ADTS sync, layer 00
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return "audio/mpeg"; // MPEG audio frame sync
  return null;
}
