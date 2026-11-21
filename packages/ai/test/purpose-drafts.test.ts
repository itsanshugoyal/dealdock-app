import type { DealDto, InvoiceDto } from "@dealdock/core";
import { describe, expect, it } from "vitest";
import { HeuristicPipeline } from "../src/heuristic-pipeline";
import { buildDraftPrompt } from "../src/prompts";
import { lintDraft } from "../src/style-learning";
import { hindiShare } from "../src/style-text";
import type { CreatorContext, DraftInput } from "../src/types";

const creator: CreatorContext = {
  businessSummary: "Skincare creator",
  currencyCode: "INR",
  locale: "en-IN",
  typicalBrandDealMinor: null,
  typicalCoachingMinor: null,
  typicalCourseMinor: null,
  styleCard: { greeting: "Hey hey!", signoff: "– R" },
  correctionExamples: [],
};
const deal: DealDto = {
  id: "deal-1", threadId: "t1", igAccountId: "ig1", counterpartyHandle: "glowco", counterpartyName: "Glow Co", channel: "instagram",
  title: "1 reel + 2 stories", dealType: "brand", amountMinor: 5_250_000, currencyCode: "INR", stage: "invoiced",
  terms: {
    deliverables: [
      { id: "d1", label: "1 reel", dueAt: "2026-11-06T18:29:59.000Z", done: false },
      { id: "d2", label: "2 stories", dueAt: null, done: false },
    ],
    usage: "Paid ads, 3 months", exclusivity: "No other skincare brands, 30 days", revisionsIncluded: 2, advancePercent: 50, paymentDays: 30,
    notes: "Their finance team is slow",
  },
  agreedAt: "2026-10-01T00:00:00Z", dueAt: "2026-10-20T18:29:59.000Z", invoicedAt: "2026-10-01T00:00:00Z", paidAt: null,
  receivedMinor: null, tdsMinor: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
};
const bare: DealDto = { ...deal, title: "Diwali campaign", terms: { deliverables: [], usage: null, exclusivity: null, revisionsIncluded: null, advancePercent: null, paymentDays: null, notes: null }, dueAt: null };
const input = (over: Partial<DraftInput> = {}): DraftInput => ({
  kind: "reply", classificationLabel: "brand_deal", threadHistory: [{ direction: "inbound", text: "Sounds good!" }], creator,
  purpose: "recap", deal, now: new Date("2026-10-02T00:00:00Z"), timezone: "Asia/Kolkata", ...over,
});
const draft = (over: Partial<DraftInput> = {}) => new HeuristicPipeline().draft(input(over));
/** `now` for a payment that is this many days late (due 20 Oct, end of day in India). */
const late = (days: number) => new Date(Date.parse("2026-10-20T18:29:59.000Z") + days * 86_400_000 + 3_600_000);

describe("recap drafts", () => {
  it("restates every term exactly, in the creator's voice, and asks to confirm", async () => {
    const { body, lintViolations } = await draft();
    expect(body).toBe(
      "Hey hey! Quick recap so we're on the same page: 1 reel by 6 Nov and 2 stories, for ₹52,500. Usage: Paid ads, 3 months. " +
        "Exclusivity: No other skincare brands, 30 days. 2 rounds of revisions included. 50% advance (₹26,250), balance within 30 days of invoice. " +
        "Payment due by 20 Oct. Can you confirm this works for you?\n– R",
    );
    expect(body).not.toContain("finance team");
    expect(lintViolations).toEqual([]);
  });

  it("skips terms the deal doesn't have", async () => {
    const { body } = await draft({ deal: bare });
    expect(body).toBe("Hey hey! Quick recap so we're on the same page: Diwali campaign, for ₹52,500. Can you confirm this works for you?\n– R");
  });

  it("goes light Hinglish when the conversation does", async () => {
    const { body } = await draft({ threadHistory: [{ direction: "inbound", text: "Haan theek hai, kar dete hain" }] });
    expect(body).toContain("₹52,500 mein");
    expect(hindiShare(body)).toBeGreaterThan(0.1);
  });

  it("needs the deal", async () => {
    await expect(draft({ deal: undefined })).rejects.toThrow("needs the deal");
  });
});

