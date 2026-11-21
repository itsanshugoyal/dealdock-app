import { describe, expect, it } from "vitest";
import { isAuditAction, pipelineStage, stageCounts } from "@dealdock/core";
import { fromInboxRow, fromThreadDetail, inboxRowFromDetail } from "../src/lib/api-store";
import { DEMO_ACCOUNT_ID } from "../src/lib/demo-data";
import { demoStore } from "../src/lib/demo-store";
import { inboxSearch } from "../src/lib/inbox-navigation";

const DAY = 86_400_000;
const snapshot = () => demoStore.getSnapshot();
const row = (id: string) => snapshot().threads.find((thread) => thread.id === id);
const lastAudit = async () => (await demoStore.loadAudit(5))?.[0]?.action;

describe("renewal prompts in the demo", () => {
  it("suggests pitching a brand that paid months ago, drafts the pitch in its conversation and goes on Not now", { timeout: 20_000 }, async () => {
    await demoStore.init();
    const renewals = (await demoStore.loadRenewals()) ?? [];
    const urbanroots = renewals.find((item) => item.deal.counterpartyHandle === "urbanroots.in");
    expect(urbanroots?.deal).toMatchObject({ id: "deal-urbanroots", stage: "paid", dealType: "brand", amountMinor: 60_000_00, renewalHandledAt: null });
    // GlowTonic paid this month and TeaLeaf has an open deal: neither is due.
    expect(renewals.map((item) => item.deal.counterpartyHandle)).not.toContain("glowtonic.in");
    expect(renewals.map((item) => item.deal.counterpartyHandle)).not.toContain("tealeaf.co");

    const threadId = urbanroots!.deal.threadId!;
    const draft = await demoStore.generateDraft(threadId, { purpose: "renewal", dealId: "deal-urbanroots" });
    expect(draft).toMatchObject({ purpose: "renewal", dealId: "deal-urbanroots", kind: "nudge" });
    expect(draft.body).toContain("Loved working with you on");
    // The creator's brand offer, exactly; never the old fee.
    expect(draft.body).toContain("₹60,000–₹90,000");
    expect(draft.body).not.toMatch(/₹60,000\b(?!–)/);
    // Only a paid deal is pitched again.
    await expect(demoStore.generateDraft("t-founders", { purpose: "renewal", dealId: "deal-founders" })).rejects.toMatchObject({ status: 409 });

    await demoStore.handleRenewal("deal-urbanroots", "not_now");
    expect((await demoStore.loadRenewals())?.some((item) => item.deal.id === "deal-urbanroots")).toBe(false);
    expect(await lastAudit()).toBe("deal.renewal_dismissed");
  });

  it("marks a renewal handled when its pitch is sent", { timeout: 20_000 }, async () => {
    // An email conversation has no reply window, so the pitch can go from DealDock.
    await demoStore.loadThread("e-lumen");
    const deal = await demoStore.createDeal({ threadId: "e-lumen", title: "Autumn serum reel", dealType: "brand", amountMinor: 1_20_000_00, paid: { paidAt: new Date(Date.now() - 80 * DAY).toISOString() }, idempotencyKey: "renewal-sent-test-0001" });
    expect((await demoStore.loadRenewals())?.some((item) => item.deal.id === deal.id)).toBe(true);
    const draft = await demoStore.generateDraft("e-lumen", { purpose: "renewal", dealId: deal.id });
    await demoStore.send("e-lumen", draft.body);
    expect((await demoStore.loadRenewals())?.some((item) => item.deal.id === deal.id)).toBe(false);
  });

  it("writes a pitch to copy for a paid deal agreed outside DealDock", { timeout: 20_000 }, async () => {
    const deal = await demoStore.createDeal({ igAccountId: DEMO_ACCOUNT_ID, counterpartyHandle: "Café Kinship", title: "Launch reel", dealType: "brand", amountMinor: 40_000_00, paid: { paidAt: new Date(Date.now() - 70 * DAY).toISOString() }, idempotencyKey: "renewal-copy-test-0001" });
    expect((await demoStore.loadRenewals())?.some((item) => item.deal.id === deal.id)).toBe(true);
    const text = await demoStore.draftForDeal(deal.id);
    expect(text).toContain("Launch reel");
    await expect(demoStore.draftForDeal("deal-glowtonic")).rejects.toMatchObject({ code: "deal_has_conversation" });
    await demoStore.handleRenewal(deal.id, "copied");
    expect((await demoStore.loadRenewals())?.some((item) => item.deal.id === deal.id)).toBe(false);
    expect(await lastAudit()).toBe("deal.renewal_copied");
  });
});

