import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CURRENCY_CODES,
  LEAD_SOURCE_PROVIDERS,
  LEAD_STAGES,
  parseLeadPayload,
  type DealDraftResponse,
  type DealDto,
  type LeadEventDto,
  type LeadSourceCreated,
  type LeadSourcesResponse,
  type RenewalsResponse,
} from "@dealdock/core";
import { createPipeline, draftScope, retrieveVoiceContext } from "@dealdock/ai";
import {
  createLeadSource,
  deleteLeadSource,
  dismissLeadEvent,
  getCreatorContext,
  getDeal,
  getDraftVoiceContext,
  getOrgSettings,
  handleRenewal,
  listLeadSources,
  listRenewals,
  matchLeadEvent,
  recordLeadEvents,
  resolveLeadSource,
  setLeadSourceSecret,
  setLeadStage,
} from "@dealdock/db";
import { requireAuth } from "../auth";
import { IgAccountId, requirePermission, requireWritable } from "../guards";
import { LEAD_VERIFIERS, subscribeCalendly } from "../lead-webhooks";
import { getNotificationsQueue } from "../queues";
import { captureRawBody, rawBodyOf } from "../raw-body";

/** A tool's webhook body is small; anything bigger isn't a booking or a payment. */
const LEAD_WEBHOOK_MAX_BYTES = 64 * 1024;

const RenewalsQuery = z.object({ igAccountId: IgAccountId.optional() });
const RenewalHandledBody = z.object({ how: z.enum(["not_now", "copied"]) });
const DealDraftBody = z.object({ purpose: z.literal("renewal") });
const StageBody = z.object({ stage: z.enum(LEAD_STAGES) });
const SourceBody = z
  .object({
    provider: z.enum(LEAD_SOURCE_PROVIDERS),
    label: z.string().trim().max(60).nullish().transform((value) => value || null),
    secret: z.string().trim().min(8).max(500).optional(),
    accessKey: z.string().trim().min(20).max(4000).optional(),
  })
  .refine((body) => (body.provider === "calendly") === (body.accessKey !== undefined), { message: "Calendly needs its personal access key, and only Calendly", path: ["accessKey"] })
  .refine((body) => body.secret === undefined || (body.provider !== "calendly" && body.provider !== "other"), { message: "this tool takes no signing secret", path: ["secret"] });
const MatchBody = z.object({ threadId: z.string().min(1).max(64) });
const SecretBody = z.object({ secret: z.string().trim().min(8).max(500) });

/** Where tools send reports: the public API origin (PUBLIC_API_URL), or this server in development. */
function webhookBase(req: FastifyRequest): string | null {
  const configured = process.env.PUBLIC_API_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  return process.env.NODE_ENV === "production" ? null : `${req.protocol}://${req.host}`;
}

/** A matched payment is worth a push (the creator records the sale from it). Best effort, after the reply. */
function notifyPaid(orgId: string, payment: { threadId: string; handle: string; amountMinor: number | null; currencyCode: string | null }, locale: string) {
  const supported = payment.currencyCode !== null && (CURRENCY_CODES as readonly string[]).includes(payment.currencyCode);
  void getNotificationsQueue()
    .add("lead-paid", {
      orgId,
      kind: "lead_paid",
      threadId: payment.threadId,
      handle: payment.handle,
      ...(supported && payment.amountMinor !== null ? { valueMaxMinor: payment.amountMinor, currencyCode: payment.currencyCode, locale } : {}),
    })
    .catch(() => undefined);
}

