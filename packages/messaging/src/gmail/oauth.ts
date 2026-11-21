/**
 * Google OAuth for the Gmail channel (docs/email-channel.md). fetch only.
 * Flow: authorize (offline + consent, so Google always returns a refresh
 * token) → code → access + refresh token → Gmail profile for the address.
 * Access tokens last an hour; the API refreshes them with the refresh token.
 * Secrets travel only in POST bodies, never in URLs, so errors can't leak them.
 */

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const OAUTH_TIMEOUT_MS = 15_000;

export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_SCOPES = ["openid", "email", GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE];

export interface GoogleOauthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export interface GoogleTokens {
  accessToken: string;
  /** Null only if Google skipped it, which offline + consent should never do. */
  refreshToken: string | null;
  expiresIn: number;
  /** What the person actually granted: Google's consent screen lets them untick scopes. */
  scopes: string[];
}

export function buildGoogleAuthorizeUrl(cfg: Pick<GoogleOauthConfig, "clientId" | "redirectUri">, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function tokenRequest(cfg: GoogleOauthConfig, form: Record<string, string>) {
  const res = await (cfg.fetchImpl ?? fetch)(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...form }),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };
  return { res, body };
}

export async function exchangeGoogleCode(cfg: GoogleOauthConfig, code: string): Promise<GoogleTokens> {
  if (!code || code.length > 4_000) throw new Error("Google authorization code is invalid");
  const { res, body } = await tokenRequest(cfg, { code, grant_type: "authorization_code", redirect_uri: cfg.redirectUri });
  if (!res.ok || !body.access_token) throw new Error(`Google token exchange failed: ${body.error ?? res.status}`);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresIn: body.expires_in ?? 3600,
    scopes: (body.scope ?? "").split(" ").filter(Boolean),
  };
}

/**
 * A new access token, or null when Google refuses the refresh token
 * (`invalid_grant`: revoked, expired, password changed) — the inbox needs
 * reconnecting. Anything else (outage, bad client config) throws.
 */
export async function refreshGoogleToken(
  cfg: GoogleOauthConfig,
  refreshToken: string
): Promise<{ accessToken: string; expiresIn: number } | null> {
  const { res, body } = await tokenRequest(cfg, { refresh_token: refreshToken, grant_type: "refresh_token" });
  if (body.error === "invalid_grant") return null;
  if (!res.ok || !body.access_token) throw new Error(`Google token refresh failed: ${body.error ?? res.status}`);
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? 3600 };
}

/** The connected mailbox's address. Fails for a Google account without Gmail. */
export async function fetchGmailAddress(cfg: Pick<GoogleOauthConfig, "fetchImpl">, accessToken: string): Promise<string> {
  const res = await (cfg.fetchImpl ?? fetch)(PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { emailAddress?: string };
  if (!res.ok || !body.emailAddress) throw new Error(`Gmail profile fetch failed: ${res.status}`);
  return body.emailAddress;
}
