import type { DealStage, Prisma } from "@prisma/client";
import {
  DomainError,
  GST_INVOICE_NUMBER_MAX,
  OPEN_DEAL_STAGES,
  byDealUrgency,
  computeInvoice,
  dealRevenueMinor,
  defaultInvoiceDueAt,
  defaultReceivedMinor,
  dueFromPaymentDays,
  exclusivitiesAgainst,
  invoiceLineDescription,
  invoiceShareMinor,
  isDealOpen,
  normalizeDealTerms,
  renewalsDue,
  type Channel,
  type DealCreateRequest,
  type DealDeliverable,
  type DealDto,
  type DealPaidInput,
  type DealPaidRequest,
  type DealTerms,
  type DealUpdateRequest,
  type ExclusivityNote,
  type InvoiceCreateRequest,
  type InvoiceDto,
  type InvoicePaidRequest,
  type InvoicePaidResponse,
  type RenewalDto,
} from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { creatorAccountOf, requireIgAccountInOrg, requireSeatInOrg } from "../seat-scope";
import { minorUnitsToNumber, requireMinorUnits } from "../money";
import { INVOICE_SELECT, lockIssuerProfile, nextNumberOf, supplierOf, toInvoiceDto, type InvoiceRow } from "../invoice-rows";

/**
 * Deals: one agreement carried from the conversation to the money
 * (agreed → invoiced → paid, or cancelled). "Overdue" is derived from dueAt,
 * never stored. Each payment records one Revenue (ledger) entry: one per paid
 * invoice (an advance, then the balance), and "Mark paid" records what the
 * paid invoices left.
 */

const DEAL_SELECT = {
  id: true,
  threadId: true,
  igAccountId: true,
  counterpartyHandle: true,
  counterpartyName: true,
  title: true,
  dealType: true,
  amountMinor: true,
  currencyCode: true,
  stage: true,
  terms: true,
  agreedAt: true,
  dueAt: true,
  invoicedAt: true,
  paidAt: true,
  receivedMinor: true,
  tdsMinor: true,
  usageHandledAt: true,
  renewalHandledAt: true,
  idempotencyKey: true,
  createdAt: true,
  updatedAt: true,
  thread: { select: { participantHandle: true, participantName: true, igAccount: { select: { platform: true } } } },
  invoices: { select: INVOICE_SELECT, orderBy: [{ issuedAt: "asc" }, { id: "asc" }] },
  ledgerEntries: { where: { deletedAt: null }, select: { amountMinor: true } },
} satisfies Prisma.DealSelect;
type DealRow = Prisma.DealGetPayload<{ select: typeof DEAL_SELECT }>;

/** Email threads are email; every other platform shows as Instagram until it has its own channel. */
export function channelOf(platform: string): Channel {
  return platform === "email" ? "email" : "instagram";
}

/** The creator account a thread counts for: a channel inbox's owner (Gmail), else the thread's own account. */
export function creatorAccountId(thread: { igAccountId: string; igAccount: { ownerAccountId: string | null } }): string {
  return thread.igAccount.ownerAccountId ?? thread.igAccountId;
}

/** Threads that count for creator account X: its own and those of the channel inboxes it owns. */
export function threadsOfCreator(igAccountId: string): Prisma.ThreadWhereInput {
  return { OR: [{ igAccountId }, { igAccount: { ownerAccountId: igAccountId } }] };
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

function toDealDto(row: DealRow): DealDto {
  return {
    id: row.id,
    threadId: row.threadId,
    igAccountId: row.igAccountId,
    // A conversation's participant stays current as their profile refreshes; the stored party covers deals without one.
    counterpartyHandle: row.thread?.participantHandle ?? row.counterpartyHandle,
    counterpartyName: row.thread?.participantName ?? row.counterpartyName,
    channel: row.thread ? channelOf(row.thread.igAccount.platform) : null,
    title: row.title,
    dealType: row.dealType,
    amountMinor: minorUnitsToNumber(row.amountMinor),
    currencyCode: row.currencyCode,
    stage: row.stage,
    // Stored JSON may predate a field; normalizing fills the gaps.
    terms: normalizeDealTerms(row.terms),
    agreedAt: row.agreedAt.toISOString(),
    dueAt: iso(row.dueAt),
    invoicedAt: iso(row.invoicedAt),
    paidAt: iso(row.paidAt),
    receivedMinor: row.receivedMinor === null ? null : minorUnitsToNumber(row.receivedMinor, "receivedMinor"),
    tdsMinor: row.tdsMinor === null ? null : minorUnitsToNumber(row.tdsMinor, "tdsMinor"),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    invoices: row.invoices.map(toInvoiceDto),
    paidMinor: row.ledgerEntries.reduce((sum, entry) => sum + minorUnitsToNumber(entry.amountMinor), 0),
    usageHandledAt: iso(row.usageHandledAt),
    renewalHandledAt: iso(row.renewalHandledAt),
  };
}

/** What the deal's paid invoices brought in: their share of the fee, what arrived, and TDS (null when none was recorded). */
function invoicePayments(invoices: InvoiceRow[]) {
  const paid = invoices.filter((invoice) => invoice.status === "paid");
  const sum = (pick: (invoice: InvoiceRow) => bigint | null) => paid.reduce((total, invoice) => total + minorUnitsToNumber(pick(invoice) ?? 0n), 0);
  return {
    subtotalMinor: sum((invoice) => invoice.subtotalMinor),
    receivedMinor: sum((invoice) => invoice.receivedMinor),
    tdsMinor: paid.some((invoice) => invoice.tdsMinor !== null) ? sum((invoice) => invoice.tdsMinor) : null,
  };
}

/** A due date the deal took from this invoice moves to its next open invoice's, or clears; undefined leaves it alone. */
function dueAfter(deal: DealRow, settled: InvoiceRow): Date | null | undefined {
  if (deal.dueAt?.getTime() !== settled.dueAt.getTime()) return undefined;
  const next = deal.invoices
    .filter((invoice) => invoice.status === "issued" && invoice.id !== settled.id)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];
  return next?.dueAt ?? null;
}

