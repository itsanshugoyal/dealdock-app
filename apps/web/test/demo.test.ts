import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuditAction } from "@dealdock/core";
import { applyChip, applyInstruction, baseDraft, DEMO_MONEY, learnedSignals, seedOffers, styleCardFrom, seedSamples, toneWav, wavDataUrl, wavDurationMs, type DraftSubject } from "../src/lib/demo-data";
import { demoStore } from "../src/lib/demo-store";

afterEach(() => { vi.useRealTimers(); });

const brand: DraftSubject = { label: "brand_deal", kind: "reply", firstName: null, hinglish: false };
const offers = seedOffers(Date.now());

describe("demo drafting engine", () => {
  it("applies steering chips and instructions deterministically", () => {
    const base = baseDraft(brand, offers, DEMO_MONEY);
    expect(base.startsWith("Heyy!")).toBe(true);
    expect(base.endsWith("– D")).toBe(true);
    expect(applyChip(base, "shorter", brand, offers, DEMO_MONEY).length).toBeLessThan(base.length);
    expect(applyChip(base, "no_emoji", brand, offers, DEMO_MONEY)).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(applyChip(base, "quote_rate", brand, offers, DEMO_MONEY)).toContain("₹60,000–₹90,000");
    expect(applyChip(base, "more_formal", brand, offers, DEMO_MONEY)).toMatch(/^Hello.*Best, Diya$/);
    expect(applyInstruction(base, "say I'm booked till March")).toContain("I'm booked till March. – D");
    expect(applyChip(base, "shorter", brand, offers, DEMO_MONEY)).toBe(applyChip(base, "shorter", brand, offers, DEMO_MONEY));
  });

  it("notices style changes between the draft and what was sent", () => {
    const signals = learnedSignals("Hi! Thanks so much for reaching out — could you share the brief and timeline? 🙏", "Heyy! Share the brief? – D", "brand_deal");
    expect(signals.map((signal) => signal.key)).toEqual(["greeting.heyy", "length.brand_deal", "emoji.none.brand_deal", "signoff.d"]);
  });

  it("derives a plausible style card from the creator's own replies and makes playable WAV tones", () => {
    const card = styleCardFrom(seedSamples(Date.now()).filter((sample) => !sample.excluded).map((sample) => sample.text));
    expect(card).toMatchObject({ greeting: "Heyy", signoff: "– D", sentenceLength: "short", emojiUsage: "light" });
    const wav = toneWav("Heyy, sending details now");
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(wav.length).toBeGreaterThan(44);
  });

  it("encodes the demo tones as 16-bit PCM through the shared encoder", () => {
    const wav = toneWav("one two three");
    const view = new DataView(wav.buffer);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint32(24, true)).toBe(8_000);
    expect(view.getUint16(34, true)).toBe(16);
    // Three words of 0.22 s tone and 0.04 s quiet each.
    expect(wavDurationMs(wav)).toBe(780);
    expect(view.getInt16(44 + 1_760 * 2, true)).toBe(0); // the first gap is silent
    expect(wavDataUrl(wav).startsWith("data:audio/wav;base64,UklGR")).toBe(true);
  });
});

