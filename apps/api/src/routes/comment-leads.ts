import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { canReplyPrivately, normalizeCommentKeywords, type CommentLeadsResponse } from "@dealdock/core";
import { commentReplyInput, createPipeline } from "@dealdock/ai";
import {
  cacheCommentLeadMediaUrl,
  claimCommentLeadSend,
  clearExpiredCommentLeads,
  completeCommentLeadSend,
  getCommentLead,
  getConnectedAccount,
  getCreatorContext,
  isIgnoredHandle,
  listCommentKeywords,
  listCommentLeads,
  markTokenExpired,
  releaseCommentLeadSend,
  saveCommentLeadDraft,
  setCommentKeywords,
  skipCommentLead,
  toCommentLeadDto,
  type CommentLeadClaim,
  type OrgId,
} from "@dealdock/db";
import { MockInstagramAdapter, RateBudgetExceededError, subscribeToInstagramWebhooks, TokenExpiredError } from "@dealdock/messaging";
import { requireAuth } from "../auth";
import { isCommentLeadsEnabled } from "../feature-flags";
import { getGraphAdapter } from "../graph";
import { AccountRef, IgAccountId, requireIgAccount, requirePermission, requireWritable } from "../guards";

/** Its own instance: like Instagram, it takes one private reply per comment. */
const mockAdapter = new MockInstagramAdapter();

const KeywordsBody = z.object({ igAccountId: IgAccountId.optional(), keywords: z.array(z.string().max(200)).max(50) });
const SendBody = z.object({ text: z.string().max(1000) });

/** Why a lead could not be claimed for sending, as the error the web explains. */
const NOT_CLAIMED: Record<Exclude<CommentLeadClaim, { claimed: true }>["reason"], string> = {
  not_found: "not_found",
  too_late: "comment_lead_too_late",
  sending: "comment_lead_send_in_flight",
  sent: "comment_lead_already_sent",
  skipped: "comment_lead_not_open",
};

const notConfigured = { error: "comment_leads_not_configured" } as const;

/**
 * Comment leads (Phase 3, item 18): people who commented a creator's keyword,
 * each with one drafted private reply. The worker only drafts; a reply goes
 * from here, once, after a person approves it — never on its own.
 */
