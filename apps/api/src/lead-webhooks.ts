import { createHmac, timingSafeEqual } from "node:crypto";
import type { LeadSourceProvider } from "@dealdock/core";

/**
 * Signature checks for booking and payment tools that report back (the coach
 * pipeline). One pure function per tool, over the raw body and the tool's
 * signing secret; parsing lives in @dealdock/core parseLeadPayload. "other"
 * is authenticated by the secret address alone, and so is Cal.com when the
 * creator gave it no secret.
 */

type Headers = Record<string, string | string[] | undefined>;
export interface SignedRequest {
  headers: Headers;
  rawBody: string;
  secret: string | null;
  now: Date;
}

function header(headers: Headers, name: string): string {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** Constant-time comparison of a hex signature with the expected one. */
function sameHex(given: string, expected: string): boolean {
  const value = given.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(value) || value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(expected, "hex"));
}

/** "t=1730000000,v1=abc…[,v1=def…]": a timestamp in seconds and one or more signatures. */
function timestamped(value: string): { t: number | null; v1: string[] } {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of value.split(",")) {
    const [key, ...rest] = part.trim().split("=");
    const item = rest.join("=");
    if (key === "t" && /^\d{1,12}$/.test(item)) t = Number(item);
    if (key === "v1" && item) v1.push(item);
  }
  return { t, v1 };
}

/** HMAC-SHA256 over `${t}.${rawBody}`, any v1 matching, within `toleranceSeconds` of now. */
function verifyTimestamped(signature: string, { rawBody, secret, now }: SignedRequest, toleranceSeconds: number): boolean {
  if (!secret) return false;
  const { t, v1 } = timestamped(signature);
  if (t === null || Math.abs(now.getTime() / 1000 - t) > toleranceSeconds) return false;
  const expected = hmacHex(secret, `${t}.${rawBody}`);
  return v1.some((candidate) => sameHex(candidate, expected));
}

export const LEAD_VERIFIERS: Record<LeadSourceProvider, (request: SignedRequest) => boolean> = {
  // Calendly-Webhook-Signature: t=…,v1=…; older than 3 minutes is a replay.
  calendly: (request) => verifyTimestamped(header(request.headers, "calendly-webhook-signature"), request, 180),
  // x-cal-signature-256: hex HMAC of the body, when the creator set a secret.
  cal_com: (request) => request.secret === null || sameHex(header(request.headers, "x-cal-signature-256"), hmacHex(request.secret, request.rawBody)),
  // X-Razorpay-Signature: hex HMAC of the raw body.
  razorpay: (request) => request.secret !== null && sameHex(header(request.headers, "x-razorpay-signature"), hmacHex(request.secret, request.rawBody)),
  // Stripe-Signature: t=…,v1=…[,v1=…] (several during a secret rotation), 5 minutes' tolerance.
  stripe: (request) => verifyTimestamped(header(request.headers, "stripe-signature"), request, 300),
  other: () => true,
};

/**
 * Calendly has no webhook form: DealDock uses the creator's personal access
 * key once to subscribe this address to new bookings, signed with a key it
 * made, and never stores the access key.
 */
export async function subscribeCalendly(accessKey: string, address: string, signingKey: string, request: typeof fetch = fetch): Promise<"connected" | "invalid_key" | "failed"> {
  const headers = { Authorization: `Bearer ${accessKey}`, "Content-Type": "application/json" };
  const refused = (status: number) => status === 401 || status === 403;
  try {
    const me = await request("https://api.calendly.com/users/me", { headers, signal: AbortSignal.timeout(10_000) });
    if (refused(me.status)) return "invalid_key";
    if (!me.ok) return "failed";
    const resource = ((await me.json()) as { resource?: { uri?: unknown; current_organization?: unknown } }).resource;
    if (typeof resource?.uri !== "string" || typeof resource.current_organization !== "string") return "failed";
    const created = await request("https://api.calendly.com/webhook_subscriptions", {
      method: "POST",
      headers,
      body: JSON.stringify({ url: address, events: ["invitee.created"], organization: resource.current_organization, user: resource.uri, scope: "user", signing_key: signingKey }),
      signal: AbortSignal.timeout(10_000),
    });
    return created.ok ? "connected" : refused(created.status) ? "invalid_key" : "failed";
  } catch {
    return "failed";
  }
}
