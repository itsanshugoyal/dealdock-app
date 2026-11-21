import { afterEach, describe, expect, it, vi } from "vitest";
import { atHandle, displayName, fileSize, replyWindowInfo } from "../src/lib/format";
import { profileFor, withCreatorProfile } from "../src/lib/business-profile";
import { asEmail, demoPdf } from "../src/lib/demo-data";
import { demoStore } from "../src/lib/demo-store";

afterEach(() => { vi.unstubAllGlobals(); });

describe("email addresses and files", () => {
  it("never puts @ in front of an email address", () => {
    expect(atHandle("kesarandclay")).toBe("@kesarandclay");
    expect(atHandle("neha.kapoor@example.com")).toBe("neha.kapoor@example.com");
    expect(displayName({ name: null }, "neha.kapoor@example.com")).toBe("neha.kapoor@example.com");
    expect(displayName({ name: " " }, "rhea.runs")).toBe("@rhea.runs");
  });

  it("sizes attachments in plain units", () => {
    expect(fileSize(820)).toBe("820 B");
    expect(fileSize(248_320)).toBe("243 KB");
    expect(fileSize(1_258_291)).toBe("1.2 MB");
    expect(fileSize(2_097_152)).toBe("2 MB");
  });

  it("turns a DM-style demo draft into an email, and serves a placeholder PDF", () => {
    expect(asEmail("Heyy Neha! Yes, the 12-week program is open. – D")).toBe("Hi Neha,\n\nYes, the 12-week program is open.\n\nBest,\nDiya");
    expect(asEmail("Heyy! Sounds great. – D")).toBe("Hi,\n\nSounds great.\n\nBest,\nDiya");
    expect(demoPdf("Lumen-winter-brief.pdf")).toMatch(/^%PDF-1\.4[\s\S]*Fictional demo file: Lumen-winter-brief\.pdf[\s\S]*%%EOF$/);
  });
});

describe("what each creator sells (Roster)", () => {
  const workspace = {
    businessSummary: "Fitness coach", sells: ["1:1 coaching"],
    typicalBrandDealMinor: { min: 50_000_00, max: 150_000_00 }, typicalCoachingMinor: { min: 24_000_00, max: 24_000_00 }, typicalCourseMinor: null,
  };

  it("uses the workspace's answer for anything a creator leaves empty", () => {
    const context = { ...workspace, creators: { "ig-2": { typicalCoachingMinor: { min: 18_000_00, max: 18_000_00 } } } };
    const profile = profileFor(context, "ig-2");
    expect(profile.coaching).toEqual({ min: 18_000_00, max: 18_000_00 });
    expect(profile.brand).toEqual(workspace.typicalBrandDealMinor);
    expect(profile.summary).toBe("Fitness coach");
    expect([...profile.inherited].sort()).toEqual(["brand", "course", "sells", "summary"]);
    expect(profileFor(context, null).coaching).toEqual(workspace.typicalCoachingMinor);
    expect(profileFor(context, "ig-3").inherited.size).toBe(5);
  });

  it("saves only what the creator answered, and forgets a creator with nothing of their own", () => {
    const saved = withCreatorProfile(workspace, "ig-2", { summary: "  ", sells: [], brand: null, coaching: { min: 18_000_00, max: 18_000_00 }, course: null });
    expect(saved).toMatchObject({ ...workspace, creators: { "ig-2": { typicalCoachingMinor: { min: 18_000_00, max: 18_000_00 } } } });
    expect(Object.keys((saved.creators as Record<string, object>)["ig-2"]!)).toEqual(["typicalCoachingMinor"]);
    const other = withCreatorProfile(saved, "ig-3", { summary: "Food creator", sells: ["Brand collaborations"], brand: null, coaching: null, course: null });
    expect(Object.keys(other.creators as object).sort()).toEqual(["ig-2", "ig-3"]);
    const cleared = withCreatorProfile(other, "ig-2", { summary: "", sells: [], brand: null, coaching: null, course: null });
    expect(cleared.creators).toEqual({ "ig-3": { businessSummary: "Food creator", sells: ["Brand collaborations"] } });
    expect(cleared.typicalCoachingMinor).toEqual(workspace.typicalCoachingMinor);
  });
});