function termsOf(input: unknown, base?: DealTerms): DealTerms {
  try {
    return normalizeDealTerms(input, base);
  } catch {
    throw new DomainError("invalid_deal_terms", 400);
  }
}

function nonNegativeMinor(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new DomainError(`${field}_must_be_a_non_negative_safe_integer`, 400);
  return value;
}

/**
 * What paying a deal (or an invoice) records: received defaults to the amount
 * billed less TDS; Revenue is received plus TDS, less any GST/VAT the invoice
 * collected for the government.
 */
export function paymentOf(amountMinor: number, input: DealPaidInput, now: Date, taxMinor = 0) {
  const tdsMinor = input.tdsMinor === undefined ? null : nonNegativeMinor(input.tdsMinor, "tdsMinor");
  const receivedMinor = input.receivedMinor === undefined ? defaultReceivedMinor(amountMinor, tdsMinor) : nonNegativeMinor(input.receivedMinor, "receivedMinor");
  return {
    paidAt: input.paidAt === undefined ? now : new Date(input.paidAt),
    receivedMinor,
    tdsMinor,
    revenueMinor: requireMinorUnits(dealRevenueMinor({ amountMinor, receivedMinor, tdsMinor }) - taxMinor, "revenueMinor"),
  };
}
type Payment = ReturnType<typeof paymentOf>;

const STAGE_MOVES: Record<DealStage, readonly DealStage[]> = {
  agreed: ["invoiced", "cancelled"],
  invoiced: ["agreed", "cancelled"],
  cancelled: ["agreed"],
  paid: [], // paid is entered by markDealPaid and left only when its Revenue entry is deleted
};

/**
 * The stage columns a PATCH writes. Invoicing stamps when payment was asked
 * for and, with no due date yet, dates it from the agreed payment days. Back
 * to agreed clears that stamp, so a reopened deal never reads as invoiced.
 */
export function stageChange(
  deal: { stage: DealStage; dueAt: Date | null },
  to: DealStage | undefined,
  paymentDays: number | null,
  now: Date,
): { stage?: DealStage; invoicedAt?: Date | null; dueAt?: Date } {
  if (to === undefined || to === deal.stage) return {};
  if (!STAGE_MOVES[deal.stage].includes(to)) throw new DomainError("deal_stage_change_not_allowed", 409);
  if (to === "invoiced") {
    const dueAt = deal.dueAt === null && paymentDays !== null ? { dueAt: new Date(dueFromPaymentDays(now, paymentDays)) } : {};
    return { stage: to, invoicedAt: now, ...dueAt };
  }
  return to === "agreed" ? { stage: to, invoicedAt: null } : { stage: to };
}

/**
 * Serialise one deal's writers (stage moves, terms merges, payment) on its
 * row, then read it: a double-submitted "Mark paid" then sees the first one's
 * result instead of racing it.
 */
async function lockDeal(tx: Prisma.TransactionClient, orgId: OrgId, dealId: string): Promise<DealRow> {
  await tx.$queryRaw`SELECT "id" FROM "Deal" WHERE "id" = ${dealId} AND "orgId" = ${orgId} FOR UPDATE`;
  const deal = await tx.deal.findFirst({ where: { id: dealId, orgId, deletedAt: null }, select: DEAL_SELECT });
  if (!deal) throw new DomainError("deal not in org", 404);
  return deal;
}

