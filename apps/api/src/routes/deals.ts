import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEAL_TYPES, DealTermsPatchSchema, isStoryDeliverable, type DealDto, type DealSuggestion, type DealsResponse } from "@dealdock/core";
import { createPipeline } from "@dealdock/ai";
import {
  createDeal, deleteDeal, getConnectedAccount, getCreatorContext, getDeal, getDealConversation, isIgnoredHandle, listDeals, markDealPaid, setUsageHandled, updateDeal, updateDeliverable,
} from "@dealdock/db";
import { MockInstagramAdapter, RateBudgetExceededError, TokenExpiredError, type MessagingProvider } from "@dealdock/messaging";
import { requireAuth } from "../auth";
import { isInsightsEnabled } from "../feature-flags";
import { getGraphAdapter } from "../graph";
import { IgAccountId, requirePermission, requireWritable } from "../guards";

const mockAdapter = new MockInstagramAdapter();

const Amount = z.number().int().positive().safe();
const Minor = z.number().int().nonnegative().safe();
const When = z.string().datetime({ offset: true });
const Title = z.string().trim().min(1).max(120);
/** Same shape as the close-out Idempotency-Key (routes/threads.ts). */
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{16,200}$/);
const Paid = z.object({ receivedMinor: Minor.optional(), tdsMinor: Minor.optional(), paidAt: When.optional() });

const DealsQuery = z.object({
  status: z.enum(["open", "all"]).default("open"),
  igAccountId: IgAccountId.optional(),
});
/** A deal comes from a conversation (threadId), or was agreed outside DealDock and names its creator account and counterparty. */
const CreateBody = z
  .object({
    threadId: z.string().min(1).max(64).optional(),
    igAccountId: IgAccountId.optional(),
    counterpartyHandle: z.string().trim().min(1).max(120).optional(),
    counterpartyName: z.string().trim().max(120).nullish().transform((value) => value || null),
    title: Title,
    dealType: z.enum(DEAL_TYPES),
    amountMinor: Amount,
    terms: DealTermsPatchSchema.optional(),
    dueAt: When.nullable().optional(),
    paid: Paid.optional(),
    idempotencyKey: IdempotencyKey,
    // Recording the sale a payment tool reported in this conversation.
    leadEventId: z.string().min(1).max(64).optional(),
  })
  .refine(
    (body) =>
      body.threadId !== undefined
        ? body.igAccountId === undefined && body.counterpartyHandle === undefined && body.counterpartyName === null
        : body.igAccountId !== undefined && body.counterpartyHandle !== undefined,
    { message: "send threadId, or igAccountId and counterpartyHandle for a deal agreed outside DealDock", path: ["threadId"] },
  );
const PatchBody = z
  .object({
    title: Title.optional(),
    dealType: z.enum(DEAL_TYPES).optional(),
    amountMinor: Amount.optional(),
    terms: DealTermsPatchSchema.optional(),
    dueAt: When.nullable().optional(),
    stage: z.enum(["agreed", "invoiced", "cancelled"]).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), "nothing to update");
const PaidBody = Paid.extend({ idempotencyKey: IdempotencyKey });
const UsageHandledBody = z.object({ handled: z.boolean() });