describe("demo email inbox and email threads", () => {
  it("lists the demo inbox and opens email threads with a subject, an attachment and no reply window", async () => {
    await demoStore.init();
    const inboxes = await demoStore.loadEmailAccounts();
    expect(inboxes).toEqual({ available: true, accounts: [expect.objectContaining({ address: "collabs@diyamehra.example", status: "active", ownerAccountId: "ig-demo-diya" })] });
    const lumen = await demoStore.loadThread("e-lumen");
    expect(lumen).toMatchObject({ channel: "email", subject: "Winter glow campaign: brief and ₹1,50,000 budget", canSendVoice: false, replyWindow: { status: "none" }, scamReason: null });
    expect(lumen?.messages[0]?.attachments?.[0]).toMatchObject({ filename: "Lumen-winter-brief.pdf", mimeType: "application/pdf" });
    expect(replyWindowInfo(lumen!.replyWindow, Date.now(), "header")).toMatchObject({ canSend: true, visible: false, closed: false });
    expect(demoStore.getSnapshot().threads.find((thread) => thread.id === "e-neha")).toMatchObject({ channel: "email", subject: "1:1 coaching before my wedding", igAccountId: "ig-demo-diya" });
    // The Instagram accounts never include the Gmail inbox.
    expect((await demoStore.loadSettings())?.accounts.map((account) => account.id)).toEqual(["ig-demo-diya", "ig-demo-rohan", "ig-demo-ira"]);
  });

  it("drafts an email reply as an email and sends it with no reply window to close", async () => {
    await demoStore.init();
    const draft = await demoStore.generateDraft("e-neha");
    expect(draft.body).toMatch(/^Hi Neha,\n\n/);
    expect(draft.body).toMatch(/\n\nBest,\nDiya$/);
    expect((await demoStore.send("e-neha", draft.body)).sent).toBe(true);
  });

  it("connects an inbox for a chosen creator and disconnects it, as the API does", async () => {
    await demoStore.init();
    await expect(demoStore.connectEmail()).rejects.toMatchObject({ status: 400, code: "ig_account_required" });
    expect(await demoStore.connectEmail("ig-demo-rohan")).toEqual({ authorizeUrl: "/settings?email=connected#email" });
    const rohan = (await demoStore.loadEmailAccounts())?.accounts.find((inbox) => inbox.ownerAccountId === "ig-demo-rohan");
    expect(rohan).toMatchObject({ address: "collabs@rohancooks.example", status: "active" });
    await demoStore.disconnectEmail(rohan!.id);
    expect((await demoStore.loadEmailAccounts())?.accounts.some((inbox) => inbox.id === rohan!.id)).toBe(false);
    await expect(demoStore.disconnectEmail(rohan!.id)).rejects.toMatchObject({ status: 404 });
    expect(((await demoStore.loadAudit(500)) ?? []).map((row) => row.action)).toContain("email.disconnected");
  });
});

describe("scam warnings in the demo", () => {
  it("flags only the fake ambassador offer, in Check as spam with the reason as its rationale and no money", async () => {
    await demoStore.init();
    const flagged = demoStore.getSnapshot().threads.filter((thread) => thread.scamReason);
    expect(flagged.map((thread) => thread.id)).toEqual(["r-scam"]);
    expect(flagged[0]).toMatchObject({ routedTo: "review_queue", topLabel: "spam", rationale: "They're asking you to pay to take part.", scamReason: "They're asking you to pay to take part.", estValueMaxMinor: null });
  });
});

describe("demo sessions saved before email", () => {
  it("keep loading and gain the inbox, the email threads and the scam DM; a deal recorded after a closing phrase settles it", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } });
    vi.resetModules();
    const first = (await import("../src/lib/demo-store")).demoStore;
    await first.init();
    // The same session as an older build saved it: no inbox, no email or scam threads, no channel fields, and Founders' closing phrase still on file.
    const saved = JSON.parse(storage.get("dealdock-demo-v2")!) as { emailAccounts?: unknown; threads: Array<Record<string, unknown> & { id: string; messages: Array<{ id: string }> }> };
    delete saved.emailAccounts;
    saved.threads = saved.threads.filter((thread) => !["e-lumen", "e-neha", "r-scam"].includes(thread.id));
    for (const thread of saved.threads) { delete thread.channel; delete thread.subject; delete thread.scamReason; }
    const founders = saved.threads.find((thread) => thread.id === "t-founders")!;
    founders.dealSignal = { messageId: founders.messages[founders.messages.length - 1]!.id, phrase: "let's lock it", suggestedAmountMinor: null, suggestedDealType: "other" };
    storage.set("dealdock-demo-v2", JSON.stringify(saved));

    vi.resetModules();
    const restored = (await import("../src/lib/demo-store")).demoStore;
    await restored.init();
    expect(restored.getSnapshot().threads.map((thread) => thread.id)).toEqual(expect.arrayContaining(["e-lumen", "e-neha", "r-scam"]));
    expect((await restored.loadEmailAccounts())?.accounts).toHaveLength(1);
    expect(restored.getSnapshot().threads.find((thread) => thread.id === "t-kesar")?.channel).toBe("instagram");
    const thread = await restored.loadThread("t-founders");
    expect(thread?.dealSignal).toBeNull();
    expect(thread?.hasDealSignal).toBe(false);
  });
});
