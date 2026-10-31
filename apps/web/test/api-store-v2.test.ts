import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboxRow, ParticipantProfile, ReplyWindow, ReviewQueueRow, ThreadDetail } from "@dealdock/core";
import { ApiStore, fromInboxRow, fromReviewRow, fromThreadDetail, inboxRowFromDetail } from "../src/lib/api-store";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const person = (handle: string): ParticipantProfile => ({ handle, name: null, avatarUrl: null, followerCount: null, verified: null, followsYou: null, closedTotalMinor: 0, closedDeals: 0, fetchedAt: null });
const open = (lastInboundAt: string): ReplyWindow => ({ status: "open", lastInboundAt, standardClosesAt: null, extendedClosesAt: null, humanAgentEnabled: false });

function inboxRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    threadId: "t1", igAccountId: "ig-1", participantHandle: "brand", participant: person("brand"), state: "open",
    lastMessageAt: iso(60_000), lastInboundAt: iso(60_000), topLabel: "brand_deal", estValueMinMinor: 50_00, estValueMaxMinor: 100_00, estCurrencyCode: "INR",
    preview: "Rates?", previewOutbound: false, messageCount: 1, unreplied: true, waitingSince: null, nudgeDue: false, draftReady: false, hasAudio: false,
    dealSignal: false, source: "dm", replyWindow: open(iso(60_000)), ...overrides,
  };
}
function threadDetail(overrides: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    id: "t1", igAccountId: "ig-1", participantHandle: "brand", participant: person("brand"), state: "open", waitingSince: null, nudgeDue: false,
    topLabel: "brand_deal", estValueMinMinor: 50_00, estValueMaxMinor: 100_00, estCurrencyCode: "INR", rationale: "Asks for rates.",
    lastInboundAt: iso(60_000), replyWindow: open(iso(60_000)), source: "dm",
    messages: [{ id: "m1", direction: "inbound", contentType: "text", text: "Rates?", sentAt: iso(60_000), origin: null, audio: null, classification: null }],
    sendInFlight: false, currentDraft: null, closedDeals: [], dealSignal: null, canSendVoice: false, ...overrides,
  };
}
const reviewRow = (overrides: Partial<ReviewQueueRow> = {}): ReviewQueueRow => ({
  classificationId: "c1", threadId: "r1", igAccountId: "ig-1", handle: "maybe", text: "We should talk sometime.", sentAt: iso(120_000), bestGuess: "uncertain", confidence: 0.4, rationale: "Vague opener.", ...overrides,
});
const draft = { id: "d1", body: "Heyy!", kind: "reply" as const, status: "ready" as const, version: 1, label: "brand_deal" as const, instruction: null, chips: [], alternatives: [], chosenAlternative: null, context: null };

const core = (path: string): unknown =>
  path === "/dashboard" ? { org: { currencyCode: "INR", locale: "en-IN", name: "Studio" }, mtdRecoveredMinor: 0, biggestMinor: 0, avgMinor: 0, mtdDealCount: 0 }
  : path === "/ledger" ? { entries: [], months: [], selectedMonth: "2026-10", timezone: "Asia/Kolkata" }
  : path === "/onboarding" ? { complete: true, timezone: "Asia/Kolkata" }
  : path.startsWith("/insights") ? { goal: { monthlyGoalMinor: null, mtdMinor: 0, pct: null, projectedMinor: null }, months: [] }
  : { rows: [] };
const pathOf = (url: string) => new URL(url).pathname;
const tenantOf = (init: RequestInit) => new Headers(init.headers).get("Authorization")!.slice(7);

function online() {
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.test");
}

/** A fake API: "METHOD /path?query" handlers, everything else answered by `core`. Records every call. */
function serve(handlers: Record<string, (init: RequestInit) => unknown>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const { pathname, search } = new URL(url);
    const key = `${init.method ?? "GET"} ${pathname}${search}`;
    calls.push(key);
    const handler = handlers[key];
    return Response.json(await (handler ? handler(init) : core(`${pathname}${search}`)));
  }));
  return calls;
}
async function signedIn() {
  const store = new ApiStore();
  store.authenticate("actor", async () => "actor");
  await vi.waitFor(() => expect(store.getSnapshot().state).toBe("ready"));
  return store;
}

