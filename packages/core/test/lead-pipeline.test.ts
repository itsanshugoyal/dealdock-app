import { describe, expect, it } from "vitest";
import { forwardStage, formatEventAmount, parseLeadPayload, pipelineStage, stageCounts, tagLinks, threadIdFromRef, threadRef } from "../src/lead-pipeline";
import { currencyExponent, majorToMinor } from "../src/money";

const NOW = new Date("2026-11-07T06:30:00Z");
const ctx = { now: NOW, orgCurrency: "INR" };
const REF = threadRef("cthread123");

describe("pipeline stages", () => {
  it("puts coaching and course conversations in the pipeline as leads until a stage is set", () => {
    expect(pipelineStage({ topLabel: "coaching_lead" })).toBe("lead");
    expect(pipelineStage({ topLabel: "course_inquiry", leadStage: null })).toBe("lead");
    expect(pipelineStage({ topLabel: "coaching_lead", leadStage: "booked" })).toBe("booked");
    expect(pipelineStage({ topLabel: "brand_deal" })).toBeNull();
    // A tool's report can bring another conversation into the pipeline.
    expect(pipelineStage({ topLabel: "other_commerce", leadStage: "paid" })).toBe("paid");
    expect(stageCounts([{ topLabel: "coaching_lead" }, { topLabel: "course_inquiry", leadStage: "booked" }, { topLabel: "brand_deal" }, { topLabel: "coaching_lead", leadStage: "booked" }]))
      .toEqual({ lead: 1, qualified: 0, booked: 2, paid: 0 });
  });

  it("moves forward on a report, never backwards", () => {
    expect(forwardStage(null, "booked")).toBe("booked");
    expect(forwardStage("lead", "booked")).toBe("booked");
    expect(forwardStage("qualified", "paid")).toBe("paid");
    expect(forwardStage("booked", "booked")).toBeNull();
    expect(forwardStage("paid", "booked")).toBeNull();
  });

  it("reads back only its own references", () => {
    expect(REF).toBe("dd_cthread123");
    expect(threadIdFromRef(REF)).toBe("cthread123");
    expect(threadIdFromRef(" dd_abc ")).toBe("abc");
    for (const value of ["cthread123", "dd_", "dd_a b", "xdd_abc", `dd_${"a".repeat(65)}`, 42, null, undefined]) expect(threadIdFromRef(value)).toBeNull();
  });
});

