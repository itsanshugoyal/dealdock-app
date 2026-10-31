import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchIgProfile,
  subscribeToInstagramWebhooks,
} from "@dealdock/messaging";
import { connectGraphAccount, disconnectAccount, getOrganization } from "@dealdock/db";
import { requireAuth } from "../auth";
import { AccountRef, requireIgAccount, requirePermission, requireWritable } from "../guards";

function oauthConfig() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.IG_OAUTH_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) return null;
  try {
    const callback = new URL(redirectUri);
    const localHttp = process.env.NODE_ENV !== "production" && callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname);
    if ((!localHttp && callback.protocol !== "https:") || callback.username || callback.password || callback.hash || callback.search || callback.pathname !== "/ig/callback") return null;
  } catch { return null; }
  return { appId, appSecret, redirectUri };
}

/** Signed state ties the callback to the initiating org — CSRF protection. */
function signState(orgId: string, secret: string): string {
  const payload = `${orgId}.${Date.now()}`;
  // Full 256-bit HMAC (not truncated to 64 bits) — F10.
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

function verifyState(state: string, secret: string): string | null {
  try {
    const [orgId, ts, sig] = Buffer.from(state, "base64url").toString().split(".");
    if (!orgId || !ts || !sig) return null;
    const expected = createHmac("sha256", secret).update(`${orgId}.${ts}`).digest("hex");
    // Timing-safe comparison, consistent with every other signature check in
    // the codebase — a plain !== leaks the signature byte-by-byte (F10).
    if (sig.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
    const issuedAt = Number(ts);
    if (!Number.isSafeInteger(issuedAt) || issuedAt > Date.now() || Date.now() - issuedAt > 15 * 60_000) return null;
    return orgId;
  } catch {
    return null;
  }
}

export async function igRoutes(app: FastifyInstance) {
  /** Start OAuth (PRD §5.1.3): returns the authorize URL for the client to open. */
  app.post("/ig/connect", { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] }, async (req, reply) => {
    const cfg = oauthConfig();
    if (!cfg) return reply.code(503).send({ error: "meta_app_not_configured" });
    const url = buildAuthorizeUrl(cfg, signState(req.auth!.orgId, cfg.appSecret));
    return { authorizeUrl: url };
  });

  /**
   * OAuth callback — code → long-lived token → profile. PERSONAL accounts are
   * rejected with the switch guidance (PRD §6.1); the UI renders the friendly
   * interstitial from this error.
   */
  app.get("/ig/callback", async (req, reply) => {
    const cfg = oauthConfig();
    if (!cfg) return reply.code(503).send({ error: "meta_app_not_configured" });

    const { code, state, error_description } = req.query as Record<string, string | undefined>;
    if (error_description) {
      return reply.code(400).send({ error: "oauth_denied", detail: error_description });
    }
    const orgId = state ? verifyState(state, cfg.appSecret) : null;
    if (!code || !orgId) return reply.code(400).send({ error: "invalid_state_or_code" });

    const org = await getOrganization(orgId as never);
    if (!org) return reply.code(404).send({ error: "org_not_found" });

    // Upstream failures return a clean 502 — Meta error bodies are logged
    // server-side only, never surfaced to the browser (M5 audit).
    let accessToken: string;
    let expiresIn: number;
    let profile: Awaited<ReturnType<typeof fetchIgProfile>>;
    try {
      ({ accessToken, expiresIn } = await exchangeCodeForToken(cfg, code));
      profile = await fetchIgProfile({}, accessToken);
    } catch (err) {
      req.log.error({ err: (err as Error).message }, "ig oauth exchange failed");
      return reply.code(502).send({ error: "instagram_connection_failed" });
    }

    const type = profile.accountType.toUpperCase();
    if (type !== "BUSINESS" && type !== "MEDIA_CREATOR" && type !== "CREATOR") {
      return reply.code(409).send({
        error: "personal_account",
        guidance:
          "This is a Personal Instagram account. Switch to a free Professional account (Settings → Account type → Switch to professional — takes ~2 minutes), then reconnect.",
      });
    }

    await subscribeToInstagramWebhooks({}, accessToken, profile.userId);
    const account = await connectGraphAccount(orgId as never, {
      igUserId: profile.userId,
      handle: profile.username,
      accountType: type === "BUSINESS" ? "business" : "creator",
      accessToken,
      expiresIn,
    });

    // Web app shows the "connected" state; Leak Scan can start from here.
    return reply.redirect(
      `${process.env.WEB_APP_URL ?? "http://localhost:3100"}/onboarding?connected=${account.handle}`
    );
  });

  /** Disconnect the account Settings picked (404 if it is not this org's); without one, the first active account. */
  app.post("/ig/disconnect", { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] }, async (req, reply) => {
    const parsed = AccountRef.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const auth = req.auth!;
    const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    await disconnectAccount(auth.orgId, account.id, auth.seatId);
    return { disconnected: true };
  });
}