describe("contract mapping", () => {
  it("maps an inbox row with its account and whose words the preview is", () => {
    const row = fromInboxRow(inboxRow({ preview: "Sending the brief now.", previewOutbound: true, unreplied: false, dealSignal: true }));
    expect(row).toMatchObject({ id: "t1", igAccountId: "ig-1", handle: "brand", routedTo: "inbox", detail: false, draft: null, dealSignal: null, hasDealSignal: true, previewOutbound: true, unreplied: false, estValueMaxMinor: 100_00 });
    expect(row.messages).toEqual([expect.objectContaining({ direction: "outbound", text: "Sending the brief now.", contentType: "text" })]);
    expect(fromInboxRow(inboxRow({ preview: "", hasAudio: true })).messages).toEqual([]);
  });

  it("maps a review item to one inbound message carrying the best guess", () => {
    const row = fromReviewRow(reviewRow());
    expect(row).toMatchObject({ id: "r1", routedTo: "review_queue", classificationId: "c1", topLabel: "uncertain", rationale: "Vague opener.", preview: "We should talk sometime.", igAccountId: "ig-1", unreplied: false });
    expect(row.messages[0]?.classification).toMatchObject({ id: "c1", label: "uncertain", confidence: 0.4, rationale: "Vague opener." });
    expect(row.replyWindow.status).toBe("unknown");
    expect(fromReviewRow(reviewRow({ igAccountId: "ig-2" })).igAccountId).toBe("ig-2");
  });

  it("maps a thread detail with its history, live draft and deal facts", () => {
    const thread = fromThreadDetail(threadDetail({
      currentDraft: draft, sendInFlight: true, canSendVoice: true,
      closedDeals: [{ id: "l1", amountMinor: 500_00, currencyCode: "INR", dealType: "brand", note: null, closedAt: iso(0) }],
      dealSignal: { messageId: "m0", phrase: "payment done", suggestedAmountMinor: null, suggestedDealType: "brand" },
      messages: [{ id: "m1", direction: "inbound", contentType: "text", text: "Rates?", sentAt: iso(60_000), origin: null, audio: null, classification: { id: "c1", label: "brand_deal", confidence: 0.9, rationale: null, valueMinMinor: null, valueMaxMinor: null, reviewedAt: null } }],
    }));
    expect(thread).toMatchObject({ id: "t1", igAccountId: "ig-1", detail: true, draft, draftReady: true, sendInFlight: true, canSendVoice: true, hasDealSignal: true, rationale: "Asks for rates." });
    expect(thread.messages[0]).toMatchObject({ id: "m1", contentType: "text", origin: null, audio: null, classification: { id: "c1", label: "brand_deal" } });
    expect(thread.closedDeals[0]).toMatchObject({ id: "l1", amountMinor: 500_00 });
  });

  it("derives the row GET /inbox would list from a detail, by the inbox repository's rules", () => {
    const audio = { url: null, mimeType: "audio/ogg", durationMs: 4_000, transcript: "Kitna lagega?", transcriptLanguage: "hinglish", status: "ready" as const };
    const row = inboxRowFromDetail(threadDetail({
      currentDraft: draft,
      messages: [
        { id: "m1", direction: "inbound", contentType: "text", text: "Payment's done!", sentAt: iso(300_000), origin: null, audio: null, classification: null },
        { id: "m2", direction: "inbound", contentType: "audio", text: "", sentAt: iso(60_000), origin: null, audio, classification: null },
      ],
      lastInboundAt: iso(60_000),
      // A closing phrase in an older message: the list only reads the latest inbound one.
      dealSignal: { messageId: "m1", phrase: "Payment's done", suggestedAmountMinor: null, suggestedDealType: "brand" },
    }));
    expect(row).toMatchObject({ threadId: "t1", igAccountId: "ig-1", preview: "Kitna lagega?", previewOutbound: false, unreplied: true, messageCount: 2, draftReady: true, hasAudio: true, dealSignal: false });
    const replied = inboxRowFromDetail(threadDetail({
      messages: [
        { id: "m1", direction: "inbound", contentType: "text", text: "Rates?", sentAt: iso(60_000), origin: null, audio: null, classification: null },
        { id: "m2", direction: "outbound", contentType: "text", text: "Heyy! Sending them now.", sentAt: iso(1_000), origin: "dealdock", audio: null, classification: null },
      ],
    }));
    expect(replied).toMatchObject({ preview: "Heyy! Sending them now.", previewOutbound: true, unreplied: false, draftReady: false });
  });
});

