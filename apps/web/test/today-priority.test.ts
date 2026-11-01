import { describe, expect, it } from "vitest";
import { computeReplyWindow } from "@dealdock/core";
import { nextReply } from "../src/lib/today-priority";
import { conversationHref, inboxHref, inboxView } from "../src/lib/inbox-navigation";
import type { DemoThread } from "../src/lib/types";

const now = Date.parse("2026-11-01T06:00:00Z");
const hour = 3_600_000;
const accounts = [{ id: "creator-a", status: "active" }, { id: "creator-b", status: "token_expired" }];
function thread(id: string, hoursLeft: number, amount: number, patch: Partial<DemoThread> = {}): DemoThread {
  return {
    id, igAccountId: "creator-a", state: "open", routedTo: "inbox", topLabel: "brand_deal", unreplied: true,
    estValueMaxMinor: amount, lastMessageAt: now - hour, sendInFlight: false,
    replyWindow: computeReplyWindow(new Date(now - (24 - hoursLeft) * hour), new Date(now), false),
    ...patch,
  } as DemoThread;
}

describe("next human reply", () => {
  it("prioritizes a real closing window, then money when deadlines tie", () => {
    const biggest = thread("biggest", 20, 2_500_000);
    const soon = thread("soon", 0.5, 500_000);
    const soonerAndBigger = thread("soon-big", 0.5, 600_000);
    const result = nextReply([biggest, soon, soonerAndBigger], accounts, now);
    expect(result?.thread.id).toBe("soon-big");
    expect(result?.reason).toBe("closing_soon");
  });
  it("falls back to the highest value actionable conversation", () => {
    expect(nextReply([thread("small", 12, 10_000), thread("big", 18, 90_000)], accounts, now)?.thread.id).toBe("big");
  });
  it("does not recommend expired, unknown, disconnected, claimed or unreviewed sends", () => {
    const expired = thread("expired", -1, 99_000_000);
    const unknown = thread("unknown", 1, 99_000_000, { replyWindow: computeReplyWindow(null, new Date(now), false) });
    const disconnected = thread("disconnected", 0.1, 99_000_000, { igAccountId: "creator-b" });
    const claimed = thread("claimed", 0.1, 99_000_000, { sendInFlight: true });
    const review = thread("review", 0.1, 99_000_000, { routedTo: "review_queue" });
    const actionable = thread("ready", 10, 10_000);
    expect(nextReply([expired, unknown, disconnected, claimed, review, actionable], accounts, now)?.thread.id).toBe("ready");
    expect(nextReply([expired, unknown, disconnected, claimed, review], accounts, now)).toBeNull();
  });
  it("rechecks time instead of trusting a stale open status", () => {
    expect(nextReply([thread("aged", 1, 100_000)], accounts, now + 2 * hour)).toBeNull();
  });
  it("waits for a verified connection status before recommending a reply", () => {
    expect(nextReply([thread("not-loaded", 1, 100_000)], [], now)).toBeNull();
    expect(nextReply([thread("unknown-account", 1, 100_000, { igAccountId: "not-in-settings" })], accounts, now)).toBeNull();
  });
});

describe("queue navigation", () => {
  it("retains creator, view and search when opening and leaving a conversation", () => {
    const params = new URLSearchParams({ account: "creator a", view: "waiting", q: "brief & budget" });
    const target = new URL(conversationHref("thread/id", params), "http://localhost");
    expect(target.pathname).toBe("/thread/thread%2Fid");
    expect(Object.fromEntries(target.searchParams)).toEqual(Object.fromEntries(params));
    expect(inboxHref(target.searchParams)).toBe(`/inbox${target.search}`);
  });
  it("falls back for invalid views and never accepts a return redirect", () => {
    expect(inboxView("not-a-view")).toBe("needs");
    expect(inboxHref(new URLSearchParams("view=not-a-view&returnTo=https://example.test"))).toBe("/inbox");
  });
});
