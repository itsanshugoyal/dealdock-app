/**
 * Instagram Login for Business OAuth (PRD §6.1, docs/meta-app-review.md §3).
 * Flow: authorize → code → short-lived token → long-lived token (~60 days,
 * refreshed by the token-health job) → /me profile with account_type.
 * Personal accounts are REJECTED with switch-to-professional guidance.
 */

import { UNIFIED_GRAPH_BASE } from "./instagram-graph-adapter";

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH_BASE = "https://graph.instagram.com";
const OAUTH_TIMEOUT_MS = 15_000;

export const IG_SCOPES = ["instagram_business_basic", "instagram_business_manage_messages"];
/** Comment leads read comments and send private replies (needs Meta App Review; META_COMMENTS_ENABLED). */
export const IG_COMMENTS_SCOPE = "instagram_business_manage_comments";
/** Post results ("Fetch from Instagram"); needs Meta App Review, so it is asked for only with META_INSIGHTS_ENABLED. */
export const IG_INSIGHTS_SCOPE = "instagram_business_manage_insights";

export interface IgOauthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  /** Injectable only for deterministic tests; production calls are bounded. */
  timeoutMs?: number;
}

export interface IgProfile {
  userId: string;
  username: string;
  /** "BUSINESS" | "MEDIA_CREATOR" | "PERSONAL" */
  accountType: string;
}

export function buildAuthorizeUrl(cfg: Pick<IgOauthConfig, "appId" | "redirectUri">, state: string, extraScopes: readonly string[] = []): string {
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: [...IG_SCOPES, ...extraScopes].join(","),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function oauthFetch(
  cfg: Pick<IgOauthConfig, "fetchImpl" | "timeoutMs">,
  url: string,
  init: RequestInit = {}
) {
  try {
    return await (cfg.fetchImpl ?? fetch)(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(cfg.timeoutMs ?? OAUTH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Instagram OAuth request timed out");
    }
    throw new Error("Instagram OAuth request failed");
  }
}

export async function exchangeCodeForToken(
  cfg: IgOauthConfig,
  code: string
): Promise<{ accessToken: string; expiresIn: number }> {
  if (!code || code.length > 4_000) throw new Error("IG authorization code is invalid");

  // 1. code → short-lived token
  const shortRes = await oauthFetch(cfg, TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      grant_type: "authorization_code",
      redirect_uri: cfg.redirectUri,
      code,
    }),
  });
  const short = (await shortRes.json()) as {
    access_token?: string;
    error_message?: string;
    error?: { message?: string };
  };
  if (!shortRes.ok || !short.access_token) {
    throw new Error(`IG token exchange failed: ${short.error_message ?? short.error?.message ?? shortRes.status}`);
  }

  // 2. short-lived → long-lived (~60 days)
  const longRes = await oauthFetch(cfg,
    `${GRAPH_BASE}/access_token?grant_type=ig_exchange_token&client_secret=${cfg.appSecret}&access_token=${short.access_token}`
  );
  const long = (await longRes.json()) as { access_token?: string; expires_in?: number };
  if (!longRes.ok || !long.access_token) {
    throw new Error("IG long-lived token exchange failed");
  }
  return { accessToken: long.access_token, expiresIn: long.expires_in ?? 60 * 24 * 3600 };
}

/** Refresh a long-lived token before expiry (token-health job). */
export async function refreshLongLivedToken(
  cfg: Pick<IgOauthConfig, "fetchImpl">,
  accessToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  if (!accessToken || accessToken.length > 8_000) throw new Error("IG access token is invalid");
  const res = await oauthFetch(cfg,
    `${GRAPH_BASE}/refresh_access_token?grant_type=ig_refresh_token&access_token=${accessToken}`
  );
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) throw new Error("IG token refresh failed");
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? 60 * 24 * 3600 };
}

export async function fetchIgProfile(
  cfg: Pick<IgOauthConfig, "fetchImpl">,
  accessToken: string
): Promise<IgProfile> {
  const res = await oauthFetch(cfg,
    `${GRAPH_BASE}/me?fields=user_id,username,account_type&access_token=${accessToken}`
  );
  const body = (await res.json()) as {
    user_id?: string;
    id?: string;
    username?: string;
    account_type?: string;
  };
  if (!res.ok || !(body.user_id ?? body.id)) throw new Error("IG profile fetch failed");
  return {
    userId: String(body.user_id ?? body.id),
    username: body.username ?? "",
    accountType: body.account_type ?? "UNKNOWN",
  };
}

// ── Instagram API with Unified Login (Meta apps created after ~Oct 2026) ──
// Facebook Login for Business with a configuration (its permissions replace
// `scope`), a Business Integration System User token that belongs to the
// creator's business portfolio, and graph.facebook.com.