/** One Revenue entry for a payment on the deal (or one of its invoices), dated when the money arrived. */
async function recordRevenue(
  tx: Prisma.TransactionClient,
  orgId: OrgId,
  seatId: string,
  deal: DealRow,
  payment: Payment,
  idempotencyKey: string,
  invoice?: { id: string; number: string },
) {
  const created = await tx.ledgerEntry.createMany({
    data: [{
      orgId,
      threadId: deal.threadId,
      igAccountId: deal.igAccountId,
      counterpartyHandle: deal.counterpartyHandle,
      dealType: deal.dealType,
      amountMinor: payment.revenueMinor,
      currencyCode: deal.currencyCode,
      idempotencyKey,
      note: invoice ? `${deal.title} · ${invoice.number}` : deal.title,
      closedAt: payment.paidAt,
      createdBySeatId: seatId,
      dealId: deal.id,
      invoiceId: invoice?.id ?? null,
    }],
    skipDuplicates: true,
  });
  // A key (or deal link) already in the ledger must never leave a paid deal without its entry.
  if (created.count === 0) throw new DomainError("deal_idempotency_key_conflict", 409);
  const entry = await tx.ledgerEntry.findUniqueOrThrow({ where: { orgId_idempotencyKey: { orgId, idempotencyKey } }, select: { id: true } });
  await writeAudit(tx, {
    orgId,
    seatId,
    action: "ledger.created",
    entityType: "ledger_entry",
    entityId: entry.id,
    detail: { amountMinor: minorUnitsToNumber(payment.revenueMinor), dealType: deal.dealType, dealId: deal.id, ...(invoice ? { invoiceId: invoice.id } : {}) },
  });
}

/** Open deals by urgency (most overdue first), or every deal newest agreed first. Deleted ones never show. */
export async function listDeals(
  orgId: OrgId,
  opts: { status: "open" | "all"; igAccountId?: string; threadId?: string },
): Promise<DealDto[]> {
  if (opts.igAccountId !== undefined) await requireIgAccountInOrg(orgId, opts.igAccountId);
  // shortcut: unpaginated, fine for a creator's hundreds of deals; page it when an org reaches thousands.
  const rows = await prisma.deal.findMany({
    where: {
      orgId,
      deletedAt: null,
      ...(opts.status === "open" ? { stage: { in: [...OPEN_DEAL_STAGES] } } : {}),
      ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
      ...(opts.igAccountId !== undefined ? { igAccountId: opts.igAccountId } : {}),
    },
    orderBy: [{ agreedAt: "desc" }, { id: "desc" }],
    select: DEAL_SELECT,
  });
  const deals = rows.map(toDealDto);
  return opts.status === "open" ? deals.sort(byDealUrgency) : deals;
}

/** One live deal, or null when it isn't this org's or was deleted. */
export async function getDeal(orgId: OrgId, dealId: string): Promise<DealDto | null> {
  const deal = await prisma.deal.findFirst({ where: { id: dealId, orgId, deletedAt: null }, select: DEAL_SELECT });
  return deal ? toDealDto(deal) : null;
}

/**
 * A conversation as deal work reads it (term suggestions, recap and payment
 * drafts): the last messages drafting reads too, oldest first, each with when
 * it was sent so "by Friday" counts from then, and the org's time zone for
 * calendar days. Null when the thread isn't this org's.
 */
export async function getDealConversation(orgId: OrgId, threadId: string) {
  const thread = await prisma.thread.findFirst({
    where: { id: threadId, orgId },
    select: {
      igAccountId: true,
      participantHandle: true,
      igAccount: { select: { org: { select: { timezone: true } } } },
      messages: {
        where: { orgId },
        orderBy: [{ sentAt: "desc" }, { id: "desc" }],
        take: 12, // getDraftThreadContext's window
        select: { direction: true, contentType: true, text: true, transcript: true, sentAt: true },
      },
    },
  });
  if (!thread) return null;
  return {
    igAccountId: thread.igAccountId,
    participantHandle: thread.participantHandle,
    timezone: thread.igAccount.org.timezone,
    threadHistory: thread.messages.reverse().map((message) => ({ ...message, sentAt: message.sentAt.toISOString() })),
  };
}

/**
 * Who a new deal is with and which creator it counts for: its conversation's
 * participant and creator, or, for a deal agreed outside DealDock, the named
 * creator account (never an email inbox) and counterparty.
 */
async function dealParty(tx: Prisma.TransactionClient, orgId: OrgId, input: DealCreateRequest) {
  // Branch explicitly: Prisma reads `{ id: undefined }` as no filter, which would match any row.
  if (input.threadId !== undefined) {
    const thread = await tx.thread.findFirst({
      where: { id: input.threadId, orgId },
      select: { id: true, igAccountId: true, participantHandle: true, participantName: true, igAccount: { select: { ownerAccountId: true } } },
    });
    if (!thread) throw new DomainError("thread not in org", 404);
    return { threadId: thread.id, igAccountId: creatorAccountId(thread), counterpartyHandle: thread.participantHandle, counterpartyName: thread.participantName };
  }
  const counterpartyHandle = input.counterpartyHandle?.trim();
  if (input.igAccountId === undefined) throw new DomainError("ig_account_required", 400);
  if (!counterpartyHandle) throw new DomainError("counterparty_required", 400);
  const account = await tx.igAccount.findFirst({ where: { id: input.igAccountId, orgId }, select: { id: true, platform: true, ownerAccountId: true } });
  if (!account) throw new DomainError("ig_account_not_in_org", 404);
  if (account.platform === "email" || account.ownerAccountId !== null) throw new DomainError("creator_account_required", 400);
  return { threadId: null, igAccountId: account.id, counterpartyHandle, counterpartyName: input.counterpartyName?.trim() || null };
}

