import { DomainError, parseRedisConnection } from "@dealdock/core";
import { getConnectedAccount, markTokenExpired, saveRefreshedGraphToken, type OrgId } from "@dealdock/db";
import {
  GMAIL_BUDGET_PER_HOUR,
  GmailProvider,
  InMemoryGraphRateBudget,
  RedisGraphRateBudget,
  TokenExpiredError,
  refreshGoogleToken,
  type ConnectedAccount,
  type GoogleOauthConfig,
} from "@dealdock/messaging";

/** Google OAuth settings, or null when the email channel is off (its routes then fail closed). */
export function gmailConfig(): GoogleOauthConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  try {
    const callback = new URL(redirectUri);
    const localHttp = process.env.NODE_ENV !== "production" && callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname);
    if ((!localHttp && callback.protocol !== "https:") || callback.username || callback.password || callback.hash || callback.search || callback.pathname !== "/email/callback") return null;
  } catch {
    return null;
  }
  return { clientId, clientSecret, redirectUri };
}

/** Gmail push through Pub/Sub: on only with both the topic and the push endpoint's verification token. */
export function gmailPushConfig(): { topic: string; token: string } | null {
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  const token = process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN;
  return topic && token && token.length >= 24 ? { topic, token } : null;
}

let provider: GmailProvider | undefined;

/** API only: the Gmail token carries gmail.send, which is send capability (ARCHITECTURE.md §6.2). */
export function getGmailProvider(): GmailProvider {
  if (provider) return provider;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl && process.env.NODE_ENV === "production") {
    throw new Error("REDIS_URL is required for shared Gmail rate limits");
  }
  provider = new GmailProvider({
    rateBudget: redisUrl
      ? new RedisGraphRateBudget(parseRedisConnection(redisUrl), GMAIL_BUDGET_PER_HOUR)
      : new InMemoryGraphRateBudget(GMAIL_BUDGET_PER_HOUR),
  });
  return provider;
}

export type GmailAccount = ConnectedAccount & { syncCursor: string | null };

/**
 * An active Gmail inbox with a live access token, refreshed when it expires
 * within two minutes (or when `force`). Null when it is not an active Gmail
 * inbox — including when Google refuses the refresh token, which marks the
 * inbox token_expired so Settings asks for a reconnect.
 */
export async function gmailAccount(orgId: OrgId, igAccountId: string, force = false): Promise<GmailAccount | null> {
  const cfg = gmailConfig();
  if (!cfg) throw new DomainError("email_not_configured", 409);
  const connected = await getConnectedAccount(orgId, igAccountId);
  if (!connected || connected.provider !== "gmail" || connected.status !== "active") return null;
  const account: GmailAccount = {
    accountId: connected.accountId,
    platformUserId: connected.platformUserId,
    handle: connected.handle,
    accessToken: connected.accessToken,
    syncCursor: connected.syncCursor,
  };
  if (!force && connected.tokenExpiresAt && connected.tokenExpiresAt.getTime() - Date.now() > 2 * 60_000) return account;
  const fresh = connected.refreshToken ? await refreshGoogleToken(cfg, connected.refreshToken) : null;
  if (!fresh) {
    await markTokenExpired(orgId, igAccountId);
    return null;
  }
  await saveRefreshedGraphToken(orgId, igAccountId, fresh.accessToken, fresh.expiresIn);
  return { ...account, accessToken: fresh.accessToken };
}

/**
 * Runs `use` with a live inbox. Google can end an access token before its
 * expiry (password change, security event), so a 401 refreshes once and
 * retries; a second marks the inbox token_expired. Null when not active.
 * Not for sends: a failed send is never retried automatically.
 */
export async function withGmailAccount<T>(orgId: OrgId, igAccountId: string, use: (account: GmailAccount) => Promise<T>): Promise<T | null> {
  for (let attempt = 0; ; attempt += 1) {
    const account = await gmailAccount(orgId, igAccountId, attempt > 0);
    if (!account) return null;
    try {
      return await use(account);
    } catch (error) {
      if (!(error instanceof TokenExpiredError)) throw error;
      if (attempt > 0) {
        await markTokenExpired(orgId, igAccountId);
        throw error;
      }
    }
  }
}
