import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEAL_TYPES, normalizeOfferAddOns, OfferAddOnsSchema, type OfferAddOns, type OfferDto, type PublicRateCard, type RateCardLinkResponse } from "@dealdock/core";
import { createOffer, deleteOffer, getPublicRateCard, listOffers, setRateCardToken, updateOffer } from "@dealdock/db";
import { requireAuth } from "../auth";
import { IgAccountId, requirePermission, requireWritable } from "../guards";

/** A rate-card link token: 192 random bits, base64url (32 characters). */
export function newRateCardToken(): string {
  return randomBytes(24).toString("base64url");
}
/** What a token can look like; anything else is a 404 without a database read. */
const RATE_CARD_TOKEN = /^[A-Za-z0-9_-]{22,64}$/;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Optional free text: blank means "not set". */
const note = (max: number) => z.string().trim().max(max).nullable().transform((value) => value || null);
const minor = z.number().int().nonnegative().safe().nullable();

const OfferFields = z.object({
  igAccountId: IgAccountId.nullable(),
  name: z.string().trim().min(1).max(80),
  dealType: z.enum(DEAL_TYPES),
  priceMinMinor: minor,
  priceMaxMinor: minor,
  // Links appear in drafts sent to strangers: https only, never javascript:/http:.
  link: note(500).refine((value) => value === null || isHttpsUrl(value), "Links must be https URLs"),
  details: note(1000),
  availability: note(200),
  // Brand offers only; the repository refuses prices on any other type.
  addOns: OfferAddOnsSchema.nullable().transform((value) => normalizeOfferAddOns(value)),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
});

// Normalized add-ons are null when no price is set, so any object here carries a price.
const brandAddOns = (offer: { dealType?: string; addOns?: OfferAddOns | null }) => offer.dealType === undefined || offer.dealType === "brand" || !offer.addOns;
const BRAND_ONLY = { message: "Add-on prices are for brand offers.", path: ["addOns"] };

const priceOrdered = (offer: { priceMinMinor?: number | null; priceMaxMinor?: number | null }) =>
  offer.priceMinMinor == null || offer.priceMaxMinor == null || offer.priceMinMinor <= offer.priceMaxMinor;
const PRICE_ORDER = { message: "The lowest price cannot exceed the highest.", path: ["priceMinMinor"] };

// Currency is never accepted: offers are always in the org's frozen currency.
const CreateBody = OfferFields.partial().required({ name: true, dealType: true }).refine(priceOrdered, PRICE_ORDER).refine(brandAddOns, BRAND_ONLY);
const PatchBody = OfferFields.partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update")
  .refine(priceOrdered, PRICE_ORDER)
  .refine(brandAddOns, BRAND_ONLY);
const RateCardBody = z.object({ igAccountId: IgAccountId });

const WRITE = [requireAuth, requireWritable, requirePermission("manage_settings")];

export async function offerRoutes(app: FastifyInstance) {
  /** Offers & rate card (F3): every seat can read them (composer quick-insert). */
  app.get("/offers", { preHandler: requireAuth }, async (req) => {
    return { offers: await listOffers(req.auth!.orgId) } satisfies { offers: OfferDto[] };
  });

  app.post("/offers", { preHandler: WRITE }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const offer: OfferDto = await createOffer(req.auth!.orgId, req.auth!.seatId, parsed.data);
    return reply.code(201).send(offer);
  });

  app.patch("/offers/:id", { preHandler: WRITE }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    return (await updateOffer(req.auth!.orgId, req.auth!.seatId, id, parsed.data)) satisfies OfferDto;
  });

  /** Make (or replace) a creator's private rate-card link: a new token ends the old link at once. */
  app.post("/offers/rate-card", { preHandler: WRITE }, async (req, reply) => {
    const parsed = RateCardBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    return (await setRateCardToken(req.auth!.orgId, req.auth!.seatId, parsed.data.igAccountId, newRateCardToken())) satisfies RateCardLinkResponse;
  });

  /** Turn the link off: it reads "not found" from then on. */
  app.delete("/offers/rate-card/:igAccountId", { preHandler: WRITE }, async (req, reply) => {
    const parsed = RateCardBody.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    return (await setRateCardToken(req.auth!.orgId, req.auth!.seatId, parsed.data.igAccountId, null)) satisfies RateCardLinkResponse;
  });

  /**
   * The public rate card behind a link: no session, the token is the
   * capability. Only public data (handle, currency, the active offers that
   * apply to that creator). Never cached or indexed, so turning it off or
   * replacing it takes effect at once.
   */
  app.get("/public/rate-cards/:token", { logLevel: "silent" }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const card = RATE_CARD_TOKEN.test(token) ? await getPublicRateCard(token) : null;
    reply.header("cache-control", "no-store").header("x-robots-tag", "noindex, nofollow");
    if (!card) return reply.code(404).send({ error: "not_found" });
    return card satisfies PublicRateCard;
  });

  app.delete("/offers/:id", { preHandler: WRITE }, async (req) => {
    const { id } = req.params as { id: string };
    await deleteOffer(req.auth!.orgId, req.auth!.seatId, id);
    return { deleted: true };
  });
}
