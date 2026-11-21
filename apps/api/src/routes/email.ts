import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isDomainError } from "@dealdock/core";
import {
  asOrgId,
  connectEmailAccount,
  disconnectAccount,
  findAccountByPlatformUserId,
  getEmailMessageRef,
  listEmailAccounts,
  resolveInboxOwner,
} from "@dealdock/db";
import {
  GMAIL_READ_SCOPE,
  GMAIL_SEND_SCOPE,
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  fetchGmailAddress,
} from "@dealdock/messaging";
import { requireAuth } from "../auth";
import { AccountRef, requirePermission, requireWritable } from "../guards";
import { scheduleEmailSync } from "../email-sync";
import { getGmailProvider, gmailConfig, gmailPushConfig, withGmailAccount } from "../gmail";

/**
 * Signed state ties the callback to the org and creator account that started
 * it — CSRF protection, as in the Instagram connect flow (routes/ig.ts).
 */
function signState(orgId: string, ownerAccountId: string, secret: string): string {
  const payload = `${orgId}.${ownerAccountId}.${Date.now()}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

function verifyState(state: string, secret: string): { orgId: string; ownerAccountId: string } | null {
  try {
    const [orgId, ownerAccountId, ts, sig] = Buffer.from(state, "base64url").toString().split(".");
    if (!orgId || !ownerAccountId || !ts || !sig) return null;
    const expected = createHmac("sha256", secret).update(`${orgId}.${ownerAccountId}.${ts}`).digest("hex");
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
    const issuedAt = Number(ts);
    if (!Number.isSafeInteger(issuedAt) || issuedAt > Date.now() || Date.now() - issuedAt > 15 * 60_000) return null;
    return { orgId, ownerAccountId };
  } catch {
    return null;
  }
}

/** Back to Settings → Email with a success or error flag the web turns into a message. */
function toSettings(reply: FastifyReply, outcome: { ok: true } | { error: string }) {
  const flag = "ok" in outcome ? "email=connected" : `email_error=${encodeURIComponent(outcome.error)}`;
  return reply.redirect(`${process.env.WEB_APP_URL ?? "http://localhost:3100"}/settings?${flag}#email`);
}