/**
 * Record a deal from a conversation, or one agreed outside DealDock (no
 * thread); `paid` records the money at once (the old "Record a sale").
 * Recording closes its thread, if any, exactly like closeDeal.
 */
export async function createDeal(orgId: OrgId, input: DealCreateRequest & { seatId: string }): Promise<DealDto> {
  await requireSeatInOrg(orgId, input.seatId);
  const amountMinor = requireMinorUnits(input.amountMinor);
  if (!input.idempotencyKey.trim()) throw new DomainError("idempotency_key_required", 400);
  const terms = termsOf(input.terms);
  const payment = input.paid ? paymentOf(input.amountMinor, input.paid, new Date()) : null;
  return prisma.$transaction(async (tx) => {
    const [party, org] = await Promise.all([
      dealParty(tx, orgId, input),
      tx.organization.findUnique({ where: { id: orgId }, select: { currencyCode: true } }),
    ]);
    if (!org) throw new DomainError("org_not_found", 404);

    // Same idempotency as closeDeal: a retry is a no-op that returns the same deal.
    const created = await tx.deal.createMany({
      data: [{
        orgId,
        ...party,
        title: input.title,
        dealType: input.dealType,
        amountMinor,
        currencyCode: org.currencyCode, // frozen at write time (ADR-9)
        terms: terms as unknown as Prisma.InputJsonValue,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        idempotencyKey: input.idempotencyKey,
        createdBySeatId: input.seatId,
        ...(payment
          ? { stage: "paid" as const, paidAt: payment.paidAt, receivedMinor: BigInt(payment.receivedMinor), tdsMinor: payment.tdsMinor === null ? null : BigInt(payment.tdsMinor) }
          : {}),
      }],
      skipDuplicates: true,
    });
    const deal = await tx.deal.findUniqueOrThrow({
      where: { orgId_idempotencyKey: { orgId, idempotencyKey: input.idempotencyKey } },
      select: DEAL_SELECT,
    });
    if (created.count === 0) {
      if (
        deal.threadId !== party.threadId ||
        deal.igAccountId !== party.igAccountId ||
        deal.title !== input.title ||
        deal.dealType !== input.dealType ||
        deal.amountMinor !== amountMinor
      ) {
        throw new DomainError("deal_idempotency_key_conflict", 409);
      }
      return toDealDto(deal);
    }

    if (party.threadId !== null) await tx.thread.update({ where: { id: party.threadId }, data: { state: "closed", waitingSince: null } });
    await writeAudit(tx, {
      orgId,
      seatId: input.seatId,
      action: "deal.created",
      entityType: "deal",
      entityId: deal.id,
      detail: { amountMinor: input.amountMinor, dealType: input.dealType, stage: deal.stage },
    });
    // Recording the sale a payment tool reported in this conversation handles that payment.
    if (input.leadEventId && party.threadId !== null) {
      await tx.leadEvent.updateMany({ where: { id: input.leadEventId, orgId, threadId: party.threadId, handledAt: null }, data: { handledAt: new Date() } });
    }
    if (!payment) return toDealDto(deal);
    await recordRevenue(tx, orgId, input.seatId, deal, payment, `${input.idempotencyKey}:paid`);
    // Read back with its Revenue entry (paidMinor), as a retry will see it.
    return toDealDto(await tx.deal.findUniqueOrThrow({ where: { id: deal.id }, select: DEAL_SELECT }));
  });
}

/**
 * Edit a deal. Amount and type change only while it is open (an edit form
 * resending the same values is fine); terms merge into the stored ones. Stage
 * moves agreed ↔ invoiced, open → cancelled and cancelled → agreed; paid goes
 * through markDealPaid.
 */
