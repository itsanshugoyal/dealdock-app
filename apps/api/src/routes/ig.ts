import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  buildAuthorizeUrl,
  buildUnifiedAuthorizeUrl,
  exchangeCodeForToken,
  exchangeUnifiedCode,
  fetchIgProfile,
  fetchUnifiedAccounts,
  IG_COMMENTS_SCOPE,
  IG_INSIGHTS_SCOPE,
  subscribeToInstagramWebhooks,
  type IgProfile,
} from "@dealdock/messaging";
import { connectGraphAccount, disconnectAccount, getOrganization } from "@dealdock/db";
import { requireAuth } from "../auth";
import { isCommentLeadsEnabled, isInsightsEnabled, isUnifiedLoginEnabled } from "../feature-flags";
import { instagramGraphBase } from "../graph";
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
  // Unified Login (new Meta apps): the login configuration replaces scopes. Missing it fails closed.
  const configId = process.env.META_LOGIN_CONFIG_ID?.trim();
  if (isUnifiedLoginEnabled() && !configId) return null;
  return { appId, appSecret, redirectUri, configId };
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
    // Comment leads also need the comments permission (META_COMMENTS_ENABLED, after Meta App Review).
    // Post results ("Fetch from Instagram") also need the insights permission (META_INSIGHTS_ENABLED, after Meta App Review).
    const state = signState(req.auth!.orgId, cfg.appSecret);
    // Unified Login asks for the permissions set in the Meta login configuration, never a scope list.
    if (isUnifiedLoginEnabled()) return { authorizeUrl: buildUnifiedAuthorizeUrl({ ...cfg, configId: cfg.configId! }, state) };
    const scopes = [...(isCommentLeadsEnabled() ? [IG_COMMENTS_SCOPE] : []), ...(isInsightsEnabled() ? [IG_INSIGHTS_SCOPE] : [])];
    const url = buildAuthorizeUrl(cfg, state, scopes);
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
    const unified = isUnifiedLoginEnabled();
    let accessToken: string;
    let expiresIn: number | null;
    let profiles: IgProfile[];
    try {
      if (unified) {
        ({ accessToken, expiresIn } = await exchangeUnifiedCode(cfg, code));
        profiles = await fetchUnifiedAccounts(cfg, accessToken);
      } else {
        ({ accessToken, expiresIn } = await exchangeCodeForToken(cfg, code));
        profiles = [await fetchIgProfile({}, accessToken)];
      }
    } catch (err) {
      req.log.error({ err: (err as Error).message }, "ig oauth exchange failed");
      return reply.code(502).send({ error: "instagram_connection_failed" });
    }
    if (!profiles.length) {
      return reply.code(409).send({
        error: "no_instagram_account",
        guidance: "No Instagram account was shared. Reconnect and choose your Instagram professional account.",
      });
    }

    // Unified Login shares professional accounts only, and their type isn't readable.
    const type = profiles[0]!.accountType.toUpperCase();
    if (!unified && type !== "BUSINESS" && type !== "MEDIA_CREATOR" && type !== "CREATOR") {
      return reply.code(409).send({
        error: "personal_account",
        guidance:
          "This is a Personal Instagram account. Switch to a free Professional account (Settings → Account type → Switch to professional — takes ~2 minutes), then reconnect.",
      });
    }

    // One Unified Login token can cover several accounts: each is connected with it, within the tier cap.
    const connected: Array<{ handle: string }> = [];
    for (const profile of profiles) {
      try {
        await subscribeToInstagramWebhooks({ graphBase: instagramGraphBase() }, accessToken, profile.userId, isCommentLeadsEnabled() ? ["comments", "messages"] : ["messages"]);
        connected.push(await connectGraphAccount(orgId as never, {
          igUserId: profile.userId,
          handle: profile.username,
          accountType: type === "BUSINESS" ? "business" : "creator",
          accessToken,
          expiresIn,
        }));
      } catch (err) {
        // The first failure is the caller's answer (e.g. the tier cap); a later one keeps what's connected.
        if (!connected.length) throw err;
        req.log.warn({ err: (err as Error).message }, "ig: an extra shared account was not connected");
        break;
      }
    }

    // Web app shows the "connected" state; Leak Scan can start from here.
    return reply.redirect(
      `${process.env.WEB_APP_URL ?? "http://localhost:3100"}/onboarding?connected=${connected[0]!.handle}`
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