/** Equal-length digests, so neither the token nor its length leaks through timing. */
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** Download names never break the header: ASCII fallback plus RFC 5987 UTF-8. */
function contentDisposition(filename: string): string {
  const name = filename.replace(/[\r\n\0"\\/]+/g, "_").slice(0, 200) || "attachment";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encoded}`;
}

export async function emailRoutes(app: FastifyInstance) {
  // Push needs the OAuth side too: a push for an inbox no sync can read would only pile up jobs.
  const push = gmailConfig() ? gmailPushConfig() : null;

  /**
   * Start connecting a Gmail inbox for one creator account (`igAccountId`,
   * required on Roster; elsewhere the workspace's Instagram account).
   */
  app.get("/email/connect", { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] }, async (req, reply) => {
    const cfg = gmailConfig();
    if (!cfg) return reply.code(409).send({ error: "email_not_configured" });
    const parsed = AccountRef.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const owner = await resolveInboxOwner(req.auth!.orgId, parsed.data.igAccountId);
    return { authorizeUrl: buildGoogleAuthorizeUrl(cfg, signState(req.auth!.orgId, owner.id, cfg.clientSecret)) };
  });

  /** Google's redirect: code → tokens → address → inbox row → first sync (and push, when on). */
  app.get("/email/callback", async (req, reply) => {
    const cfg = gmailConfig();
    if (!cfg) return reply.code(409).send({ error: "email_not_configured" });
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) return toSettings(reply, { error: error === "access_denied" ? "access_denied" : "oauth_failed" });
    const signed = state ? verifyState(state, cfg.clientSecret) : null;
    if (!code || !signed) return toSettings(reply, { error: "invalid_state" });

    let tokens: Awaited<ReturnType<typeof exchangeGoogleCode>>;
    let address: string;
    try {
      tokens = await exchangeGoogleCode(cfg, code);
      // Google's consent screen lets people untick scopes; reading and replying both need theirs.
      if (!tokens.scopes.includes(GMAIL_READ_SCOPE) || !tokens.scopes.includes(GMAIL_SEND_SCOPE)) {
        return toSettings(reply, { error: "scopes_missing" });
      }
      if (!tokens.refreshToken) return toSettings(reply, { error: "connection_failed" });
      address = await fetchGmailAddress(cfg, tokens.accessToken);
    } catch (err) {
      // Google's error bodies stay in server logs, never in the browser.
      req.log.error({ err: (err as Error).message }, "gmail oauth exchange failed");
      return toSettings(reply, { error: "connection_failed" });
    }

    let account: Awaited<ReturnType<typeof connectEmailAccount>>;
    try {
      account = await connectEmailAccount(asOrgId(signed.orgId), {
        ownerAccountId: signed.ownerAccountId,
        address,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      });
    } catch (err) {
      if (isDomainError(err) && err.status < 500) return toSettings(reply, { error: err.code });
      req.log.error({ err: (err as Error).message }, "gmail inbox save failed");
      return toSettings(reply, { error: "connection_failed" });
    }

    // Both best effort once the inbox is saved: the scheduled poll syncs it, the daily renewal re-watches it.
    if (push) {
      const inbox = { accountId: account.id, platformUserId: account.igUserId, handle: account.handle, accessToken: tokens.accessToken };
      await getGmailProvider().watch(inbox, push.topic).catch((err: Error) => req.log.warn({ err: err.message }, "gmail watch failed"));
    }
    await scheduleEmailSync(signed.orgId, account.id, `connect:${Date.now()}`)
      .catch((err: Error) => req.log.warn({ err: err.message }, "gmail first sync not queued"));
    return toSettings(reply, { ok: true });
  });

  /** Settings → Email: each live inbox, the creator it belongs to, and when it last synced. */
  app.get("/email/accounts", { preHandler: requireAuth }, async (req) => {
    // `configured` lets Settings hide the Email section on deployments without Google OAuth.
    return { configured: gmailConfig() !== null, accounts: await listEmailAccounts(req.auth!.orgId) };
  });

  /** Drops the inbox's tokens and stops its sync; its threads stay as history. */
  app.post("/email/accounts/:id/disconnect", { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] }, async (req) => {
    const { id } = req.params as { id: string };
    const auth = req.auth!;
    if (push) {
      // Best effort, before the tokens are gone: otherwise Gmail pushes for up to 7 days to an inbox we ignore.
      await withGmailAccount(auth.orgId, id, (inbox) => getGmailProvider().stopWatch(inbox)).catch(() => undefined);
    }
    await disconnectAccount(auth.orgId, id, auth.seatId, "email");
    return { disconnected: true };
  });

  /**
   * Attachment download proxy: fetched from Gmail on demand (files are never
   * stored), org-scoped by the message, always served as a download.
   */
  app.get("/email/messages/:messageId/attachments/:partId", { preHandler: requireAuth }, async (req, reply) => {
    const { messageId, partId } = req.params as { messageId: string; partId: string };
    if (!/^\d+(?:\.\d+){0,9}$/.test(partId)) return reply.code(404).send({ error: "not_found" });
    const auth = req.auth!;
    const ref = await getEmailMessageRef(auth.orgId, messageId);
    if (!ref) return reply.code(404).send({ error: "not_found" });
    const found = await withGmailAccount(auth.orgId, ref.igAccountId, async (inbox) => ({
      file: await getGmailProvider().getAttachment(inbox, ref.gmailMessageId, partId),
    }));
    if (!found) return reply.code(409).send({ error: "account_not_active" });
    const { file } = found;
    if (!file) return reply.code(404).send({ error: "not_found" });
    return reply
      .header("content-type", /^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType) ? file.mimeType : "application/octet-stream")
      .header("content-length", String(file.bytes.byteLength))
      .header("content-disposition", contentDisposition(file.filename))
      .header("access-control-expose-headers", "content-disposition")
      // Files come from strangers' mail: never render them in our origin.
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, no-store")
      .send(file.bytes);
  });

  /**
   * Gmail push via Pub/Sub (only when configured): the subscription's push
   * endpoint is /webhooks/gmail?token=<GMAIL_PUBSUB_VERIFICATION_TOKEN>. A
   * push only says "this mailbox changed", so it queues an incremental sync.
   * Anything authentic is acknowledged (204) so Pub/Sub never retries it forever.
   */
  if (push) {
    app.post("/webhooks/gmail", async (req, reply) => {
      const { token } = req.query as { token?: unknown };
      if (typeof token !== "string" || !sameSecret(token, push.token)) return reply.code(401).send({ error: "unauthorized" });
      const data = (req.body as { message?: { data?: unknown } } | null)?.message?.data;
      let note: { emailAddress?: unknown; historyId?: unknown } = {};
      try {
        note = JSON.parse(Buffer.from(typeof data === "string" ? data : "", "base64").toString("utf8"));
      } catch {
        return reply.code(204).send();
      }
      if (typeof note.emailAddress !== "string" || note.emailAddress.length > 254) return reply.code(204).send();
      const account = await findAccountByPlatformUserId(note.emailAddress.toLowerCase(), "email");
      if (account) await scheduleEmailSync(account.orgId, account.id, `push:${String(note.historyId ?? Date.now()).slice(0, 32)}`);
      return reply.code(204).send();
    });
  }
}