export async function updateDeal(orgId: OrgId, dealId: string, seatId: string, input: DealUpdateRequest): Promise<DealDto> {
  await requireSeatInOrg(orgId, seatId);
  const amountMinor = input.amountMinor === undefined ? undefined : requireMinorUnits(input.amountMinor);
  return prisma.$transaction(async (tx) => {
    const deal = await lockDeal(tx, orgId, dealId);

    const current = normalizeDealTerms(deal.terms);
    const terms = input.terms === undefined ? undefined : termsOf(input.terms, current);
    const dueAt = input.dueAt === undefined ? deal.dueAt : input.dueAt === null ? null : new Date(input.dueAt);
    const stage = stageChange({ stage: deal.stage, dueAt }, input.stage, (terms ?? current).paymentDays, new Date());
    const moneyChanged = (amountMinor !== undefined && amountMinor !== deal.amountMinor) || (input.dealType !== undefined && input.dealType !== deal.dealType);
    if (moneyChanged && !isDealOpen({ stage: stage.stage ?? deal.stage })) throw new DomainError("deal_not_open", 409);
    // Invoices bill shares of this fee: void them before changing it.
    if (amountMinor !== undefined && amountMinor !== deal.amountMinor && deal.invoices.some((invoice) => invoice.status !== "void")) {
      throw new DomainError("deal_has_invoices", 409);
    }
    // A cancelled deal must not leave an unpaid invoice standing as if the brand still owed it.
    if (stage.stage === "cancelled" && deal.invoices.some((invoice) => invoice.status === "issued")) {
      throw new DomainError("void_invoices_first", 409);
    }

    const updated = await tx.deal.update({
      where: { id: deal.id },
      data: {
        title: input.title,
        dealType: input.dealType,
        amountMinor,
        ...(terms ? { terms: terms as unknown as Prisma.InputJsonValue } : {}),
        ...(input.dueAt !== undefined ? { dueAt } : {}),
        ...stage,
      },
      select: DEAL_SELECT,
    });
    await writeAudit(tx, {
      orgId,
      seatId,
      action: "deal.updated",
      entityType: "deal",
      entityId: deal.id,
      detail: { fields: Object.keys(input), from: deal.stage, to: updated.stage },
    });
    return toDealDto(updated);
  });
}

/**
 * Record the money for an open deal: stage paid plus a Revenue entry for what
 * its paid invoices left (all of it without invoices). A deal with an unpaid
 * invoice is paid through that invoice. A retry of the same request returns
 * the paid deal.
 */
export async function markDealPaid(orgId: OrgId, dealId: string, seatId: string, input: DealPaidRequest): Promise<DealDto> {
  await requireSeatInOrg(orgId, seatId);
  if (!input.idempotencyKey.trim()) throw new DomainError("idempotency_key_required", 400);
  return prisma.$transaction(async (tx) => {
    const deal = await lockDeal(tx, orgId, dealId);

    // Per request, so a deal reopened by deleting its payment can be paid again.
    const ledgerKey = `${deal.idempotencyKey}:paid:${input.idempotencyKey}`;
    if (deal.stage === "paid") {
      const entry = await tx.ledgerEntry.findFirst({ where: { orgId, dealId: deal.id, idempotencyKey: ledgerKey }, select: { id: true } });
      if (!entry) throw new DomainError("deal_already_paid", 409);
    } else if (deal.invoices.some((invoice) => invoice.status === "issued")) {
      throw new DomainError("deal_has_open_invoices", 409);
    }
    const invoiced = invoicePayments(deal.invoices);
    // A retry is measured against the stored payment date, so a defaulted paidAt matches.
    const payment = paymentOf(minorUnitsToNumber(deal.amountMinor) - invoiced.subtotalMinor, input, deal.paidAt ?? new Date());
    // The deal's totals include what its paid invoices brought in.
    const values = {
      paidAt: payment.paidAt,
      receivedMinor: BigInt(invoiced.receivedMinor + payment.receivedMinor),
      tdsMinor: invoiced.tdsMinor === null && payment.tdsMinor === null ? null : BigInt((invoiced.tdsMinor ?? 0) + (payment.tdsMinor ?? 0)),
    };
    if (deal.stage === "paid") {
      if (deal.paidAt?.getTime() !== values.paidAt.getTime() || deal.receivedMinor !== values.receivedMinor || deal.tdsMinor !== values.tdsMinor) {
        throw new DomainError("deal_idempotency_key_conflict", 409);
      }
      return toDealDto(deal);
    }
    if (!isDealOpen(deal)) throw new DomainError("deal_not_open", 409);

    // The Revenue entry first, so the paid deal reads back with it (paidMinor).
    await recordRevenue(tx, orgId, seatId, deal, payment, ledgerKey);
    const paid = await tx.deal.update({ where: { id: deal.id }, data: { stage: "paid", ...values }, select: DEAL_SELECT });
    await writeAudit(tx, {
      orgId,
      seatId,
      action: "deal.paid",
      entityType: "deal",
      entityId: deal.id,
      detail: { receivedMinor: payment.receivedMinor, tdsMinor: payment.tdsMinor, revenueMinor: minorUnitsToNumber(payment.revenueMinor) },
    });
    return toDealDto(paid);
  });
}

/** Today's usage-rights reminder dealt with (renewed, stopped or dismissed), or brought back with `handled` false. */
export async function setUsageHandled(orgId: OrgId, dealId: string, seatId: string, handled: boolean): Promise<DealDto> {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    const deal = await lockDeal(tx, orgId, dealId);
    const updated = await tx.deal.update({ where: { id: deal.id }, data: { usageHandledAt: handled ? new Date() : null }, select: DEAL_SELECT });
    await writeAudit(tx, { orgId, seatId, action: "deal.updated", entityType: "deal", entityId: deal.id, detail: { fields: ["usageHandledAt"], handled } });
    return toDealDto(updated);
  });
}

/**
 * The renewal prompt for a paid deal dealt with: "Not now", or the pitch copied
 * to send from Instagram or email. A pitch sent through DealDock marks it in
 * persistSendIntent instead. Doing it twice changes nothing.
 */