describe("tagLinks", () => {
  const all = ["calendly", "cal_com", "stripe", "razorpay", "other"] as const;

  it("adds each connected tool's reference parameter", () => {
    expect(tagLinks("Book here: https://calendly.com/diya/intro", REF, all)).toBe("Book here: https://calendly.com/diya/intro?utm_content=dd_cthread123");
    expect(tagLinks("https://cal.com/diya/30min", REF, all)).toBe("https://cal.com/diya/30min?metadata%5Bdd_ref%5D=dd_cthread123");
    expect(tagLinks("Pay at https://buy.stripe.com/test_4gw5kq", REF, all)).toBe("Pay at https://buy.stripe.com/test_4gw5kq?client_reference_id=dd_cthread123");
    expect(tagLinks("https://app.cal.com/diya", REF, ["cal_com"])).toBe("https://app.cal.com/diya?metadata%5Bdd_ref%5D=dd_cthread123");
  });

  it("never breaks a link: existing query, fragment, sentence punctuation, brackets, no scheme", () => {
    expect(tagLinks("https://calendly.com/diya/intro?month=2026-11#top", REF, all)).toBe("https://calendly.com/diya/intro?month=2026-11&utm_content=dd_cthread123#top");
    expect(tagLinks("Grab a slot (https://calendly.com/diya/intro).", REF, all)).toBe("Grab a slot (https://calendly.com/diya/intro?utm_content=dd_cthread123).");
    expect(tagLinks("Slots: https://calendly.com/diya/intro!", REF, all)).toBe("Slots: https://calendly.com/diya/intro?utm_content=dd_cthread123!");
    expect(tagLinks("calendly.com/diya/intro, then pay", REF, all)).toBe("calendly.com/diya/intro?utm_content=dd_cthread123, then pay");
    // A question mark ending the sentence stays after the link.
    expect(tagLinks("Can you pick a slot at https://calendly.com/diya/intro?", REF, all)).toBe("Can you pick a slot at https://calendly.com/diya/intro?utm_content=dd_cthread123?");
    expect(tagLinks("https://calendly.com/diya?a=1&", REF, all)).toBe("https://calendly.com/diya?a=1&utm_content=dd_cthread123");
    expect(tagLinks("Line one\nhttps://buy.stripe.com/abc\nLine three", REF, all)).toBe("Line one\nhttps://buy.stripe.com/abc?client_reference_id=dd_cthread123\nLine three");
    // An email address on a tool's domain is not a link.
    expect(tagLinks("Write to support@calendly.com", REF, all)).toBe("Write to support@calendly.com");
  });

  it("leaves other sites and tools that aren't connected alone", () => {
    const text = "Details: https://diya.example/coaching and https://rzp.io/l/diya and https://calendly.com/diya";
    expect(tagLinks(text, REF, ["razorpay", "other"])).toBe(text);
    expect(tagLinks(text, REF, ["stripe"])).toBe(text);
    expect(tagLinks(text, REF, ["calendly"])).toBe("Details: https://diya.example/coaching and https://rzp.io/l/diya and https://calendly.com/diya?utm_content=dd_cthread123");
    expect(tagLinks("https://notcalendly.com/x https://calendly.com.evil.example/x", REF, all)).toBe("https://notcalendly.com/x https://calendly.com.evil.example/x");
    expect(tagLinks("No links at all.", REF, all)).toBe("No links at all.");
    // Not a reference: nothing is added.
    expect(tagLinks("https://calendly.com/diya", "cthread123", all)).toBe("https://calendly.com/diya");
  });

  it("never tags twice, keeps the creator's own value, and updates a reference copied from another conversation", () => {
    const once = tagLinks("https://calendly.com/diya/intro", REF, all);
    expect(tagLinks(once, REF, all)).toBe(once);
    expect(tagLinks("https://calendly.com/diya?utm_content=bio", REF, all)).toBe("https://calendly.com/diya?utm_content=bio");
    expect(tagLinks("https://calendly.com/diya?utm_source=ig&utm_content=dd_old1&x=1", REF, all)).toBe("https://calendly.com/diya?utm_source=ig&utm_content=dd_cthread123&x=1");
    expect(tagLinks("https://cal.com/diya?metadata[dd_ref]=dd_cthread123", REF, all)).toBe("https://cal.com/diya?metadata[dd_ref]=dd_cthread123");
    expect(tagLinks("https://buy.stripe.com/abc https://buy.stripe.com/abc", REF, all)).toBe("https://buy.stripe.com/abc?client_reference_id=dd_cthread123 https://buy.stripe.com/abc?client_reference_id=dd_cthread123");
  });
});

describe("majorToMinor", () => {
  it("shifts digits exactly, by the currency's precision", () => {
    expect(majorToMinor(4999, "INR")).toBe(499_900);
    expect(majorToMinor(49.99, "USD")).toBe(4_999);
    expect(majorToMinor("0.1", "USD")).toBe(10);
    expect(majorToMinor(1.005, "USD")).toBe(100); // half to even: 100.5 → 100
    expect(majorToMinor(1.015, "USD")).toBe(102); // 101.5 → 102
    expect(majorToMinor(1.0151, "USD")).toBe(102);
    expect(majorToMinor(500, "JPY")).toBe(500);
    expect(majorToMinor(1.2345, "KWD")).toBe(1_234); // 1234.5 → 1234
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("BHD")).toBe(3);
    expect(currencyExponent("INR")).toBe(2);
    expect(majorToMinor(1e-7, "USD")).toBe(0);
  });

  it("refuses negative, malformed or unsafe amounts and bad currency codes", () => {
    for (const [amount, code] of [[-1, "INR"], [Number.NaN, "INR"], [Infinity, "INR"], ["1,000", "INR"], ["1e3", "INR"], ["", "INR"], [10, "inr"], [10, "RUPEES"], [1e17, "INR"]] as const) {
      expect(majorToMinor(amount, code), `${amount} ${code}`).toBeNull();
    }
  });
});

