import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEAL_TYPES, type OfferDto } from "@dealdock/core";
import { createOffer, deleteOffer, listOffers, updateOffer } from "@dealdock/db";
import { requireAuth } from "../auth";
import { IgAccountId, requirePermission, requireWritable } from "../guards";

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
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
});

const priceOrdered = (offer: { priceMinMinor?: number | null; priceMaxMinor?: number | null }) =>
  offer.priceMinMinor == null || offer.priceMaxMinor == null || offer.priceMinMinor <= offer.priceMaxMinor;
const PRICE_ORDER = { message: "The lowest price cannot exceed the highest.", path: ["priceMinMinor"] };

// Currency is never accepted: offers are always in the org's frozen currency.
const CreateBody = OfferFields.partial().required({ name: true, dealType: true }).refine(priceOrdered, PRICE_ORDER);
const PatchBody = OfferFields.partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update")
  .refine(priceOrdered, PRICE_ORDER);

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

  app.delete("/offers/:id", { preHandler: WRITE }, async (req) => {
    const { id } = req.params as { id: string };
    await deleteOffer(req.auth!.orgId, req.auth!.seatId, id);
    return { deleted: true };
  });
}