describe("v2 store invariants", () => {
  it("clears lazy slices on an account switch and never publishes a late old-tenant slice", async () => {
    online();
    let releaseOld: (() => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      const path = pathOf(url);
      const tenant = tenantOf(init);
      if (path === "/insights" && tenant === "old") {
        return new Promise<Response>((resolve) => { releaseOld = () => resolve(Response.json({ goal: { mtdMinor: 1 }, months: [] })); });
      }
      return Promise.resolve(Response.json(path === "/insights" ? { goal: { mtdMinor: 2 }, months: [] } : core(path)));
    }));
    const store = new ApiStore();
    store.authenticate("old", async () => "old");
    await vi.waitFor(() => expect(store.getSnapshot().state).toBe("ready"));
    const pending = store.loadInsights(6);
    await vi.waitFor(() => expect(releaseOld).toBeDefined());
    expect(store.getSnapshot().insights.status).toBe("loading");

    store.authenticate("new", async () => "new");
    expect(store.getSnapshot().insights.status).toBe("idle");
    expect(store.getSnapshot().epoch).toBe(2);
    releaseOld!();
    await expect(pending).resolves.toBeNull();
    expect(store.getSnapshot().insights.data).toBeNull();

    await vi.waitFor(() => expect(store.getSnapshot().state).toBe("ready"));
    await store.loadInsights(6);
    expect(store.getSnapshot().insights.data?.goal.mtdMinor).toBe(2);
  });

  it("reuses one idempotency key for the same draft across send retries", async () => {
    online();
    const sendBodies: Array<{ idempotencyKey: string; finalText: string; asVoice?: boolean }> = [];
    let sendAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const path = pathOf(url);
      if (path === "/threads/t1") return Response.json(threadDetail({ currentDraft: draft }));
      if (path === "/threads/t1/send") {
        sendBodies.push(JSON.parse(String(init.body)));
        sendAttempts += 1;
        return sendAttempts === 1 ? new Response(JSON.stringify({ error: "request_failed" }), { status: 500 }) : Response.json({ status: "accepted", sent: true, intentId: "i1" });
      }
      return Response.json(core(path));
    }));
    const store = await signedIn();
    await store.loadThread("t1");
    await expect(store.send("t1", "Heyy! Sending rates.")).rejects.toThrow();
    const result = await store.send("t1", "Heyy! Sending rates.", { asVoice: true });
    expect(sendBodies).toHaveLength(2);
    expect(sendBodies[0]!.idempotencyKey).toBe(sendBodies[1]!.idempotencyKey);
    expect(sendBodies[1]!.asVoice).toBe(true);
    expect(result).toMatchObject({ sent: true, learned: [], pending: false, ambiguous: false });
  });

  it("refuses to send without a fresh draft and never calls the API", async () => {
    online();
    const fetch = vi.fn(async (url: string) => Response.json(core(pathOf(url))));
    vi.stubGlobal("fetch", fetch);
    const store = await signedIn();
    const calls = fetch.mock.calls.length;
    await expect(store.send("missing", "hello")).rejects.toThrow("fresh draft");
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("reads the Leak Scan status, inferring it from the counts when the API sends none", async () => {
    online();
    let summary: Record<string, unknown> = { scannedCount: 0, commerceCount: 0, totalMinMinor: 0, topThreads: [] };
    serve({ "GET /onboarding/leak-scan": () => summary });
    const store = await signedIn();
    expect((await store.getLeakScan()).status).toBe("running");
    summary = { ...summary, scannedCount: 12 };
    expect((await store.getLeakScan()).status).toBe("done");
    summary = { ...summary, status: "idle" };
    expect((await store.getLeakScan()).status).toBe("idle");
  });
});