export async function handleRenewal(orgId: OrgId, dealId: string, seatId: string, how: "not_now" | "copied"): Promise<DealDto> {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    const deal = await lockDeal(tx, orgId, dealId);
    if (deal.stage !== "paid") throw new DomainError("deal_not_paid", 409);
    if (deal.renewalHandledAt) return toDealDto(deal);
    const updated = await tx.deal.update({ where: { id: deal.id }, data: { renewalHandledAt: new Date() }, select: DEAL_SELECT });
    await writeAudit(tx, { orgId, seatId, action: how === "copied" ? "deal.renewal_copied" : "deal.renewal_dismissed", entityType: "deal", entityId: deal.id });
    return toDealDto(updated);
  });
}

/** Brands to pitch again (core renewalsDue) on the org's calendar, one creator's with igAccountId. */
export async function listRenewals(orgId: OrgId, opts: { now?: Date; igAccountId?: string } = {}): Promise<RenewalDto[]> {
  const [deals, org] = await Promise.all([
    listDeals(orgId, { status: "all", igAccountId: opts.igAccountId }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } }),
  ]);
  if (!org) throw new DomainError("org_not_found", 404);
  return renewalsDue(deals, opts.now ?? new Date(), org.timezone).map(({ deal, festive }) => ({ deal, festive }));
}

/**
 * One deliverable's post and results, merged into the stored terms under the
 * deal's lock (a fetch from Instagram, while the creator may be editing
 * another deliverable). 404 when the deliverable isn't on the deal.
 */
export async function updateDeliverable(
  orgId: OrgId,
  dealId: string,
  seatId: string,
  deliverableId: string,
  patch: Partial<Pick<DealDeliverable, "postUrl" | "postedAt" | "metrics" | "metricsAt">>,
): Promise<DealDto> {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    const deal = await lockDeal(tx, orgId, dealId);
    const current = normalizeDealTerms(deal.terms);
    if (!current.deliverables.some((item) => item.id === deliverableId)) throw new DomainError("deliverable not on deal", 404);
    const terms = termsOf({ deliverables: current.deliverables.map((item) => (item.id === deliverableId ? { ...item, ...patch } : item)) }, current);
    const updated = await tx.deal.update({ where: { id: deal.id }, data: { terms: terms as unknown as Prisma.InputJsonValue }, select: DEAL_SELECT });
    await writeAudit(tx, { orgId, seatId, action: "deal.updated", entityType: "deal", entityId: deal.id, detail: { fields: ["terms.deliverables"], deliverableId } });
    return toDealDto(updated);
  });
}

/**
 * Exclusivities a conversation with `counterpartyHandle` could break: those
 * still running on the same creator account's other deals (an email inbox
 * counts as its creator). Never another creator's.
 */
export async function listActiveExclusivities(orgId: OrgId, accountId: string, counterpartyHandle: string, now = new Date()): Promise<ExclusivityNote[]> {
  const igAccountId = await creatorAccountOf(orgId, accountId);
  // shortcut: reads the creator's live deals and filters in memory; move the end date into a column if a creator reaches thousands of deals.
  const rows = await prisma.deal.findMany({
    where: { orgId, igAccountId, deletedAt: null, stage: { not: "cancelled" } },
    select: { id: true, threadId: true, igAccountId: true, counterpartyHandle: true, counterpartyName: true, stage: true, terms: true, thread: { select: { participantHandle: true, participantName: true } } },
  });
  const deals = rows.flatMap((row) => {
    try {
      return [{
        ...row,
        counterpartyHandle: row.thread?.participantHandle ?? row.counterpartyHandle,
        counterpartyName: row.thread?.participantName ?? row.counterpartyName,
        terms: normalizeDealTerms(row.terms),
      }];
    } catch {
      return []; // A deal whose stored terms no longer validate can't hold an exclusivity.
    }
  });
  return exclusivitiesAgainst(deals, { igAccountId, counterpartyHandle }, now);
}

/** SYSTEM CONTEXT: the terms of the deal an invoice belongs to, for the PDF's proof of delivery. The caller already authorised the invoice. */
export async function getInvoiceDealTerms(invoiceId: string): Promise<DealTerms | null> {
  const row = await prisma.invoice.findFirst({ where: { id: invoiceId }, select: { deal: { select: { terms: true } } } });
  if (!row) return null;
  try {
    return normalizeDealTerms(row.deal.terms);
  } catch {
    return null;
  }
}

/** Soft delete; the deal's Revenue entries go with it, as deleteLedgerEntry would. Its invoices stay, unread, with their numbers used. */
export async function deleteDeal(orgId: OrgId, dealId: string, seatId: string) {
  await requireSeatInOrg(orgId, seatId);
  await prisma.$transaction(async (tx) => {
    const deal = await lockDeal(tx, orgId, dealId);
    const now = new Date();
    await tx.deal.update({ where: { id: deal.id }, data: { deletedAt: now } });
    await writeAudit(tx, { orgId, seatId, action: "deal.deleted", entityType: "deal", entityId: deal.id });
    const entries = await tx.ledgerEntry.findMany({ where: { orgId, dealId: deal.id, deletedAt: null }, select: { id: true } });
    for (const entry of entries) {
      await tx.ledgerEntry.update({ where: { id: entry.id }, data: { deletedAt: now } });
      await writeAudit(tx, { orgId, seatId, action: "ledger.deleted", entityType: "ledger_entry", entityId: entry.id, detail: { dealId: deal.id } });
    }
  });
}