describe("payment reminders", () => {
  it("gets firmer as the payment gets later, always naming the amount and due date", async () => {
    const gentle = (await draft({ purpose: "payment_reminder", now: late(2) })).body;
    const firm = (await draft({ purpose: "payment_reminder", now: late(9) })).body;
    const final = (await draft({ purpose: "payment_reminder", now: late(30) })).body;
    for (const body of [gentle, firm, final]) {
      expect(body).toContain("₹52,500");
      expect(body).toContain("20 Oct");
      expect(body).not.toMatch(/legal|lawyer|invoice (?:no|number|#)|account number|ifsc/i);
    }
    expect(gentle).toContain("A quick reminder");
    expect(firm).toContain("process it this week");
    expect(final).toContain("pause any further work until the payment comes through");
    expect(gentle).not.toContain("pause");
  });

  it("stays gentle before the due date, and without one", async () => {
    expect((await draft({ purpose: "payment_reminder", now: new Date("2026-10-10T00:00:00Z") })).body).toContain("A quick reminder about the payment of ₹52,500 for 1 reel + 2 stories, due on 20 Oct.");
    expect((await draft({ purpose: "payment_reminder", deal: bare })).body).toContain("A quick reminder about the payment of ₹52,500 for Diwali campaign.");
  });

  it("follows the conversation into Hinglish", async () => {
    const { body } = await draft({ purpose: "payment_reminder", now: late(30), threadHistory: [{ direction: "inbound", text: "Bhai payment kab tak hoga, batao" }] });
    expect(body).toContain("₹52,500");
    expect(body).toContain("aage ka kaam pause");
    expect(hindiShare(body)).toBeGreaterThan(0.2);
  });
});

describe("deal amounts in purpose drafts", () => {
  const amounts = buildDraftPrompt(input()).lint.amounts!;
  const lint = (text: string) => lintDraft(text, { avoidPhrases: [], targetWords: null, amounts });

  it("allows only the deal amount and its advance, however they are written", () => {
    expect(amounts.allowedMinor).toEqual([5_250_000, 2_625_000]);
    expect(lint("It's ₹52,500 with ₹26,250 upfront.")).toEqual([]);
    expect(lint("That's 52.5k all in, plus 2 stories.")).toEqual([]);
    expect(lint("It's ₹53,000.")).toEqual(["State money exactly as the deal has it: ₹52,500 or ₹26,250, and no other amount"]);
    expect(lint("It's ₹52,500 ($630).")).toHaveLength(1);
    expect(lint("1 reel + 2 stories by 6 Nov, 50% advance, net 30.")).toEqual([]);
  });

  it("is not applied to ordinary replies", () => {
    expect(buildDraftPrompt(input({ purpose: undefined })).lint.amounts).toBeUndefined();
  });
});

describe("purpose prompts", () => {
  it("adds the deal and the job to the user turn and keeps the voice block cached", () => {
    const recap = buildDraftPrompt(input());
    const reply = buildDraftPrompt(input({ purpose: undefined }));
    expect(recap.system).toEqual(reply.system);
    expect(recap.user).toContain("Deliverables: 1 reel by 6 Nov and 2 stories");
    expect(recap.user).toContain("Fee: ₹52,500");
    expect(recap.user).toContain("Payment terms: 50% advance (₹26,250), balance within 30 days of invoice");
    expect(recap.user).toContain("restate every term in <deal> exactly and add none");
    expect(recap.user).not.toContain("finance team");
    expect(recap.user.indexOf("<deal>")).toBeLessThan(recap.user.indexOf("<task>"));
    expect(recap.targetWords).toBeGreaterThan(reply.targetWords);

    const reminder = buildDraftPrompt(input({ purpose: "payment_reminder", now: late(9) }));
    expect(reminder.user).toContain("Payment due: 20 Oct (9 days late)");
    expect(reminder.user).toContain("Tone: firm but polite");
    expect(reminder.user).toContain("Never invent invoice numbers, bank details or payment links");
    expect(reminder.user).not.toContain("Usage:");
  });

  it("prints due dates on the org's calendar day", () => {
    const newYork = { ...deal, currencyCode: "USD", terms: { ...deal.terms, deliverables: [{ id: "d1", label: "1 reel", dueAt: "2026-11-07T04:59:59.000Z", done: false }] } };
    const prompt = buildDraftPrompt(input({ deal: newYork, creator: { ...creator, currencyCode: "USD", locale: "en-US" }, timezone: "America/New_York" }));
    expect(prompt.user).toContain("Deliverables: 1 reel by Nov 6");
    expect(prompt.user).toContain("Fee: $52,500");
  });
});

describe("invoice cover notes", () => {
  // The advance half of the deal with 18% GST: ₹26,250 + ₹4,725 = ₹30,975.
  const invoice = {
    id: "inv-1", dealId: "deal-1", kind: "advance", number: "INV-2026-27-001", status: "issued", title: "Tax invoice",
    issuedAt: "2026-10-02T00:00:00.000Z", dueAt: "2026-10-09T18:29:59.000Z", currencyCode: "INR",
    subtotalMinor: 2_625_000, taxMinor: 472_500, totalMinor: 3_097_500,
  } as InvoiceDto;
  const note = (over: Partial<DraftInput> = {}) => draft({ purpose: "invoice", invoice, kind: "nudge", ...over });

  it("names the invoice number, total and due date, and leaves bank and tax details to the PDF", async () => {
    const { body, lintViolations } = await note();
    expect(body).toBe(
      "Hey hey! Sharing the advance invoice for 1 reel + 2 stories: INV-2026-27-001 for ₹30,975, due by 9 Oct. " +
        "The PDF is attached with the payment details. Let me know once it's processed!\n– R",
    );
    expect(body).not.toMatch(/ifsc|account number|gstin|upi/i);
    expect(lintViolations).toEqual([]);
  });

  it("follows the conversation into Hinglish", async () => {
    const { body } = await note({ threadHistory: [{ direction: "inbound", text: "Haan invoice bhej do, process kar dete hain" }] });
    expect(body).toContain("INV-2026-27-001");
    expect(body).toContain("₹30,975");
    expect(body).toContain("PDF attached hai");
  });

  it("needs the invoice", async () => {
    await expect(note({ invoice: undefined })).rejects.toThrow("needs the invoice");
  });

  it("puts the invoice in <deal> and allows only its amounts", () => {
    const prompt = buildDraftPrompt(input({ purpose: "invoice", invoice, kind: "nudge" }));
    expect(prompt.user).toContain("Invoice: INV-2026-27-001 (advance invoice), attached as a PDF");
    expect(prompt.user).toContain("Amount: ₹30,975 including tax");
    expect(prompt.user).toContain("Due: 9 Oct");
    expect(prompt.user).toContain("Never state bank details, tax numbers or payment links");
    expect(prompt.user).not.toContain("Usage:");
    const amounts = prompt.lint.amounts!;
    expect(amounts.allowedMinor).toEqual([3_097_500, 2_625_000, 5_250_000]);
    const lint = (text: string) => lintDraft(text, { avoidPhrases: [], targetWords: null, amounts });
    expect(lint("Invoice INV-2026-27-001 for ₹30,975 (₹26,250 + GST), half of ₹52,500.")).toEqual([]);
    expect(lint("Invoice INV-2026-27-001 for ₹31,000.")).toHaveLength(1);
  });
});

describe("reminders after a partial payment", () => {
  it("chase what is still due: the fee less a paid advance, or the open invoice with its tax", async () => {
    const reminder = (over: Partial<DealDto>) => draft({ purpose: "payment_reminder", now: late(2), deal: { ...deal, ...over } });
    expect((await reminder({ paidMinor: 2_625_000 })).body).toContain("the payment of ₹26,250 for 1 reel + 2 stories");
    const open = { status: "issued", totalMinor: 3_097_500 } as InvoiceDto;
    const paidAdvance = { status: "paid", totalMinor: 3_097_500 } as InvoiceDto;
    const { body, lintViolations } = await reminder({ paidMinor: 2_625_000, invoices: [paidAdvance, open] });
    expect(body).toContain("the payment of ₹30,975 for 1 reel + 2 stories");
    expect(lintViolations).toEqual([]);
    expect(buildDraftPrompt(input({ purpose: "payment_reminder", now: late(2), deal: { ...deal, invoices: [open] } })).user).toContain("Amount due: ₹30,975");
  });
});
