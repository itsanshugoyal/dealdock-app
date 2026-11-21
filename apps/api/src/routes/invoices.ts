import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  BillingProfileInputSchema,
  INVOICE_KINDS,
  invoiceProof,
  InvoicePartySchema,
  type BillingProfileDto,
  type BillingProfileResponse,
  type InvoiceDto,
  type InvoicePaidResponse,
  type InvoicesResponse,
} from "@dealdock/core";
import {
  createInvoice,
  getBillingProfile,
  getInvoice,
  getInvoiceDealTerms,
  getInvoiceForDelivery,
  listDealInvoices,
  markInvoicePaid,
  upsertBillingProfile,
  voidInvoice,
} from "@dealdock/db";
import { requireAuth } from "../auth";
import { AccountRef, requirePermission, requireWritable } from "../guards";
import { invoiceFileName, renderInvoicePdf } from "../invoice-pdf";
import { verifyInvoiceSignature } from "../media-sign";

const When = z.string().datetime({ offset: true });
const Minor = z.number().int().nonnegative().safe();
/** Same shape as the deal and close-out keys (routes/deals.ts). */
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{16,200}$/);

const CreateBody = z.object({
  kind: z.enum(INVOICE_KINDS),
  dueAt: When.optional(),
  billTo: InvoicePartySchema,
  notes: z.string().trim().max(500).nullish().transform((value) => value || null),
});
const PaidBody = z.object({ receivedMinor: Minor.optional(), tdsMinor: Minor.optional(), paidAt: When.optional(), idempotencyKey: IdempotencyKey });

export async function invoiceRoutes(app: FastifyInstance) {
  const write = { preHandler: [requireAuth, requireWritable, requirePermission("close")] };

  /** The workspace's billing profile, or a creator account's own (falling back to the workspace's). */
  app.get("/settings/billing-profile", { preHandler: [requireAuth, requirePermission("manage_settings")] }, async (req, reply) => {
    const query = AccountRef.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    return (await getBillingProfile(req.auth!.orgId, query.data.igAccountId)) satisfies BillingProfileResponse;
  });

  /** Replace it; ?igAccountId= saves a creator account's own (Roster plan). */
  app.put("/settings/billing-profile", { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] }, async (req, reply) => {
    const query = AccountRef.safeParse(req.query);
    const body = BillingProfileInputSchema.safeParse(req.body);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    return (await upsertBillingProfile(req.auth!.orgId, req.auth!.seatId, query.data.igAccountId, body.data)) satisfies BillingProfileDto;
  });

  /** Issue an invoice for the whole fee, its advance or the balance. */
  app.post("/deals/:id/invoices", write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const invoice: InvoiceDto = await createInvoice(req.auth!.orgId, id, req.auth!.seatId, parsed.data);
    return reply.code(201).send(invoice);
  });

  app.get("/deals/:id/invoices", { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return { invoices: await listDealInvoices(req.auth!.orgId, id) } satisfies InvoicesResponse;
  });

  app.get("/invoices/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const invoice = await getInvoice(req.auth!.orgId, id);
    if (!invoice) return reply.code(404).send({ error: "not_found" });
    return invoice satisfies InvoiceDto;
  });

  app.post("/invoices/:id/void", write, async (req) => {
    const { id } = req.params as { id: string };
    return (await voidInvoice(req.auth!.orgId, id, req.auth!.seatId)) satisfies InvoiceDto;
  });

  /** One Revenue entry per invoice; the deal is paid once its paid invoices cover the fee. */
  app.post("/invoices/:id/paid", write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PaidBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    return (await markInvoicePaid(req.auth!.orgId, id, req.auth!.seatId, parsed.data)) satisfies InvoicePaidResponse;
  });

  /** Preview and download. */
  app.get("/invoices/:id/pdf", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const invoice = await getInvoice(req.auth!.orgId, id);
    if (!invoice) return reply.code(404).send({ error: "not_found" });
    return sendPdf(reply, invoice, "private, no-store");
  });

  /**
   * The PDF behind a signed link, for Meta's fetcher when the invoice goes in
   * a DM. Same capability model as /media/a/:id: the HMAC is the auth, every
   * failure is a plain 404, and it stays out of request logs.
   */
  app.get(
    "/media/invoices/:id/:file",
    { logLevel: "silent", helmet: { crossOriginResourcePolicy: { policy: "cross-origin" } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { exp, sig } = req.query as { exp?: unknown; sig?: unknown };
      const invoice = verifyInvoiceSignature(id, exp, sig) ? await getInvoiceForDelivery(id) : null;
      if (!invoice) return reply.code(404).send({ error: "not_found" });
      return sendPdf(reply, invoice, "private, max-age=300");
    },
  );
}

async function sendPdf(reply: FastifyReply, invoice: InvoiceDto, cacheControl: string) {
  // Proof of delivery reads the deal as it is now: posts and results added after issuing still go to the brand.
  const terms = await getInvoiceDealTerms(invoice.id);
  const pdf = await renderInvoicePdf(invoice, terms ? invoiceProof(terms) : null);
  return reply
    .header("content-type", "application/pdf")
    .header("content-disposition", `inline; filename="${invoiceFileName(invoice)}"`)
    .header("cache-control", cacheControl)
    .send(Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength));
}
