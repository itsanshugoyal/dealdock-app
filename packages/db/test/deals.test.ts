import { describe, expect, it, vi } from "vitest";

// No database client is ever constructed: tests that need one fill in this stand-in.
const prisma = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("../src/client", () => ({ prisma }));
import { channelOf, createDeal, creatorAccountId, paymentOf, stageChange, threadsOfCreator } from "../src/repos/deals";
import { asOrgId } from "../src/org-id";

const now = new Date("2026-11-04T10:00:00Z");
const DAY = 86_400_000;

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { status?: number }).status;
  }
  return undefined;
}

describe("deal stage moves", () => {
  it("invoicing stamps the request and dates payment from the agreed days when no due date is set", () => {
    expect(stageChange({ stage: "agreed", dueAt: null }, "invoiced", 30, now)).toEqual({
      stage: "invoiced",
      invoicedAt: now,
      dueAt: new Date(now.getTime() + 30 * DAY),
    });
    const due = new Date("2026-12-01T00:00:00Z");
    expect(stageChange({ stage: "agreed", dueAt: due }, "invoiced", 30, now)).toEqual({ stage: "invoiced", invoicedAt: now });
    expect(stageChange({ stage: "agreed", dueAt: null }, "invoiced", null, now)).toEqual({ stage: "invoiced", invoicedAt: now });
  });

  it("back to agreed clears the invoiced stamp; cancel and reopen are allowed", () => {
    expect(stageChange({ stage: "invoiced", dueAt: null }, "agreed", 30, now)).toEqual({ stage: "agreed", invoicedAt: null });
    expect(stageChange({ stage: "invoiced", dueAt: null }, "cancelled", null, now)).toEqual({ stage: "cancelled" });
    expect(stageChange({ stage: "agreed", dueAt: null }, "cancelled", null, now)).toEqual({ stage: "cancelled" });
    expect(stageChange({ stage: "cancelled", dueAt: null }, "agreed", null, now)).toEqual({ stage: "agreed", invoicedAt: null });
  });

  it("no move is a no-op, and paid is never entered or left here", () => {
    expect(stageChange({ stage: "paid", dueAt: null }, undefined, null, now)).toEqual({});
    expect(stageChange({ stage: "invoiced", dueAt: null }, "invoiced", 30, now)).toEqual({});
    expect(statusOf(() => stageChange({ stage: "agreed", dueAt: null }, "paid", null, now))).toBe(409);
    expect(statusOf(() => stageChange({ stage: "paid", dueAt: null }, "agreed", null, now))).toBe(409);
    expect(statusOf(() => stageChange({ stage: "cancelled", dueAt: null }, "invoiced", null, now))).toBe(409);
  });
});

describe("deal payment", () => {
  it("defaults what arrived to the fee less TDS, and Revenue records the gross", () => {
    expect(paymentOf(5_000_000, { tdsMinor: 500_000 }, now)).toEqual({
      paidAt: now,
      receivedMinor: 4_500_000,
      tdsMinor: 500_000,
      revenueMinor: 5_000_000n,
    });
    expect(paymentOf(200_000, {}, now)).toMatchObject({ receivedMinor: 200_000, tdsMinor: null, revenueMinor: 200_000n });
  });

  it("records a short payment as what actually arrived, on the given date", () => {
    expect(paymentOf(5_000_000, { receivedMinor: 4_000_000, tdsMinor: 0, paidAt: "2026-10-30T12:00:00+05:30" }, now)).toEqual({
      paidAt: new Date("2026-10-30T06:30:00Z"),
      receivedMinor: 4_000_000,
      tdsMinor: 0,
      revenueMinor: 4_000_000n,
    });
  });

  it("pays an invoice's total less TDS by default, and counts the fee without its GST", () => {
    // ₹26,250 + 18% GST = ₹30,975; TDS ₹2,625 on the fee.
    expect(paymentOf(3_097_500, { tdsMinor: 262_500 }, now, 472_500)).toEqual({
      paidAt: now,
      receivedMinor: 2_835_000,
      tdsMinor: 262_500,
      revenueMinor: 2_625_000n,
    });
    expect(statusOf(() => paymentOf(3_097_500, { receivedMinor: 400_000 }, now, 472_500))).toBe(400);
  });

  it("rejects negative, fractional and unsafe amounts, and a payment that adds nothing to Revenue", () => {
    expect(statusOf(() => paymentOf(100, { tdsMinor: -1 }, now))).toBe(400);
    expect(statusOf(() => paymentOf(100, { receivedMinor: 1.5 }, now))).toBe(400);
    expect(statusOf(() => paymentOf(100, { receivedMinor: Number.MAX_SAFE_INTEGER, tdsMinor: 1 }, now))).toBe(400);
    expect(statusOf(() => paymentOf(100, { receivedMinor: 0 }, now))).toBe(400);
  });
});