describe("writes refetch only what they change", () => {
  it("moves a thread to Waiting from the response and reloads only the open conversation", async () => {
    online();
    let state: "open" | "waiting" = "open";
    const calls = serve({
      "GET /inbox": () => ({ rows: state === "open" ? [inboxRow()] : [] }),
      "GET /threads/t1": () => threadDetail({ state, waitingSince: state === "waiting" ? iso(0) : null }),
      "PATCH /threads/t1": () => { state = "waiting"; return { state, waitingSince: iso(0) }; },
    });
    const store = await signedIn();
    await store.loadThread("t1");
    calls.length = 0;

    await store.setState("t1", "waiting");
    expect(calls).toEqual(["PATCH /threads/t1", "GET /threads/t1"]);
    const row = store.getSnapshot().threads.find((thread) => thread.id === "t1");
    expect(row).toMatchObject({ state: "waiting", routedTo: "inbox", detail: false, nudgeDue: false });
    expect(store.getSnapshot().details.t1?.data?.state).toBe("waiting");
  });

  it("closing a sale refetches the ledger and dashboard, drops the row and marks derived slices stale", async () => {
    online();
    let closed = false;
    const calls = serve({
      "GET /inbox": () => ({ rows: closed ? [] : [inboxRow()] }),
      "GET /threads/t1": () => threadDetail({ state: closed ? "closed" : "open" }),
      "POST /threads/t1/close": () => { closed = true; return { entryId: "l1", amountMinor: 75_000_00 }; },
      "GET /ledger": () => ({ ...(core("/ledger") as object), entries: closed ? [{ id: "l1", threadId: "t1", handle: "brand", dealType: "brand", amountMinor: 75_000_00, closedAt: iso(0) }] : [] }),
      "GET /dashboard": () => ({ ...(core("/dashboard") as object), mtdRecoveredMinor: closed ? 75_000_00 : 0, mtdDealCount: closed ? 1 : 0 }),
    });
    const store = await signedIn();
    await Promise.all([store.loadThread("t1"), store.loadInsights(6)]);
    calls.length = 0;

    await store.closeDeal("t1", 75_000_00, "brand", { idempotencyKey: "close-t1-0123456789" });
    expect([...calls].sort()).toEqual(["GET /dashboard", "GET /ledger", "GET /threads/t1", "POST /threads/t1/close"]);
    const snapshot = store.getSnapshot();
    expect(snapshot.threads.some((thread) => thread.id === "t1")).toBe(false);
    expect(snapshot.ledger.map((entry) => entry.id)).toEqual(["l1"]);
    expect(snapshot.dashboard?.mtdRecoveredMinor).toBe(75_000_00);
    expect(snapshot.insights).toMatchObject({ status: "ready", stale: true });
    expect(snapshot.audit.status).toBe("idle");
  });

  it("a review drops the decided item and refetches only the inbox lists", async () => {
    online();
    let decided = false;
    const calls = serve({
      "GET /review-queue": () => ({ rows: decided ? [] : [reviewRow()] }),
      "GET /inbox": () => ({ rows: decided ? [inboxRow({ threadId: "r1", participantHandle: "maybe" })] : [] }),
      "POST /classifications/c1/review": () => { decided = true; return { label: "brand_deal", outcome: "overridden" }; },
    });
    const store = await signedIn();
    calls.length = 0;

    await store.review("c1", "overridden", "brand_deal");
    expect([...calls].sort()).toEqual(["GET /inbox", "GET /inbox?state=waiting", "POST /classifications/c1/review"]);
    expect(store.getSnapshot().threads.map((thread) => [thread.id, thread.routedTo])).toEqual([["r1", "inbox"]]);
  });

  it("a ledger edit patches the entry and refetches only the month's dashboard", async () => {
    online();
    const entry = { id: "l1", threadId: "t1", handle: "brand", dealType: "brand", amountMinor: 75_000_00, closedAt: iso(0), note: "Reel" };
    const calls = serve({
      "GET /ledger": () => ({ ...(core("/ledger") as object), entries: [entry] }),
      "PATCH /ledger/l1": () => ({ id: "l1", amountMinor: 80_000_00 }),
    });
    const store = await signedIn();
    calls.length = 0;

    await store.updateLedger("l1", { amountMinor: 80_000_00, dealType: "coaching", note: undefined });
    expect(calls).toEqual(["PATCH /ledger/l1", "GET /dashboard"]);
    expect(store.getSnapshot().ledger[0]).toMatchObject({ id: "l1", amountMinor: 80_000_00, dealType: "coaching", note: "Reel" });
  });

  it("never shows loading again for a slice that has data, and keeps it while it reloads", async () => {
    online();
    serve({});
    const store = await signedIn();
    await store.loadInsights(6);
    const statuses: string[] = [];
    const stop = store.subscribe(() => statuses.push(store.getSnapshot().insights.status));
    await store.loadInsights(6);
    stop();
    expect(statuses).not.toContain("loading");
    expect(store.getSnapshot().insights).toMatchObject({ status: "ready", stale: false });
  });

  it("fetches a slice again when a write makes it stale mid-load, so pre-write data never lands", async () => {
    online();
    let release: (() => void) | undefined;
    let holding = false;
    let goal: number | null = null;
    const calls = serve({
      "PUT /settings/goal": (init) => { goal = JSON.parse(String(init.body)).monthlyGoalMinor; return { monthlyGoalMinor: goal }; },
      "GET /insights?months=6": async () => {
        const answer = { goal: { monthlyGoalMinor: goal, mtdMinor: 0, pct: goal ? 0 : null, projectedMinor: null }, months: [] };
        if (holding) { holding = false; await new Promise<void>((resolve) => { release = resolve; }); }
        return answer;
      },
    });
    const store = await signedIn();
    await store.loadInsights(6);
    holding = true;
    const before = store.loadInsights(6);
    await vi.waitFor(() => expect(release).toBeDefined());

    await store.setGoal(500_000_00);
    expect(store.getSnapshot().insights.stale).toBe(true);
    release!();
    await before;
    expect(calls.filter((call) => call === "GET /insights?months=6")).toHaveLength(3);
    expect(store.getSnapshot().insights).toMatchObject({ status: "ready", stale: false, data: { goal: { monthlyGoalMinor: 500_000_00 } } });
  });

  it("refetches a list whose load started before a local patch instead of letting it undo the write", async () => {
    online();
    let state: "open" | "waiting" = "open";
    let hold: Promise<void> | null = null;
    let release: (() => void) | undefined;
    const calls = serve({
      "GET /inbox": async () => {
        const rows = state === "open" ? [inboxRow()] : [];
        if (hold) { const wait = hold; hold = null; await wait; }
        return { rows };
      },
      "GET /inbox?state=waiting": () => ({ rows: state === "waiting" ? [inboxRow({ state: "waiting", waitingSince: iso(0) })] : [] }),
      "PATCH /threads/t1": () => { state = "waiting"; return { state, waitingSince: iso(0) }; },
    });
    const store = await signedIn();
    hold = new Promise<void>((resolve) => { release = resolve; });
    const refreshing = store.refresh();
    await vi.waitFor(() => expect(release).toBeDefined());

    await store.setState("t1", "waiting");
    expect(store.getSnapshot().threads.find((thread) => thread.id === "t1")?.state).toBe("waiting");
    calls.length = 0;
    release!();
    await refreshing;
    await vi.waitFor(() => expect(calls).toContain("GET /inbox"));
    await vi.waitFor(() => expect(store.getSnapshot().threads.map((thread) => [thread.id, thread.state])).toEqual([["t1", "waiting"]]));
  });
});
