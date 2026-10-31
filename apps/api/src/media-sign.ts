import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring media links (ADR: no object storage in pilot — audio bytes
 * live in AudioAsset and are served by GET /media/a/:id). The signature binds
 * asset id + expiry, so a link can be handed to Meta's fetcher or an <audio>
 * element without a bearer token, and stops working after the TTL.
 */

const DEFAULT_TTL_SECONDS = 15 * 60;
let devKey: Buffer | null = null;

function signingKey(): Buffer {
  const configured = process.env.MEDIA_SIGNING_KEY;
  if (configured && configured.length >= 32) return Buffer.from(configured, "utf8");
  if (process.env.NODE_ENV === "production") throw new Error("MEDIA_SIGNING_KEY (>=32 chars) is required in production");
  // Development only: a per-process key, so links die with the process.
  devKey ??= randomBytes(32);
  return devKey;
}

function signature(assetId: string, exp: number): string {
  return createHmac("sha256", signingKey()).update(`${assetId}.${exp}`).digest("hex");
}

/** Path for in-app playback; the web client prefixes its API base. */
export function signMediaPath(assetId: string, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  return `/media/a/${encodeURIComponent(assetId)}?exp=${exp}&sig=${signature(assetId, exp)}`;
}

/** Absolute https URL Meta's servers can fetch when sending a voice note. */
export function publicMediaUrl(assetId: string, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now()): string {
  const base = process.env.PUBLIC_API_URL;
  if (!base || !/^https:\/\//.test(base)) {
    throw Object.assign(new Error("public_media_url_unconfigured"), { statusCode: 409 });
  }
  return `${base.replace(/\/$/, "")}${signMediaPath(assetId, ttlSeconds, now)}`;
}

export function verifyMediaSignature(assetId: string, exp: unknown, sig: unknown, now = Date.now()): boolean {
  const expiry = typeof exp === "string" ? Number(exp) : NaN;
  if (!Number.isSafeInteger(expiry) || expiry * 1000 < now || typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = Buffer.from(signature(assetId, expiry), "hex");
  const given = Buffer.from(sig, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