describe("the coach pipeline in the demo", () => {
  it("seeds stages, a matched payment and an unmatched one, and counts the pipeline like Today", async () => {
    await demoStore.init();
    expect([row("t-sana")?.leadStage, row("t-karan")?.leadStage, row("e-neha")?.leadStage, row("t-rhea")?.leadStage]).toEqual(["paid", "booked", "qualified", null]);
    expect(pipelineStage(row("t-rhea")!)).toBe("lead");
    const open = snapshot().threads.filter((thread) => thread.routedTo === "inbox" && thread.state !== "closed");
    expect(stageCounts(open)).toMatchObject({ qualified: 1, booked: 1, paid: 1 });
    const sana = await demoStore.loadThread("t-sana");
    expect(sana?.leadPayments).toEqual([expect.objectContaining({ id: "lead-sana", provider: "razorpay", kind: "paid", amountMinor: 24_000_00, currencyCode: "INR", payerName: "Sana Qureshi" })]);
    // Rows carry the stage, never the payments.
    expect(row("t-sana")).toMatchObject({ leadStage: "paid", leadPayments: undefined });
    const tools = await demoStore.loadLeadSources();
    expect(tools?.sources.map((source) => source.provider)).toEqual(["razorpay", "calendly"]);
    expect(tools?.unmatched).toEqual([expect.objectContaining({ id: "lead-kavya", threadId: null, payerName: "Kavya M" })]);
  });

  it("sets any stage by hand", async () => {
    await demoStore.setLeadStage("t-arjun", "qualified");
    expect(row("t-arjun")?.leadStage).toBe("qualified");
    await demoStore.setLeadStage("t-arjun", "lead");
    expect(row("t-arjun")?.leadStage).toBe("lead");
    expect(await lastAudit()).toBe("thread.lead_stage_changed");
  });

  it("records a reported payment as the sale and handles it", { timeout: 20_000 }, async () => {
    await demoStore.createDeal({ threadId: "t-sana", title: "12-week coaching", dealType: "coaching", amountMinor: 24_000_00, paid: {}, idempotencyKey: "pipeline-record-0001", leadEventId: "lead-sana" });
    expect((await demoStore.loadThread("t-sana"))?.leadPayments).toEqual([]);
    expect(snapshot().ledger.some((entry) => entry.handle === "sana.moves" && entry.amountMinor === 24_000_00)).toBe(true);
  });

  it("matches an unmatched payment, moving the stage only forward, and dismisses", async () => {
    await demoStore.matchLeadEvent("lead-kavya", "t-meera");
    expect(row("t-meera")?.leadStage).toBe("paid");
    expect((await demoStore.loadLeadSources())?.unmatched).toEqual([]);
    expect((await demoStore.loadThread("t-meera"))?.leadPayments?.map((event) => event.id)).toEqual(["lead-kavya"]);
    await expect(demoStore.matchLeadEvent("lead-kavya", "t-priya")).rejects.toMatchObject({ code: "lead_event_already_matched" });
    await demoStore.dismissLeadEvent("lead-kavya");
    expect((await demoStore.loadThread("t-meera"))?.leadPayments).toEqual([]);
    expect(await lastAudit()).toBe("lead_event.dismissed");
  });

  it("connects tools, shows the address once, waits for Stripe's secret and removes a tool with what it reported", { timeout: 20_000 }, async () => {
    const other = await demoStore.connectLeadSource({ provider: "other" });
    expect(other.address).toMatch(/^https:\/\/[^/]+\/webhooks\/leads\/[A-Za-z0-9_-]{43}$/);
    const calendly = await demoStore.connectLeadSource({ provider: "calendly", accessKey: "calendly-personal-key-0123456789" });
    expect(calendly.address).toBeNull();
    await expect(demoStore.connectLeadSource({ provider: "calendly" })).rejects.toMatchObject({ status: 400 });
    await expect(demoStore.connectLeadSource({ provider: "other", secret: "something-secret" })).rejects.toMatchObject({ status: 400 });
    const stripe = await demoStore.connectLeadSource({ provider: "stripe" });
    expect(stripe.source.needsSecret).toBe(true);
    await demoStore.saveLeadSourceSecret(stripe.source.id, "whsec_demo_secret");
    expect((await demoStore.loadLeadSources())?.sources.find((source) => source.id === stripe.source.id)?.needsSecret).toBe(false);
    await demoStore.removeLeadSource("src-calendly");
    const after = await demoStore.loadLeadSources();
    expect(after?.sources.some((source) => source.id === "src-calendly")).toBe(false);
    expect(await lastAudit()).toBe("lead_source.removed");
  });

  it("names every action it records the way the API does", async () => {
    for (const row of (await demoStore.loadAudit(40)) ?? []) expect(isAuditAction(row.action), row.action).toBe(true);
  });
});