describe("creator attribution", () => {
  it("email threads are their own channel and count for the inbox's owner", () => {
    expect(channelOf("email")).toBe("email");
    expect(channelOf("instagram")).toBe("instagram");
    expect(channelOf("whatsapp")).toBe("instagram");
    expect(creatorAccountId({ igAccountId: "inbox", igAccount: { ownerAccountId: "creator" } })).toBe("creator");
    expect(creatorAccountId({ igAccountId: "ig", igAccount: { ownerAccountId: null } })).toBe("ig");
    expect(threadsOfCreator("creator")).toEqual({ OR: [{ igAccountId: "creator" }, { igAccount: { ownerAccountId: "creator" } }] });
  });
});

describe("recording a deal agreed outside DealDock", () => {
  type Account = { id: string; platform: string; ownerAccountId: string | null };
  const creator: Account = { id: "ig_1", platform: "instagram", ownerAccountId: null };
  const input = { seatId: "seat_1", igAccountId: "ig_1", counterpartyHandle: " @glowco ", title: "Reel", dealType: "brand" as const, amountMinor: 5_000_000, idempotencyKey: "deal-key-0123456789" };

  /** A transaction that finds `account` and writes one deal row. */
  function fakeDb(account: Account | null) {
    const row = {
      id: "deal_1", threadId: null, igAccountId: "ig_1", counterpartyHandle: "@glowco", counterpartyName: null, title: "Reel", dealType: "brand",
      amountMinor: 5_000_000n, currencyCode: "INR", stage: "agreed", terms: {}, agreedAt: now, dueAt: null, invoicedAt: null, paidAt: null,
      receivedMinor: null, tdsMinor: null, idempotencyKey: input.idempotencyKey, createdAt: now, updatedAt: now, thread: null, invoices: [], ledgerEntries: [],
      usageHandledAt: null, renewalHandledAt: null,
    };
    const tx = {
      thread: { findFirst: vi.fn(), update: vi.fn() },
      igAccount: { findFirst: vi.fn(async () => account) },
      organization: { findUnique: vi.fn(async () => ({ currencyCode: "INR" })) },
      deal: { createMany: vi.fn(async () => ({ count: 1 })), findUniqueOrThrow: vi.fn(async () => row) },
      auditLog: { create: vi.fn(async () => ({})) },
    };
    Object.assign(prisma, { seat: { findFirst: async () => ({ id: "seat_1", role: "creator" }) }, $transaction: (run: (client: typeof tx) => unknown) => run(tx) });
    return tx;
  }

  it("stores the creator account and counterparty, and never looks up or closes a thread", async () => {
    const tx = fakeDb(creator);
    expect(await createDeal(asOrgId("org_1"), input)).toMatchObject({ threadId: null, channel: null, igAccountId: "ig_1", counterpartyHandle: "@glowco" });
    expect(tx.igAccount.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "ig_1", orgId: "org_1" } }));
    expect(tx.deal.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({ threadId: null, igAccountId: "ig_1", counterpartyHandle: "@glowco", counterpartyName: null })] }));
    expect(tx.thread.findFirst).not.toHaveBeenCalled();
    expect(tx.thread.update).not.toHaveBeenCalled();
  });

  it("refuses an email inbox, an account outside the org, and a missing creator or counterparty, before writing", async () => {
    const cases: Array<[Account | null, Partial<typeof input>, string]> = [
      [{ id: "inbox_1", platform: "email", ownerAccountId: "ig_1" }, {}, "creator_account_required"],
      [{ id: "inbox_2", platform: "email", ownerAccountId: null }, {}, "creator_account_required"],
      [null, {}, "ig_account_not_in_org"],
      [creator, { igAccountId: undefined }, "ig_account_required"],
      [creator, { counterpartyHandle: "  " }, "counterparty_required"],
    ];
    for (const [account, change, code] of cases) {
      const tx = fakeDb(account);
      await expect(createDeal(asOrgId("org_1"), { ...input, ...change }), code).rejects.toMatchObject({ code });
      expect(tx.deal.createMany).not.toHaveBeenCalled();
      expect(tx.thread.findFirst).not.toHaveBeenCalled();
    }
    // With no account id there is nothing to look up: `{ id: undefined }` would match any account.
    const tx = fakeDb(creator);
    await expect(createDeal(asOrgId("org_1"), { ...input, igAccountId: undefined })).rejects.toMatchObject({ code: "ig_account_required" });
    expect(tx.igAccount.findFirst).not.toHaveBeenCalled();
  });
});