export async function dealRoutes(app: FastifyInstance) {
  const write = { preHandler: [requireAuth, requireWritable, requirePermission("close")] };

  /** Money owed (open, most urgent first) or every deal; one creator with igAccountId. */
  app.get("/deals", { preHandler: requireAuth }, async (req, reply) => {
    const query = DealsQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    return { deals: await listDeals(req.auth!.orgId, query.data) } satisfies DealsResponse;
  });

  /**
   * Record a deal from a conversation, or one agreed outside DealDock (404 when
   * igAccountId isn't this org's, 400 creator_account_required for an email
   * inbox); `paid` records the money at once. A retry returns the same deal.
   */
  app.post("/deals", write, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    return (await createDeal(req.auth!.orgId, { ...parsed.data, seatId: req.auth!.seatId })) satisfies DealDto;
  });

  app.patch("/deals/:id", write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    return (await updateDeal(req.auth!.orgId, id, req.auth!.seatId, parsed.data)) satisfies DealDto;
  });

  /** Records what its paid invoices left (all of it without invoices); a retry with the same key returns the paid deal. */
  app.post("/deals/:id/paid", write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PaidBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    return (await markDealPaid(req.auth!.orgId, id, req.auth!.seatId, parsed.data)) satisfies DealDto;
  });

  /** Today's usage-rights reminder: Done (handled true), or back again (false, for Undo). */
  app.post("/deals/:id/usage-handled", write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UsageHandledBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    return (await setUsageHandled(req.auth!.orgId, id, req.auth!.seatId, parsed.data.handled)) satisfies DealDto;
  });

  /**
   * "Fetch from Instagram": a posted deliverable's results, read with the
   * creator account's token (API process only: the worker never holds Meta
   * credentials) and saved on the deal. Off without META_INSIGHTS_ENABLED;
   * stories can't be fetched (Instagram keeps their insights a day), so
   * their numbers are typed in.
   */
  app.post("/deals/:id/deliverables/:deliverableId/insights", write, async (req, reply) => {
    if (!isInsightsEnabled()) return reply.code(404).send({ error: "insights_unavailable" });
    const { id, deliverableId } = req.params as { id: string; deliverableId: string };
    const { orgId, seatId } = req.auth!;
    const deal = await getDeal(orgId, id);
    const item = deal?.terms.deliverables.find((entry) => entry.id === deliverableId);
    if (!deal || !item) return reply.code(404).send({ error: "not_found" });
    if (!item.postUrl) return reply.code(409).send({ error: "post_link_required" });
    if (isStoryDeliverable(item.label)) return reply.code(409).send({ error: "story_results_not_available" });
    const connected = await getConnectedAccount(orgId, deal.igAccountId);
    const provider: MessagingProvider | null = connected?.provider === "mock" ? mockAdapter : connected?.provider === "instagram_graph" ? getGraphAdapter() : null;
    if (!connected || !provider?.getMediaInsights) return reply.code(409).send({ error: "insights_unavailable" });
    if (connected.status !== "active") return reply.code(409).send({ error: "instagram_reconnect_required" });
    let found;
    try {
      found = await provider.getMediaInsights(connected, item.postUrl);
    } catch (error) {
      if (error instanceof TokenExpiredError) return reply.code(409).send({ error: "instagram_reconnect_required" });
      if (error instanceof RateBudgetExceededError) return reply.code(429).send({ error: "instagram_busy" });
      req.log.warn({ err: error instanceof Error ? error.name : "unknown" }, "media_insights_failed");
      return reply.code(502).send({ error: "insights_unavailable" });
    }
    if (!found) return reply.code(404).send({ error: "post_not_found" });
    return (await updateDeliverable(orgId, deal.id, seatId, deliverableId, {
      metrics: found.metrics,
      metricsAt: new Date().toISOString(),
      // Instagram knows when it went live, when the creator didn't say.
      ...(item.postedAt ? {} : { postedAt: found.postedAt }),
    })) satisfies DealDto;
  });

  app.delete("/deals/:id", write, async (req) => {
    const { id } = req.params as { id: string };
    await deleteDeal(req.auth!.orgId, id, req.auth!.seatId);
    return { deleted: true };
  });

  /** Terms read from the conversation for the creator to check; never saved. Ignored handles never reach a model. */
  app.post("/threads/:id/deal-suggestion", write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { orgId } = req.auth!;
    const conversation = await getDealConversation(orgId, id);
    if (!conversation) return reply.code(404).send({ error: "not_found" });
    const [creator, ignored] = await Promise.all([
      getCreatorContext(orgId, conversation.igAccountId),
      isIgnoredHandle(orgId, conversation.igAccountId, conversation.participantHandle),
    ]);
    if (ignored) return reply.code(409).send({ error: "handle_ignored" });
    return (await createPipeline().suggestDeal({
      threadHistory: conversation.threadHistory,
      creator,
      now: new Date(),
      timezone: conversation.timezone,
    })) satisfies DealSuggestion;
  });
}