export async function pipelineRoutes(app: FastifyInstance) {
  const triage = { preHandler: [requireAuth, requireWritable, requirePermission("close")] };
  const tools = { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] };

  // ── Renewals: pitch a brand that paid again ───────────────────────────────

  /** Brands to pitch again, one per creator account and brand (core renewalsDue); one creator's with igAccountId. */
  app.get("/renewals", { preHandler: requireAuth }, async (req, reply) => {
    const query = RenewalsQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    return { renewals: await listRenewals(req.auth!.orgId, { igAccountId: query.data.igAccountId }) } satisfies RenewalsResponse;
  });

  /** "Not now", or the pitch copied to send from Instagram or email: the prompt goes. A pitch sent through DealDock does this itself. */
  app.post("/deals/:id/renewal-handled", triage, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = RenewalHandledBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    return (await handleRenewal(req.auth!.orgId, id, req.auth!.seatId, parsed.data.how)) satisfies DealDto;
  });

  /**
   * A pitch for a paid deal agreed outside DealDock: there is no conversation
   * to put a draft in, so it is text to copy, in the creator's voice. Never
   * stored and never sent.
   */
  app.post("/deals/:id/draft", { preHandler: [requireAuth, requireWritable, requirePermission("send")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!DealDraftBody.safeParse(req.body ?? {}).success) return reply.code(400).send({ error: "invalid_body" });
    const { orgId } = req.auth!;
    const deal = await getDeal(orgId, id);
    if (!deal) return reply.code(404).send({ error: "not_found" });
    // A deal with a conversation is drafted there (POST /threads/:id/draft), so the send can mark it.
    if (deal.threadId !== null) return reply.code(409).send({ error: "deal_has_conversation" });
    if (deal.stage !== "paid") return reply.code(409).send({ error: "deal_not_paid" });
    const [creator, org] = await Promise.all([getCreatorContext(orgId, deal.igAccountId), getOrgSettings(orgId)]);
    if (!creator.voiceEnabled) return reply.code(409).send({ error: "voice_modeling_disabled" });
    const now = new Date();
    const pools = await getDraftVoiceContext(orgId, deal.igAccountId, now, creator);
    const label = "brand_deal" as const;
    const result = await createPipeline().draft({
      kind: "nudge",
      classificationLabel: label,
      threadHistory: [],
      creator,
      ...retrieveVoiceContext({ inboundText: "", scope: draftScope({ kind: "nudge", label }), now }, pools),
      purpose: "renewal",
      deal,
      now,
      timezone: org?.timezone,
    });
    return { body: result.body } satisfies DealDraftResponse;
  });

  // ── Coach pipeline: stages ────────────────────────────────────────────────

  /** The creator sets a coaching or course conversation's stage by hand: any stage, forward or back. */
  app.put("/threads/:id/lead-stage", triage, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = StageBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    return setLeadStage(req.auth!.orgId, req.auth!.seatId, id, parsed.data.stage);
  });

  // ── Booking and payment tools that report back ────────────────────────────

  app.get("/lead-sources", { preHandler: [requireAuth, requirePermission("manage_settings")] }, async (req) =>
    (await listLeadSources(req.auth!.orgId)) satisfies LeadSourcesResponse);

  /**
   * Connect a tool: a new secret address, shown once. Razorpay and Stripe sign
   * with a secret given now or saved after (PUT …/secret), and nothing they send
   * is accepted until then; Cal.com's is optional. Calendly takes a personal
   * access key instead, which DealDock uses once to subscribe the address and
   * never stores.
   */
  app.post("/lead-sources", tools, async (req, reply) => {
    const parsed = SourceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const base = webhookBase(req);
    if (!base) return reply.code(409).send({ error: "public_api_url_unconfigured" });
    const { provider, label, accessKey } = parsed.data;
    const token = randomBytes(32).toString("base64url");
    const address = `${base}/webhooks/leads/${token}`;
    let secret = parsed.data.secret ?? null;
    if (provider === "calendly") {
      if (!/^https:\/\//.test(address)) return reply.code(409).send({ error: "public_api_url_unconfigured" });
      secret = randomBytes(32).toString("base64url");
      const subscribed = await subscribeCalendly(accessKey!, address, secret);
      if (subscribed !== "connected") return reply.code(subscribed === "invalid_key" ? 400 : 502).send({ error: subscribed === "invalid_key" ? "calendly_key_refused" : "calendly_unavailable" });
    }
    const source = await createLeadSource(req.auth!.orgId, req.auth!.seatId, { provider, label, token, secret });
    return { source, address: provider === "calendly" ? null : address } satisfies LeadSourceCreated;
  });

  /** Razorpay's or Stripe's signing secret, saved after the address (Stripe shows it only once the address is saved there). */
  app.put("/lead-sources/:id/secret", tools, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SecretBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    return setLeadSourceSecret(req.auth!.orgId, req.auth!.seatId, id, parsed.data.secret);
  });

  app.delete("/lead-sources/:id", tools, async (req) => {
    const { id } = req.params as { id: string };
    await deleteLeadSource(req.auth!.orgId, req.auth!.seatId, id);
    return { deleted: true };
  });

  /** Put an unmatched booking or payment with its conversation. */
  app.post("/lead-events/:id/match", triage, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = MatchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    return (await matchLeadEvent(req.auth!.orgId, req.auth!.seatId, id, parsed.data.threadId)) satisfies LeadEventDto;
  });

  /** A reported payment or booking the creator won't record or match. */
  app.post("/lead-events/:id/dismiss", triage, async (req) => {
    const { id } = req.params as { id: string };
    await dismissLeadEvent(req.auth!.orgId, req.auth!.seatId, id);
    return { dismissed: true };
  });

  /**
   * Reports from a connected tool. The address's token names the source (only
   * its SHA-256 is stored); the tool's signature is checked over the raw body.
   * A redelivery is stored once; event types DealDock doesn't use get a 200.
   * Payer details never reach the logs (the logger drops request bodies).
   */
  app.post("/webhooks/leads/:token", { ...captureRawBody(LEAD_WEBHOOK_MAX_BYTES) }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const source = await resolveLeadSource(token);
    if (!source) return reply.code(404).send({ error: "not_found" });
    const verified = LEAD_VERIFIERS[source.provider]({ headers: req.headers, rawBody: rawBodyOf(req), secret: source.secret, now: new Date() });
    if (!verified) return reply.code(401).send({ error: "invalid_signature" });
    const events = parseLeadPayload(source.provider, req.body, { now: new Date(), orgCurrency: source.orgCurrency });
    if (events === null) return reply.code(400).send({ error: "invalid_payload" });
    if (events.length === 0) return reply.code(200).send({ received: 0 });
    const result = await recordLeadEvents(source.orgId, source, events);
    if (result.matchedPayments.length) {
      const locale = (await getOrgSettings(source.orgId))?.locale ?? "en-IN";
      for (const payment of result.matchedPayments) notifyPaid(source.orgId, payment, locale);
    }
    return reply.code(200).send({ received: events.length, stored: result.stored });
  });
}