const UNIFIED_AUTHORIZE_URL = "https://www.facebook.com/dialog/oauth";
const UNIFIED_PERMISSIONS = new Set(["instagram_basic", "instagram_manage_messages"]);

export function buildUnifiedAuthorizeUrl(cfg: Pick<IgOauthConfig, "appId" | "redirectUri"> & { configId: string }, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.appId,
    config_id: cfg.configId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    state,
    // Shows the Instagram login option even when the person is signed in to Facebook.
    prompt: "login",
  });
  return `${UNIFIED_AUTHORIZE_URL}?${params.toString()}`;
}

/** code → system-user token. No long-lived exchange; `expiresIn` is null when the configuration says "never". */
export async function exchangeUnifiedCode(cfg: IgOauthConfig, code: string): Promise<{ accessToken: string; expiresIn: number | null }> {
  if (!code || code.length > 4_000) throw new Error("IG authorization code is invalid");
  const params = new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, redirect_uri: cfg.redirectUri, code });
  const res = await oauthFetch(cfg, `${UNIFIED_GRAPH_BASE}/oauth/access_token?${params.toString()}`);
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!res.ok || !body.access_token) throw new Error(`IG token exchange failed: ${body.error?.message ?? res.status}`);
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : null;
  return { accessToken: body.access_token, expiresIn };
}

/**
 * The Instagram professional accounts the creator shared. `/me` is the system
 * user, not an Instagram account. When the assigned list is empty (reported
 * when app and account share a portfolio), fall back to the token's granted
 * target ids. Ids equal Instagram Login's `user_id`.
 */
export async function fetchUnifiedAccounts(cfg: Pick<IgOauthConfig, "appId" | "appSecret" | "fetchImpl" | "timeoutMs">, accessToken: string): Promise<IgProfile[]> {
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
  const listed = await oauthFetch(cfg, `${UNIFIED_GRAPH_BASE}/me/assigned_instagram_accounts?fields=id,username`, auth);
  const list = (await listed.json().catch(() => ({}))) as { data?: Array<{ id?: unknown; username?: unknown }> };
  if (!listed.ok) throw new Error("IG account lookup failed");
  const profiles = (list.data ?? []).flatMap(toProfile);
  if (profiles.length) return profiles;

  const debug = await oauthFetch(cfg, `${UNIFIED_GRAPH_BASE}/debug_token?${new URLSearchParams({ input_token: accessToken, access_token: `${cfg.appId}|${cfg.appSecret}` })}`);
  const token = (await debug.json().catch(() => ({}))) as { data?: { granular_scopes?: Array<{ scope?: string; target_ids?: unknown[] }> } };
  if (!debug.ok) throw new Error("IG token inspection failed");
  const ids = new Set(
    (token.data?.granular_scopes ?? [])
      .filter((grant) => grant.scope && UNIFIED_PERMISSIONS.has(grant.scope))
      .flatMap((grant) => grant.target_ids ?? [])
      .map(String)
      .filter((value) => /^\d{1,32}$/.test(value))
  );
  const found: IgProfile[] = [];
  for (const igId of ids) {
    const res = await oauthFetch(cfg, `${UNIFIED_GRAPH_BASE}/${igId}?fields=id,username`, auth);
    const body = (await res.json().catch(() => ({}))) as { id?: unknown; username?: unknown };
    if (res.ok) found.push(...toProfile(body));
  }
  return found;
}

function toProfile(row: { id?: unknown; username?: unknown }): IgProfile[] {
  const userId = typeof row.id === "string" || typeof row.id === "number" ? String(row.id) : "";
  if (!/^\d{1,32}$/.test(userId)) return [];
  // Unified Login only shares professional accounts; the type isn't readable here.
  return [{ userId, username: typeof row.username === "string" ? row.username : "", accountType: "UNKNOWN" }];
}

/**
 * Subscribe the connected professional account to official webhooks:
 * messages, plus comments when comment leads are on. Runs in the API only
 * (OAuth callback, saving comment keywords); it never accepts a user-supplied
 * account id and does not expose a token to the worker. Unified Login passes
 * its graph.facebook.com host as `graphBase`.
 */
export async function subscribeToInstagramWebhooks(
  cfg: Pick<IgOauthConfig, "fetchImpl" | "timeoutMs"> & { graphBase?: string },
  accessToken: string,
  igUserId: string,
  fields: ReadonlyArray<"comments" | "messages"> = ["messages"]
): Promise<void> {
  if (!accessToken || !igUserId || !/^\d+$/.test(igUserId) || fields.length === 0) {
    throw new Error("IG webhook subscription input is invalid");
  }
  const res = await oauthFetch(cfg, `${cfg.graphBase ?? GRAPH_BASE}/${encodeURIComponent(igUserId)}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ subscribed_fields: fields.join(",") }),
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean } | null;
  if (!res.ok || body?.success !== true) throw new Error("IG webhook subscription failed");
}