describe("demo store parity with the API store", () => {
  it("publishes row-shaped threads while details carry the full conversation and draft", async () => {
    await demoStore.init();
    const row = demoStore.getSnapshot().threads.find((thread) => thread.id === "t-kesar");
    expect(row).toMatchObject({ detail: false, draft: null, draftReady: true });
    expect(row?.messages).toHaveLength(1);
    const detail = await demoStore.loadThread("t-kesar");
    expect(detail?.draft?.body).toMatch(/^Heyy!/);
    expect(await demoStore.loadThread("readiness-only")).toBeNull();
    expect(demoStore.getSnapshot().details["readiness-only"]?.errorStatus).toBe(404);
  });

  it("drafts 2–3 alternates on request and turns a new speaking voice ready", async () => {
    vi.useFakeTimers();
    const drafting = demoStore.generateDraft("t-rhea", { variants: 3, chips: ["warmer"] });
    await vi.advanceTimersByTimeAsync(700);
    const draft = await drafting;
    expect(draft.alternatives.length).toBeGreaterThanOrEqual(2);
    expect(draft.alternatives.length).toBeLessThanOrEqual(3);
    expect(draft.chips).toEqual(["warmer"]);

    const clip = { base64: "AAAA", mimeType: "audio/wav", durationMs: 30_000 };
    const creating = demoStore.createSpeakingVoice({ consentStatement: "I'm Diya and I consent.", consentClip: clip, samples: [clip, clip] });
    await vi.advanceTimersByTimeAsync(600);
    expect((await creating).status).toBe("pending");
    await vi.advanceTimersByTimeAsync(2_600);
    await demoStore.loadVoice();
    expect(demoStore.getSnapshot().voice.data?.speaking.status).toBe("ready");
  });

  it("follows the API's follow-up rule with the org's delay, and a dismissal restarts the clock", async () => {
    await demoStore.init();
    const due = (id: string) => demoStore.getSnapshot().threads.find((thread) => thread.id === id)?.nudgeDue;
    // Seeded: Urban Loom has been quiet 4 days, PeakFuel 5, Sana 1.
    expect([due("t-urbanloom"), due("t-peakfuel"), due("t-sana")]).toEqual([true, true, false]);
    await demoStore.updateRegion({ nudgeDelayDays: 5 });
    expect([due("t-urbanloom"), due("t-peakfuel")]).toEqual([false, true]);
    await demoStore.updateRegion({ nudgeDelayDays: 3 });
    await demoStore.dismissNudge("t-peakfuel");
    const peakfuel = demoStore.getSnapshot().threads.find((thread) => thread.id === "t-peakfuel");
    expect(peakfuel).toMatchObject({ state: "waiting", nudgeDue: false });
    expect(Date.now() - (peakfuel?.waitingSince ?? 0)).toBeLessThan(5_000);
    expect(peakfuel).not.toHaveProperty("nudgeDismissedAt");
  });

  it("writes audit rows under the API's action names", async () => {
    await demoStore.dismissNudge("t-urbanloom");
    await demoStore.setGoal(450_000_00);
    await demoStore.setIgnoreList(["masi.ji"]);
    await demoStore.updateOffer("offer-call", { availability: "Weekends only" });
    await demoStore.setSampleExcluded("sample-2", true);
    await demoStore.setSpeakingDisclosure(false);
    const rows = (await demoStore.loadAudit(500)) ?? [];
    const actions = rows.map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["settings.goal_changed", "settings.ignore_list_changed", "offer.updated", "voice.sample_excluded", "voice.disclosure_disabled", "nudge.dismissed", "ledger.created", "settings.region_changed"]));
    expect(actions.filter((action) => !isAuditAction(action))).toEqual([]);
  });

  it("reports the Leak Scan with the contract's status and floors the goal like the API", async () => {
    expect((await demoStore.getLeakScan()).status).toBe("done");
    vi.useFakeTimers();
    await demoStore.startLeakScan();
    expect((await demoStore.getLeakScan()).status).toBe("running");
    vi.advanceTimersByTime(6_000);
    expect((await demoStore.getLeakScan()).status).toBe("done");
    vi.useRealTimers();

    const insights = await demoStore.loadInsights(6);
    const goal = insights?.goal;
    expect(goal?.monthlyGoalMinor).toBeGreaterThan(0);
    expect(goal?.pct).toBe(Math.floor(((goal?.mtdMinor ?? 0) * 100) / (goal?.monthlyGoalMinor ?? 1)));
  });

  it("refuses a blank send and an unknown account to disconnect with the API's codes", async () => {
    await demoStore.loadThread("t-kesar");
    await expect(demoStore.send("t-kesar", "   ")).rejects.toMatchObject({ status: 400, code: "send_text_required" });
    expect(demoStore.getSnapshot().details["t-kesar"]?.data?.draft).not.toBeNull();
    const audits = (await demoStore.loadAudit(500))?.length;
    await expect(demoStore.disconnectInstagram("ig-someone-else")).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect((await demoStore.loadAudit(500))?.length).toBe(audits);
  });
});
