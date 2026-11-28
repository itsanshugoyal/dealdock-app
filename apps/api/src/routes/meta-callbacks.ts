import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { createMetaDeletionRequest, deauthorizeMetaUser, getMetaDeletionStatus } from "@dealdock/db";
import { getRetentionQueue } from "../queues";

/**
 * Meta's Deauthorize and Data Deletion Request callbacks (App Review requirement;
 * docs/meta-app-review.md). Set in the Meta app:
 *   Deauthorize callback URL:   https://api.dealdock.io/meta/deauthorize
 *   Data deletion request URL:  https://api.dealdock.io/meta/data-deletion
 * Meta POSTs a form with `signed_request`, signed with the app secret.
 */

/**
 * `<base64url HMAC-SHA256 signature>.<base64url JSON payload>`, signed over the
 * encoded payload. Returns Meta's user id, or null for anything not signed by us.
 */
export function parseSignedRequest(signedRequest: string, appSecret: string): string | null {
  const parts = signedRequest.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || !appSecret) return null;
  const [encodedSig, encodedPayload] = parts as [string, string];
  const given = Buffer.from(encodedSig, "base64url");
  const expected = createHmac("sha256", appSecret).update(encodedPayload).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as { algorithm?: unknown; user_id?: unknown };
    if (typeof payload.algorithm !== "string" || payload.algorithm.toUpperCase() !== "HMAC-SHA256") return null;
    const userId = typeof payload.user_id === "string" || typeof payload.user_id === "number" ? String(payload.user_id) : "";
    return /^\d{1,32}$/.test(userId) ? userId : null;
  } catch {
    return null;
  }
}

/** Verifies the callback; answers 503 / 400 itself and returns null when it isn't valid. */
function verifiedUserId(body: unknown, reply: FastifyReply): string | null {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    void reply.code(503).send({ error: "meta_app_not_configured" });
    return null;
  }
  const signed = (body as { signed_request?: unknown } | null)?.signed_request;
  const userId = typeof signed === "string" && signed.length <= 4096 ? parseSignedRequest(signed, secret) : null;
  if (!userId) void reply.code(400).send({ error: "invalid_signed_request" });
  return userId;
}

const CODE = /^[0-9a-f]{32}$/;

function statusPage(title: string, text: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} · DealDock</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p><p style="color:#666;font-size:.9rem">Questions: see dealdock.io/data-deletion.</p></body></html>`;
}

const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export async function metaCallbackRoutes(app: FastifyInstance) {
  // Meta posts application/x-www-form-urlencoded. Scoped to this plugin, so no other route accepts form bodies.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  /** The person removed DealDock in Instagram or Facebook: stop syncing and drop the tokens. */
  app.post("/meta/deauthorize", async (req, reply) => {
    const userId = verifiedUserId(req.body, reply);
    if (!userId) return reply;
    const accounts = await deauthorizeMetaUser(userId);
    req.log.info({ accounts }, "meta deauthorize callback"); // counts only, never ids
    return { ok: true };
  });

  /** The person asked Meta to delete their data: disconnect now, delete in the worker, and give Meta a status link. */
  app.post("/meta/data-deletion", async (req, reply) => {
    const userId = verifiedUserId(req.body, reply);
    if (!userId) return reply;
    await deauthorizeMetaUser(userId);
    const request = await createMetaDeletionRequest(userId);
    // Start now; the daily retention tick picks it up if Redis is unavailable.
    await getRetentionQueue()
      .add("meta-data-deletion", {}, { removeOnComplete: true, removeOnFail: 100 })
      .catch((err: Error) => req.log.warn({ err: err.message }, "meta deletion: queue unavailable, the daily tick will run it"));
    const base = (process.env.PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
    return { url: `${base}/meta/data-deletion/status?code=${request.confirmationCode}`, confirmation_code: request.confirmationCode };
  });

  /** The page Meta shows the person: the request's status by its confirmation code. */
  app.get("/meta/data-deletion/status", async (req, reply) => {
    const code = (req.query as { code?: unknown }).code;
    const request = typeof code === "string" && CODE.test(code) ? await getMetaDeletionStatus(code) : null;
    reply.type("text/html; charset=utf-8").header("Cache-Control", "no-store");
    if (!request) return reply.code(404).send(statusPage("Request not found", "There is no data deletion request with this confirmation code."));
    if (request.status === "completed" && request.completedAt) {
      return statusPage("Your data has been deleted", `DealDock deleted the data it held from your Instagram account on ${day(request.completedAt)} (confirmation code ${code}).`);
    }
    return statusPage(
      "Deletion in progress",
      `DealDock received your request on ${day(request.createdAt)} (confirmation code ${code}). Instagram is already disconnected, and the data DealDock held from your account is being deleted. This usually finishes within a day, and always within 30 days.`,
    );
  });
}