/**
 * Issue an invoice for (part of) a deal: numbered from the issuer's billing
 * profile (the creator account's own on Roster, else the workspace's) while
 * that profile is locked, taxed by core's rules and frozen as printed. An
 * agreed deal becomes invoiced and takes the invoice's due date when it has
 * none.
 */
export async function createInvoice(orgId: OrgId, dealId: string, seatId: string, input: InvoiceCreateRequest): Promise<InvoiceDto> {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    const deal = await lockDeal(tx, orgId, dealId);
    if (!isDealOpen(deal)) throw new DomainError("deal_not_open", 409);
    const terms = normalizeDealTerms(deal.terms);
    const invoicedMinor = deal.invoices
      .filter((invoice) => invoice.status !== "void")
      .reduce((sum, invoice) => sum + minorUnitsToNumber(invoice.subtotalMinor), 0);
    const baseMinor = invoiceShareMinor(input.kind, { amountMinor: minorUnitsToNumber(deal.amountMinor), advancePercent: terms.advancePercent }, invoicedMinor);

    const [profile, org] = await Promise.all([
      lockIssuerProfile(tx, orgId, deal.igAccountId),
      tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { timezone: true, locale: true } }),
    ]);
    const now = new Date();
    const next = nextNumberOf(profile, org.timezone, now);
    if (profile.country === "IN" && next.number.length > GST_INVOICE_NUMBER_MAX) throw new DomainError("invoice_number_too_long", 409);
    const supplier = supplierOf(profile, org);
    const computed = computeInvoice({ baseMinor, description: invoiceLineDescription(input.kind, deal.title, terms.advancePercent), supplier, billTo: input.billTo });
    // A due date the deal took from an earlier invoice (an advance) is that invoice's, not the deal's.
    const borrowed = deal.invoices.some((invoice) => invoice.status !== "void" && invoice.dueAt.getTime() === deal.dueAt?.getTime());
    const dueAt = new Date(input.dueAt ?? defaultInvoiceDueAt(input.kind, { dueAt: borrowed ? null : iso(deal.dueAt), paymentDays: terms.paymentDays }, now));

    await tx.billingProfile.update({ where: { id: profile.id }, data: { numberYear: next.year, nextNumber: next.sequence + 1 } });
    const json = (value: unknown) => value as Prisma.InputJsonValue;
    let invoice: InvoiceRow;
    try {
      invoice = await tx.invoice.create({
        data: {
          orgId,
          dealId: deal.id,
          kind: input.kind,
          number: next.number,
          issuedAt: now,
          dueAt,
          currencyCode: deal.currencyCode,
          supplier: json(supplier),
          billTo: json(input.billTo),
          lines: json(computed.lines),
          taxes: json(computed.taxes),
          subtotalMinor: BigInt(computed.subtotalMinor),
          taxMinor: BigInt(computed.taxMinor),
          totalMinor: BigInt(computed.totalMinor),
          supplyType: computed.supplyType,
          placeOfSupply: computed.placeOfSupply,
          notes: input.notes ?? null,
          createdBySeatId: seatId,
        },
        select: INVOICE_SELECT,
      });
    } catch (err) {
      // Only an edited prefix or country can land on a number already issued.
      if ((err as { code?: string }).code === "P2002") throw new DomainError("invoice_number_conflict", 409);
      throw err;
    }

    if (deal.stage === "agreed" || deal.dueAt === null) {
      await tx.deal.update({
        where: { id: deal.id },
        data: { ...(deal.stage === "agreed" ? { stage: "invoiced" as const, invoicedAt: now } : {}), ...(deal.dueAt === null ? { dueAt } : {}) },
      });
    }
    await writeAudit(tx, {
      orgId,
      seatId,
      action: "invoice.created",
      entityType: "invoice",
      entityId: invoice.id,
      detail: { dealId: deal.id, number: invoice.number, kind: input.kind, totalMinor: computed.totalMinor },
    });
    return toInvoiceDto(invoice);
  });
}

/** The invoice and its deal, locked; the deal must still be live. */
async function lockInvoice(tx: Prisma.TransactionClient, orgId: OrgId, invoiceId: string) {
  const found = await tx.invoice.findFirst({ where: { id: invoiceId, orgId }, select: { dealId: true } });
  if (!found) throw new DomainError("invoice not in org", 404);
  const deal = await lockDeal(tx, orgId, found.dealId);
  return { deal, invoice: deal.invoices.find((invoice) => invoice.id === invoiceId)! };
}

