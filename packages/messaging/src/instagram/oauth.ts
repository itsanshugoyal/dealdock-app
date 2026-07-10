/**
 * Instagram Login for Business OAuth (PRD §6.1, docs/meta-app-review.md §3).
 * Flow: authorize → code → short-lived token → long-lived token (~60 days,
 * refreshed by the token-health job) → /me profile with account_type.
 * Personal accounts are REJECTED with switch-to-professional guidance.
 */

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH_BASE = "https://graph.instagram.com";

export const IG_SCOPES = ["instagram_business_basic", "instagram_business_manage_messages"];

export interface IgOauthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
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

export async function exchangeCodeForToken(
  cfg: IgOauthConfig,
  code: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const f = cfg.fetchImpl ?? fetch;

  // 1. code → short-lived token
  const shortRes = await f(TOKEN_URL, {
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
  const longRes = await f(
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
  const f = cfg.fetchImpl ?? fetch;
  const res = await f(
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
  const f = cfg.fetchImpl ?? fetch;
  const res = await f(
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