describe("pipeline fields from the API", () => {
  it("keeps the stage on rows and details, and the payments on details, defaulting for older APIs", () => {
    const iso = new Date().toISOString();
    const window = { status: "open" as const, lastInboundAt: iso, standardClosesAt: iso, extendedClosesAt: null, humanAgentEnabled: false };
    const participant = { handle: "rhea.runs", name: "Rhea", avatarUrl: null, followerCount: null, verified: null, followsYou: null, closedTotalMinor: 0, closedDeals: 0, fetchedAt: null };
    const detail = {
      id: "t1", igAccountId: "ig1", participantHandle: "rhea.runs", participant, state: "open" as const, waitingSince: null, nudgeDue: false, topLabel: "coaching_lead" as const,
      estValueMinMinor: null, estValueMaxMinor: null, estCurrencyCode: null, rationale: null, lastInboundAt: iso, replyWindow: window, source: null, messages: [], sendInFlight: false,
      currentDraft: null, closedDeals: [], dealSignal: null, canSendVoice: false, channel: "instagram" as const, subject: null, scamReason: null, deals: [],
      leadStage: "booked" as const, leadPayments: [{ id: "e1", sourceId: "s1", provider: "razorpay" as const, kind: "paid" as const, threadId: "t1", amountMinor: 100, currencyCode: "INR", payerName: null, occurredAt: iso }],
    };
    expect(fromThreadDetail(detail)).toMatchObject({ leadStage: "booked", leadPayments: [{ id: "e1" }] });
    expect(inboxRowFromDetail(detail).leadStage).toBe("booked");
    const { leadStage: _stage, leadPayments: _payments, ...older } = detail;
    expect(fromThreadDetail(older)).toMatchObject({ leadStage: null, leadPayments: [] });
    expect(fromInboxRow({ ...inboxRowFromDetail(older), leadStage: undefined }).leadStage).toBeNull();
  });

  it("carries the stage list through a conversation and back", () => {
    expect(inboxSearch(new URLSearchParams("stage=booked&account=ig1"))).toBe("?account=ig1&stage=booked");
    expect(inboxSearch(new URLSearchParams("stage=won"))).toBe("");
  });
});
