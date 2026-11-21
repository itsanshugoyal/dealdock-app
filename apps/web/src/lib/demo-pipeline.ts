import { normalizeDealTerms, type DealDto, type LeadEventDto, type LeadSourceDto, type LeadSourcesResponse } from "@dealdock/core";
import { DAY, DEMO_ACCOUNT_ID, HOUR, MINUTE } from "./demo-data";
import type { DemoLedgerEntry, DemoThread } from "./types";

/** A reported booking or payment as the demo stores it: the API's row, with its id at the tool and whether it was dealt with. */
export interface DemoLeadEvent extends LeadEventDto {
  externalId: string;
  handledAt: string | null;
}

/**
 * The coach pipeline and renewal samples (fictional): Razorpay and Calendly
 * connected; Sana paid through Razorpay (matched by name, so her
 * conversation is at Paid and suggests recording the sale); Karan booked a
 * call through Calendly; Neha is qualified; one Razorpay payment matched no
 * conversation. Urban Roots' reel, paid about four months ago, becomes a
 * paid deal, so Today suggests pitching them again. Also backfills sessions
 * saved before these existed, skipping what those no longer have.
 */
export function seedPipeline(now: number, state: { threads: DemoThread[]; deals?: DealDto[]; ledger: DemoLedgerEntry[] }): { sources: LeadSourceDto[]; events: DemoLeadEvent[] } {
  const iso = (at: number) => new Date(at).toISOString();
  const thread = (id: string) => state.threads.find((item) => item.id === id);
  const sources: LeadSourceDto[] = [
    { id: "src-razorpay", provider: "razorpay", label: null, lastEventAt: iso(now - 3 * HOUR), createdAt: iso(now - 40 * DAY), needsSecret: false },
    { id: "src-calendly", provider: "calendly", label: null, lastEventAt: iso(now - 20 * MINUTE), createdAt: iso(now - 30 * DAY), needsSecret: false },
  ];
  const events: DemoLeadEvent[] = [];
  const sana = thread("t-sana");
  if (sana) {
    sana.leadStage = "paid";
    events.push({ id: "lead-sana", sourceId: "src-razorpay", provider: "razorpay", kind: "paid", threadId: sana.id, amountMinor: 24_000_00, currencyCode: "INR", payerName: "Sana Qureshi", occurredAt: iso(now - 3 * HOUR), externalId: "pay_DemoSana001", handledAt: null });
  }
  const karan = thread("t-karan");
  if (karan) {
    karan.leadStage = "booked";
    events.push({ id: "lead-karan", sourceId: "src-calendly", provider: "calendly", kind: "booked", threadId: karan.id, amountMinor: null, currencyCode: null, payerName: "Karan Kapoor", occurredAt: iso(now + 2 * DAY), externalId: "https://api.calendly.example/invitees/karan", handledAt: null });
  }
  const neha = thread("e-neha");
  if (neha) neha.leadStage = "qualified";
  events.push({ id: "lead-kavya", sourceId: "src-razorpay", provider: "razorpay", kind: "paid", threadId: null, amountMinor: 7_999_00, currencyCode: "INR", payerName: "Kavya M", occurredAt: iso(now - 2 * DAY), externalId: "pay_DemoKavya01", handledAt: null });

  const sale = state.ledger.find((entry) => entry.handle === "urbanroots.in" && entry.threadId !== null);
  const sold = sale?.threadId ? thread(sale.threadId) : undefined;
  if (sale && sold && !state.deals?.some((deal) => deal.id === "deal-urbanroots")) {
    sale.dealId = "deal-urbanroots";
    const agreedAt = iso(sale.closedAt - 14 * DAY);
    state.deals = [...(state.deals ?? []), {
      id: "deal-urbanroots", threadId: sold.id, igAccountId: sold.igAccountId ?? DEMO_ACCOUNT_ID, counterpartyHandle: sold.handle, counterpartyName: sold.participant.name, channel: "instagram",
      title: sale.note ?? "Monsoon reel + 2 stories", dealType: "brand", amountMinor: sale.amountMinor, currencyCode: "INR", stage: "paid",
      terms: normalizeDealTerms({ deliverables: [{ id: "d1", label: "1 reel", dueAt: iso(sale.closedAt - 7 * DAY), done: true }, { id: "d2", label: "2 stories", dueAt: iso(sale.closedAt - 7 * DAY), done: true }], usage: "Organic only" }),
      agreedAt, dueAt: null, invoicedAt: null, paidAt: iso(sale.closedAt), receivedMinor: sale.amountMinor, tdsMinor: null, createdAt: agreedAt, updatedAt: iso(sale.closedAt), invoices: [], renewalHandledAt: null,
    }];
  }
  return { sources, events };
}

/** A stored event as the API returns it. */
export function leadEventDto({ externalId: _id, handledAt: _handled, ...event }: DemoLeadEvent): LeadEventDto {
  return event;
}

const newestFirst = (a: DemoLeadEvent, b: DemoLeadEvent) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.id.localeCompare(a.id);

/** GET /lead-sources: the tools, and what they reported that matched no conversation, newest first. */
export function leadSourcesView(sources: readonly LeadSourceDto[], events: readonly DemoLeadEvent[]): LeadSourcesResponse {
  return { sources: [...sources], unmatched: events.filter((event) => event.threadId === null && event.handledAt === null).sort(newestFirst).slice(0, 50).map(leadEventDto) };
}

/** ThreadDetail.leadPayments: reported payments not recorded or dismissed, newest first. */
export function leadPaymentsOf(events: readonly DemoLeadEvent[], threadId: string): LeadEventDto[] {
  return events.filter((event) => event.threadId === threadId && event.kind === "paid" && event.handledAt === null).sort(newestFirst).slice(0, 5).map(leadEventDto);
}