/** Withdraw an unpaid invoice. Its number stays used; a due date the deal took from it moves on. Voiding twice is a no-op. */
export async function voidInvoice(orgId: OrgId, invoiceId: string, seatId: string): Promise<InvoiceDto> {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    const { deal, invoice } = await lockInvoice(tx, orgId, invoiceId);
    if (invoice.status === "void") return toInvoiceDto(invoice);
    // A paid invoice's money stands until its Revenue entry is deleted.
    if (invoice.status === "paid") throw new DomainError("invoice_already_paid", 409);
    const voided = await tx.invoice.update({ where: { id: invoice.id }, data: { status: "void", voidedAt: new Date() }, select: INVOICE_SELECT });
    const dueAt = dueAfter(deal, invoice);
    if (dueAt !== undefined) await tx.deal.update({ where: { id: deal.id }, data: { dueAt } });
    await writeAudit(tx, { orgId, seatId, action: "invoice.voided", entityType: "invoice", entityId: invoice.id, detail: { dealId: deal.id, number: invoice.number } });
    return toInvoiceDto(voided);
  });
}

/**
 * Record one invoice's payment and its Revenue entry (what arrived plus TDS,
 * less the GST/VAT it collected). The deal is paid once its paid invoices
 * cover the fee; until then it stays open. A retry with the same key returns
 * the same result.
 */
export async function markInvoicePaid(orgId: OrgId, invoiceId: string, seatId: string, input: InvoicePaidRequest): Promise<InvoicePaidResponse> {
  await requireSeatInOrg(orgId, seatId);
  if (!input.idempotencyKey.trim()) throw new DomainError("idempotency_key_required", 400);
  return prisma.$transaction(async (tx) => {
    const { deal, invoice } = await lockInvoice(tx, orgId, invoiceId);
    const ledgerKey = `${deal.idempotencyKey}:invoice:${invoice.id}:${input.idempotencyKey}`;
    const payment = paymentOf(minorUnitsToNumber(invoice.totalMinor), input, invoice.paidAt ?? new Date(), minorUnitsToNumber(invoice.taxMinor));
    const values = {
      paidAt: payment.paidAt,
      receivedMinor: BigInt(payment.receivedMinor),
      tdsMinor: payment.tdsMinor === null ? null : BigInt(payment.tdsMinor),
    };
    if (invoice.status === "paid") {
      const entry = await tx.ledgerEntry.findFirst({ where: { orgId, invoiceId: invoice.id }, select: { idempotencyKey: true } });
      if (entry?.idempotencyKey !== ledgerKey) throw new DomainError("invoice_already_paid", 409);
      if (invoice.paidAt?.getTime() !== values.paidAt.getTime() || invoice.receivedMinor !== values.receivedMinor || invoice.tdsMinor !== values.tdsMinor) {
        throw new DomainError("invoice_idempotency_key_conflict", 409);
      }
      return { invoice: toInvoiceDto(invoice), deal: toDealDto(deal) };
    }
    if (invoice.status === "void") throw new DomainError("invoice_void", 409);
    if (!isDealOpen(deal)) throw new DomainError("deal_not_open", 409);

    const paid = await tx.invoice.update({ where: { id: invoice.id }, data: { status: "paid", ...values }, select: INVOICE_SELECT });
    await writeAudit(tx, {
      orgId,
      seatId,
      action: "invoice.paid",
      entityType: "invoice",
      entityId: invoice.id,
      detail: { dealId: deal.id, number: invoice.number, receivedMinor: payment.receivedMinor, tdsMinor: payment.tdsMinor, revenueMinor: minorUnitsToNumber(payment.revenueMinor) },
    });
    await recordRevenue(tx, orgId, seatId, deal, payment, ledgerKey, { id: invoice.id, number: invoice.number });

    const invoiced = invoicePayments(deal.invoices.map((row) => (row.id === paid.id ? paid : row)));
    const covered = invoiced.subtotalMinor >= minorUnitsToNumber(deal.amountMinor);
    const dueAt = covered ? undefined : dueAfter(deal, invoice);
    const settled = covered
      ? await tx.deal.update({
          where: { id: deal.id },
          data: {
            stage: "paid",
            paidAt: payment.paidAt,
            receivedMinor: BigInt(invoiced.receivedMinor),
            tdsMinor: invoiced.tdsMinor === null ? null : BigInt(invoiced.tdsMinor),
          },
          select: DEAL_SELECT,
        })
      : await tx.deal.update({ where: { id: deal.id }, data: { updatedAt: new Date(), ...(dueAt === undefined ? {} : { dueAt }) }, select: DEAL_SELECT });
    if (covered) {
      await writeAudit(tx, {
        orgId,
        seatId,
        action: "deal.paid",
        entityType: "deal",
        entityId: deal.id,
        detail: { receivedMinor: invoiced.receivedMinor, tdsMinor: invoiced.tdsMinor, invoiceId: invoice.id },
      });
    }
    return { invoice: toInvoiceDto(paid), deal: toDealDto(settled) };
  });
}
