/**
 * Instagram Login for Business OAuth (PRD §6.1, docs/meta-app-review.md §3).
 * Flow: authorize → code → short-lived token → long-lived token (~60 days,
 * refreshed by the token-health job) → /me profile with account_type.
 * Personal accounts are REJECTED with switch-to-professional guidance.
 */

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH_BASE = "https://graph.instagram.com";
const OAUTH_TIMEOUT_MS = 15_000;

export const IG_SCOPES = ["instagram_business_basic", "instagram_business_manage_messages"];

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

export function buildAuthorizeUrl(cfg: Pick<IgOauthConfig, "appId" | "redirectUri">, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: IG_SCOPES.join(","),
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

/**
 * Subscribe the connected professional account to official message webhooks.
 * This runs in the API OAuth callback only; it never accepts a user-supplied
 * account id and does not expose a token to the worker.
 */
export async function subscribeToInstagramWebhooks(
  cfg: Pick<IgOauthConfig, "fetchImpl" | "timeoutMs">,
  accessToken: string,
  igUserId: string
): Promise<void> {
  if (!accessToken || !igUserId || !/^\d+$/.test(igUserId)) {
    throw new Error("IG webhook subscription input is invalid");
  }
  const res = await oauthFetch(cfg, `${GRAPH_BASE}/${encodeURIComponent(igUserId)}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ subscribed_fields: "messages" }),
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean } | null;
  if (!res.ok || body?.success !== true) throw new Error("IG webhook subscription failed");
}