export async function commentLeadRoutes(app: FastifyInstance) {
  const sendWrite = { preHandler: [requireAuth, requireWritable, requirePermission("send")] };

  /** Every creator's keywords and leads (skipped ones left out). `configured` false hides the feature in the web app. */
  app.get("/comment-leads", { preHandler: requireAuth }, async (req) => {
    if (!isCommentLeadsEnabled()) return { configured: false, keywords: [], leads: [] } satisfies CommentLeadsResponse;
    const orgId = req.auth!.orgId;
    const [keywords, leads] = await Promise.all([listCommentKeywords(orgId), listCommentLeads(orgId)]);
    fillPostLinks(orgId, leads, req.log);
    return { configured: true, keywords, leads: leads.map(toCommentLeadDto) } satisfies CommentLeadsResponse;
  });

  /**
   * One creator's keywords (on Solo and Studio the workspace's account).
   * Saving some also subscribes the account to Instagram's comment webhooks,
   * so accounts connected before comment leads existed start receiving them.
   */
  app.put("/comment-leads/keywords", { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] }, async (req, reply) => {
    if (!isCommentLeadsEnabled()) return reply.code(409).send(notConfigured);
    const parsed = KeywordsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const keywords = normalizeCommentKeywords(parsed.data.keywords);
    if (!keywords.ok) return reply.code(400).send({ error: keywords.error });
    const auth = req.auth!;
    const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    const connected = keywords.keywords.length ? await getConnectedAccount(auth.orgId, account.id) : null;
    if (connected?.provider === "instagram_graph" && connected.status === "active") {
      try {
        await subscribeToInstagramWebhooks({}, connected.accessToken, connected.platformUserId, ["comments", "messages"]);
      } catch {
        req.log.warn({ igAccountId: account.id }, "comment webhook subscription failed");
        return reply.code(502).send({ error: "instagram_subscription_failed", hint: "Instagram didn't turn on comment updates, so nothing was saved. Try again, or reconnect Instagram in Settings." });
      }
    }
    return { igAccountId: account.id, keywords: await setCommentKeywords(auth.orgId, auth.seatId, account.id, keywords.keywords) };
  });

  /**
   * THE SEND GATE for a private reply: the approved (possibly edited) text,
   * a lead claimed new → sending in one conditional update so exactly one
   * reply goes per comment, and never after its 7 days. A failed send frees
   * the lead again: Instagram itself refuses a second reply to one comment.
   */
  app.post("/comment-leads/:id/send", sendWrite, async (req, reply) => {
    if (!isCommentLeadsEnabled()) return reply.code(409).send(notConfigured);
    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const text = parsed.data.text.trim();
    if (!text) return reply.code(400).send({ error: "send_text_required" });
    const { id } = req.params as { id: string };
    const auth = req.auth!;
    const lead = await getCommentLead(auth.orgId, id);
    if (!lead) return reply.code(404).send({ error: "not_found" });
    const connected = await getConnectedAccount(auth.orgId, lead.igAccountId);
    if (!connected || connected.status !== "active" || (connected.provider !== "instagram_graph" && connected.provider !== "mock")) {
      return reply.code(409).send({ error: "account_not_active" });
    }

    const claim = await claimCommentLeadSend(auth.orgId, id, auth.seatId);
    if (!claim.claimed) return reply.code(claim.reason === "not_found" ? 404 : 409).send({ error: NOT_CLAIMED[claim.reason] });

    const provider = connected.provider === "mock" ? mockAdapter : getGraphAdapter();
    let receipt;
    try {
      receipt = await provider.sendPrivateReply(
        { accountId: connected.accountId, platformUserId: connected.platformUserId, handle: connected.handle, accessToken: connected.accessToken },
        claim.lead.commentId,
        text,
      );
    } catch (error) {
      await releaseCommentLeadSend(auth.orgId, id);
      if (error instanceof TokenExpiredError) {
        await markTokenExpired(auth.orgId, lead.igAccountId);
        return reply.code(409).send({ error: "account_not_active", hint: "Instagram needs reconnecting. Nothing was sent." });
      }
      if (error instanceof RateBudgetExceededError) return reply.code(429).send({ error: "instagram_rate_limited" });
      req.log.warn({ code: error instanceof Error ? error.name : "unknown" }, "private reply not sent");
      // A timeout can hide a reply that went: say only what is known.
      return reply.code(502).send({ error: "private_reply_failed", hint: "Instagram didn't confirm this reply. Try again, or skip it: Instagram takes one reply per comment, so it can't go twice." });
    }
    const sent = await completeCommentLeadSend(auth.orgId, id, { seatId: auth.seatId, text, sentAt: receipt.sentAt });
    return { lead: toCommentLeadDto(sent) };
  });

  /** No private reply for this comment. */
  app.post("/comment-leads/:id/skip", sendWrite, async (req) => {
    const { id } = req.params as { id: string };
    await skipCommentLead(req.auth!.orgId, req.auth!.seatId, id);
    return { skipped: true };
  });

  /** Draft the reply again, in the creator's voice from their offers. Never sends. */
  app.post("/comment-leads/:id/draft", sendWrite, async (req, reply) => {
    if (!isCommentLeadsEnabled()) return reply.code(409).send(notConfigured);
    const { id } = req.params as { id: string };
    const orgId = req.auth!.orgId;
    const lead = await getCommentLead(orgId, id);
    if (!lead) return reply.code(404).send({ error: "not_found" });
    if (lead.status !== "new") return reply.code(409).send({ error: "comment_lead_not_open" });
    if (!canReplyPrivately(lead.commentedAt)) return reply.code(409).send({ error: "comment_lead_too_late" });
    const [creator, ignored] = await Promise.all([getCreatorContext(orgId, lead.igAccountId), isIgnoredHandle(orgId, lead.igAccountId, lead.commenterHandle)]);
    if (!creator.voiceEnabled) return reply.code(409).send({ error: "voice_modeling_disabled" });
    if (ignored) return reply.code(409).send({ error: "handle_ignored" });
    const result = await createPipeline().draft(commentReplyInput(creator, lead));
    await saveCommentLeadDraft(orgId, id, { body: result.body, modelVersion: result.modelVersion, missingFacts: result.context?.missingFacts ?? [] });
    const drafted = await getCommentLead(orgId, id);
    if (!drafted) return reply.code(404).send({ error: "not_found" });
    return { lead: toCommentLeadDto(drafted) };
  });

  /** Deletes leads whose 7 days ran out without a reply (one creator's when given). */
  app.post("/comment-leads/clear", sendWrite, async (req, reply) => {
    const parsed = AccountRef.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    return { cleared: await clearExpiredCommentLeads(req.auth!.orgId, req.auth!.seatId, parsed.data.igAccountId) };
  });
}

/** Posts whose link is being read now, so overlapping listings don't read one twice. */
const linking = new Set<string>();

/**
 * The comment webhook carries no post link: read a few per listing from
 * Instagram (the worker holds no credentials), in the background, and keep them.
 * shortcut: a post Meta gives no permalink for is asked again on later listings (3 at most each); cache misses if that ever costs budget.
 */
function fillPostLinks(orgId: OrgId, leads: Array<{ igAccountId: string; mediaId: string; mediaUrl: string | null }>, log: FastifyBaseLogger) {
  const missing = new Map(leads.filter((lead) => !lead.mediaUrl).map((lead) => [`${lead.igAccountId}|${lead.mediaId}`, lead]));
  for (const [key, lead] of [...missing].filter(([key]) => !linking.has(key)).slice(0, 3)) {
    linking.add(key);
    void (async () => {
      const account = await getConnectedAccount(orgId, lead.igAccountId);
      if (account?.provider !== "instagram_graph" || account.status !== "active") return;
      const url = await getGraphAdapter().getMediaPermalink(account, lead.mediaId);
      if (url) await cacheCommentLeadMediaUrl(orgId, lead.igAccountId, lead.mediaId, url);
    })()
      .catch((error: unknown) => log.warn({ code: error instanceof Error ? error.name : "unknown" }, "post link not read"))
      .finally(() => linking.delete(key));
  }
}