describe("parseLeadPayload", () => {
  it("reads DealDock's own JSON for other tools, in major units", () => {
    expect(parseLeadPayload("other", { event: "paid", id: "pay_1", ref: REF, amount: 4999, name: " Neha  Shah ", at: "2026-11-06T10:00:00Z" }, ctx)).toEqual([
      { kind: "paid", externalId: "pay_1", ref: REF, amountMinor: 499_900, currencyCode: "INR", payerName: "Neha Shah", occurredAt: "2026-11-06T10:00:00.000Z" },
    ]);
    expect(parseLeadPayload("other", { event: "paid", id: 77, amount: "49.5", currency: "usd" }, ctx)).toEqual([
      { kind: "paid", externalId: "77", ref: null, amountMinor: 4_950, currencyCode: "USD", payerName: null, occurredAt: NOW.toISOString() },
    ]);
    // A booking keeps no amount; a payment without one is still a payment.
    expect(parseLeadPayload("other", { event: "booked", id: "b1", amount: 10 }, ctx)?.[0]).toMatchObject({ kind: "booked", amountMinor: null, currencyCode: null });
    expect(parseLeadPayload("other", { event: "paid", id: "p2" }, ctx)?.[0]).toMatchObject({ kind: "paid", amountMinor: null, currencyCode: null });
    // Unknown events are ignored; a body that isn't ours is refused.
    expect(parseLeadPayload("other", { event: "refunded", id: "x" }, ctx)).toEqual([]);
    for (const body of [null, "paid", [], {}, { event: "paid" }, { event: "paid", id: "" }, { event: "paid", id: "x", amount: -5 }, { event: "paid", id: "x", amount: "lots" }, { event: "paid", id: "x", amount: 5, currency: "rupees" }]) {
      expect(parseLeadPayload("other", body, ctx), JSON.stringify(body)).toBeNull();
    }
    // A reference that isn't DealDock's is dropped, not trusted.
    expect(parseLeadPayload("other", { event: "booked", id: "b2", ref: "abc" }, ctx)?.[0]?.ref).toBeNull();
  });

  it("reads a Calendly booking", () => {
    const body = {
      event: "invitee.created",
      created_at: "2026-11-06T09:00:00.000000Z",
      payload: {
        uri: "https://api.calendly.com/scheduled_events/EV1/invitees/INV1",
        name: "Rhea Sharma",
        first_name: "Rhea",
        scheduled_event: { start_time: "2026-11-09T05:30:00.000000Z" },
        tracking: { utm_content: REF, utm_source: null },
      },
    };
    expect(parseLeadPayload("calendly", body, ctx)).toEqual([
      { kind: "booked", externalId: body.payload.uri, ref: REF, amountMinor: null, currencyCode: null, payerName: "Rhea Sharma", occurredAt: "2026-11-09T05:30:00.000Z" },
    ]);
    expect(parseLeadPayload("calendly", { ...body, payload: { ...body.payload, name: undefined, last_name: "Sharma" } }, ctx)?.[0]?.payerName).toBe("Rhea Sharma");
    expect(parseLeadPayload("calendly", { ...body, event: "invitee.canceled" }, ctx)).toEqual([]);
    expect(parseLeadPayload("calendly", { event: "invitee.created", payload: {} }, ctx)).toBeNull();
  });

  it("reads Cal.com bookings and payments", () => {
    const booking = { triggerEvent: "BOOKING_CREATED", createdAt: "2026-11-06T09:00:00Z", payload: { uid: "bk_1", attendees: [{ name: "Arjun Verma" }], metadata: { dd_ref: REF } } };
    expect(parseLeadPayload("cal_com", booking, ctx)).toEqual([{ kind: "booked", externalId: "bk_1", ref: REF, amountMinor: null, currencyCode: null, payerName: "Arjun Verma", occurredAt: "2026-11-06T09:00:00.000Z" }]);
    const payment = { triggerEvent: "BOOKING_PAID", createdAt: "2026-11-06T09:05:00Z", payload: { uid: "bk_1", price: 1000, currency: "usd", paymentId: 42, responses: { name: { value: "Arjun" } } } };
    expect(parseLeadPayload("cal_com", payment, ctx)).toEqual([{ kind: "paid", externalId: "42", ref: null, amountMinor: 1000, currencyCode: "USD", payerName: "Arjun", occurredAt: "2026-11-06T09:05:00.000Z" }]);
    expect(parseLeadPayload("cal_com", { ...payment, payload: { ...payment.payload, paymentId: undefined } }, ctx)?.[0]?.externalId).toBe("bk_1:paid");
    expect(parseLeadPayload("cal_com", { triggerEvent: "BOOKING_CANCELLED", payload: { uid: "bk_1" } }, ctx)).toEqual([]);
    expect(parseLeadPayload("cal_com", { triggerEvent: "BOOKING_CREATED", payload: {} }, ctx)).toBeNull();
  });

  it("reads a Razorpay payment once, however it is reported", () => {
    const entity = { id: "pay_ABC", amount: 499_900, currency: "INR", notes: { name: "Neha S" }, created_at: 1_762_400_000 };
    const captured = { event: "payment.captured", payload: { payment: { entity } } };
    const linkPaid = { event: "payment_link.paid", payload: { payment: { entity }, payment_link: { entity: { customer: { name: "Neha Shah" } } } } };
    expect(parseLeadPayload("razorpay", captured, ctx)).toEqual([{ kind: "paid", externalId: "pay_ABC", ref: null, amountMinor: 499_900, currencyCode: "INR", payerName: "Neha S", occurredAt: new Date(1_762_400_000_000).toISOString() }]);
    expect(parseLeadPayload("razorpay", linkPaid, ctx)?.[0]).toMatchObject({ externalId: "pay_ABC", payerName: "Neha Shah" });
    expect(parseLeadPayload("razorpay", { event: "order.paid", payload: { payment: { entity } } }, ctx)?.[0]?.externalId).toBe("pay_ABC");
    expect(parseLeadPayload("razorpay", { event: "payment.failed", payload: { payment: { entity } } }, ctx)).toEqual([]);
    expect(parseLeadPayload("razorpay", { event: "payment.captured", payload: {} }, ctx)).toBeNull();
  });

  it("reads a paid Stripe checkout and its reference", () => {
    const session = { id: "cs_test_1", payment_status: "paid", client_reference_id: REF, amount_total: 4_900, currency: "usd", customer_details: { name: "Sam Lee" } };
    const body = { type: "checkout.session.completed", created: 1_762_400_000, data: { object: session } };
    expect(parseLeadPayload("stripe", body, ctx)).toEqual([{ kind: "paid", externalId: "cs_test_1", ref: REF, amountMinor: 4_900, currencyCode: "USD", payerName: "Sam Lee", occurredAt: new Date(1_762_400_000_000).toISOString() }]);
    // Paid later by a delayed method: only the success counts.
    expect(parseLeadPayload("stripe", { ...body, data: { object: { ...session, payment_status: "unpaid" } } }, ctx)).toEqual([]);
    expect(parseLeadPayload("stripe", { ...body, type: "checkout.session.async_payment_succeeded" }, ctx)?.[0]?.kind).toBe("paid");
    expect(parseLeadPayload("stripe", { type: "invoice.paid", data: { object: session } }, ctx)).toEqual([]);
  });
});

describe("formatEventAmount", () => {
  it("formats in the payment's own currency", () => {
    expect(formatEventAmount(499_900, "INR")).toBe("₹4,999");
    expect(formatEventAmount(4_950, "USD", "en-US")).toBe("$49.50");
    expect(formatEventAmount(500, "JPY", "en-US")).toBe("¥500");
  });
});
