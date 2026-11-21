import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError, type DealDto } from "@dealdock/core";
import * as db from "@dealdock/db";
import { buildServer } from "../src/index";

// The HTTP layer only: the repositories are stubbed, auth is a creator seat.
vi.mock("@dealdock/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dealdock/db")>()),
  isOrgReadOnly: vi.fn(async () => false),
  createDeal: vi.fn(),
  getDeal: vi.fn(),
  getDraftThreadContext: vi.fn(),
  getCreatorContext: vi.fn(),
  getDraftVoiceContext: vi.fn(),
  getDealConversation: vi.fn(),
  getInvoice: vi.fn(),
  isIgnoredHandle: vi.fn(),
}));
vi.mock("../src/auth", () => ({
  requireAuth: async (req: { auth?: unknown }) => {
    req.auth = { clerkUserId: "user_1", orgId: "org_1", seatId: "seat_1", role: "creator" };
  },
}));

const app = buildServer();
app.log.level = "silent";

const offPlatformDeal = { id: "deal_1", threadId: null, igAccountId: "ig_1", stage: "agreed", invoices: [] } as unknown as DealDto;
const base = { title: "Reel for Glow", dealType: "brand", amountMinor: 5_000_000, idempotencyKey: "deal-key-0123456789" };
const postDeal = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/deals", payload: body });

beforeEach(() => {
  vi.mocked(db.createDeal).mockReset().mockResolvedValue(offPlatformDeal);
});

describe("POST /deals", () => {
  it("records a deal agreed outside DealDock from its creator account and counterparty", async () => {
    const response = await postDeal({ ...base, igAccountId: "ig_1", counterpartyHandle: "  @glowco  " });
    expect(response.statusCode).toBe(200);
    expect(db.createDeal).toHaveBeenCalledWith("org_1", expect.objectContaining({ igAccountId: "ig_1", counterpartyHandle: "@glowco", counterpartyName: null, seatId: "seat_1" }));
    expect(vi.mocked(db.createDeal).mock.calls[0]![1]).not.toHaveProperty("threadId");

    await postDeal({ ...base, igAccountId: "ig_1", counterpartyHandle: "Priya", counterpartyName: " Priya Sharma " });
    expect(db.createDeal).toHaveBeenLastCalledWith("org_1", expect.objectContaining({ counterpartyName: "Priya Sharma" }));
  });

  it("still records a deal from a conversation", async () => {
    expect((await postDeal({ ...base, threadId: "thread_1" })).statusCode).toBe(200);
    expect(db.createDeal).toHaveBeenCalledWith("org_1", expect.objectContaining({ threadId: "thread_1", counterpartyName: null }));
  });

  it("needs a conversation, or a creator account and counterparty, never both", async () => {
    for (const body of [
      base,
      { ...base, igAccountId: "ig_1" },
      { ...base, counterpartyHandle: "@glowco" },
      { ...base, igAccountId: "ig_1", counterpartyHandle: "   " },
      { ...base, igAccountId: "ig_1", counterpartyHandle: "x".repeat(121) },
      { ...base, igAccountId: "ig_1", counterpartyHandle: "@glowco", counterpartyName: "y".repeat(121) },
      { ...base, threadId: "thread_1", igAccountId: "ig_1" },
      { ...base, threadId: "thread_1", counterpartyHandle: "@glowco" },
      { ...base, threadId: "thread_1", counterpartyName: "Priya" },
    ]) {
      const response = await postDeal(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_body" });
    }
    expect(db.createDeal).not.toHaveBeenCalled();
    expect((await postDeal({ ...base, igAccountId: "ig_1", counterpartyHandle: "x".repeat(120) })).statusCode).toBe(200);
  });

  it("answers 404 for another org's account and 400 for an email inbox", async () => {
    vi.mocked(db.createDeal).mockRejectedValueOnce(new DomainError("ig_account_not_in_org", 404));
    const foreign = await postDeal({ ...base, igAccountId: "ig_foreign", counterpartyHandle: "@glowco" });
    expect([foreign.statusCode, foreign.json()]).toEqual([404, { error: "not_found" }]);

    vi.mocked(db.createDeal).mockRejectedValueOnce(new DomainError("creator_account_required", 400));
    const inbox = await postDeal({ ...base, igAccountId: "inbox_1", counterpartyHandle: "@glowco" });
    expect([inbox.statusCode, inbox.json()]).toEqual([400, { error: "creator_account_required" }]);
  });
});

describe("drafts that need the deal's conversation", () => {
  beforeEach(() => {
    vi.mocked(db.getDraftThreadContext).mockResolvedValue({
      id: "thread_1",
      igAccountId: "ig_1",
      participantHandle: "glowco",
      topLabel: "brand_deal",
      channel: "instagram",
      subject: null,
      messages: [],
      latestInbound: null,
      liveDraft: null,
    });
    vi.mocked(db.getCreatorContext).mockResolvedValue({ voiceEnabled: true } as never);
    vi.mocked(db.getDraftVoiceContext).mockResolvedValue({} as never);
    vi.mocked(db.getDealConversation).mockResolvedValue(null);
    vi.mocked(db.isIgnoredHandle).mockResolvedValue(false);
    vi.mocked(db.getInvoice).mockResolvedValue({ id: "inv_1", dealId: "deal_1", status: "issued" } as never);
    vi.mocked(db.getDeal).mockResolvedValue(offPlatformDeal);
  });

  it("refuses a recap, a payment reminder or an invoice cover note for a deal agreed outside DealDock", async () => {
    for (const payload of [
      { purpose: "recap", dealId: "deal_1" },
      { purpose: "payment_reminder", dealId: "deal_1" },
      { purpose: "invoice", dealId: "deal_1", invoiceId: "inv_1" },
    ]) {
      const response = await app.inject({ method: "POST", url: "/threads/thread_1/draft", payload });
      expect([response.statusCode, response.json()]).toEqual([409, { error: "deal_has_no_conversation" }]);
    }
  });

  it("keeps a deal from another conversation a 404", async () => {
    vi.mocked(db.getDeal).mockResolvedValue({ ...offPlatformDeal, threadId: "thread_2" });
    const response = await app.inject({ method: "POST", url: "/threads/thread_1/draft", payload: { purpose: "recap", dealId: "deal_1" } });
    expect(response.statusCode).toBe(404);
  });
});
