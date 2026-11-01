import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDraft: vi.fn(), profile: vi.fn(), count: vi.fn(), batch: vi.fn(), rules: vi.fn(),
  corpus: vi.fn(), apply: vi.fn(), distill: vi.fn(),
}));

vi.mock("@dealdock/db", () => ({
  asOrgId: (id: string) => id,
  getDraftForLearning: mocks.getDraft,
  getVoiceProfileState: mocks.profile,
  countEditedSendsSince: mocks.count,
  listDistillationBatch: mocks.batch,
  listVoiceRules: mocks.rules,
  loadVoiceCorpus: mocks.corpus,
  applyVoiceLearning: mocks.apply,
}));
vi.mock("@dealdock/ai", () => ({
  analyzeEdit: () => ({ kind: "edited", editRatio: 0.2, signals: [] }),
  editEvidence: () => [], draftScope: () => "all", planRuleUpdates: () => ({ upserts: [], deletes: [] }),
  distillEditRules: mocks.distill,
}));

import { learnFromSend } from "../src/consumers/voice-learning";

const state = (excludedMessageIds: string[] = [], version = 1) => ({
  consent: { granted: true }, learningPaused: false, lastDistilledAt: null, excludedMessageIds, version,
});
const batch = Array.from({ length: 5 }, (_, i) => ({
  id: `edit-${i}`, sentMessageId: `sent-${i}`, kind: "reply", label: null,
  body: "draft", finalText: "sent", editSignals: null, threadId: `thread-${i}`,
}));

describe("voice distillation privacy", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-only");
    vi.stubEnv("DRAFT_MODEL", "test-only");
    mocks.getDraft.mockImplementation(async (_org, id) => ({
      id, status: "sent", finalText: "sent", body: "draft", editRatio: 0.2,
      threadId: "thread", thread: { igAccountId: id === "draft-a" ? "account-a" : "account-b" },
    }));
    mocks.profile.mockResolvedValue(state());
    mocks.count.mockResolvedValue(5);
    mocks.batch.mockResolvedValue(batch);
    mocks.rules.mockResolvedValue([]);
    mocks.apply.mockResolvedValue({ outcome: "applied", changed: 0 });
    mocks.distill.mockResolvedValue([]);
  });

  it("uses the latest account exclusions and never passes excluded or non-native samples to the model", async () => {
    mocks.profile.mockResolvedValueOnce(state()).mockResolvedValueOnce(state(["excluded"]));
    mocks.corpus.mockResolvedValue([
      { messageId: "excluded", origin: "native", text: "private excluded sample" },
      { messageId: "allowed", origin: "native", text: "allowed sample" },
      { messageId: "drafted", origin: "dealdock", text: "generated sample" },
    ]);
    await learnFromSend({ orgId: "org-a", draftId: "draft-a" });
    expect(mocks.corpus).toHaveBeenCalledWith("org-a", "account-a", 400);
    expect(mocks.distill).toHaveBeenCalledWith(expect.any(Array), [], ["allowed sample"]);
  });

  it("filters excluded DealDock sends from model edits and requires five eligible edits", async () => {
    mocks.profile.mockResolvedValue(state(["sent-0"]));
    mocks.corpus.mockResolvedValue([]);
    await learnFromSend({ orgId: "org-a", draftId: "draft-a" });
    expect(mocks.distill).not.toHaveBeenCalled();
    mocks.batch.mockResolvedValue([...batch, { ...batch[0], id: "edit-extra", sentMessageId: "sent-extra" }]);
    await learnFromSend({ orgId: "org-a", draftId: "draft-a" });
    expect(mocks.distill.mock.calls[0][0].map((edit: { draftId: string }) => edit.draftId)).toEqual(["edit-1", "edit-2", "edit-3", "edit-4", "edit-extra"]);
  });

  it("does not report distillation applied when the profile changed during the model call", async () => {
    mocks.corpus.mockResolvedValue([]);
    mocks.apply.mockResolvedValueOnce({ outcome: "applied", changed: 0 }).mockResolvedValueOnce({ outcome: "voice_changed", changed: 0 });
    expect(await learnFromSend({ orgId: "org-a", draftId: "draft-a" })).toMatchObject({ distilled: false });
    expect(mocks.apply.mock.calls[1][2]).toMatchObject({ expectedVersion: 1 });
  });

  it("reads each account's own exclusions and corpus", async () => {
    mocks.profile.mockImplementation(async (org, account) => {
      expect(org).toBe("org-a");
      return state(account === "account-a" ? ["a-private"] : ["b-private"]);
    });
    mocks.corpus.mockImplementation(async (org, account) => {
      expect(org).toBe("org-a");
      return account === "account-a"
        ? [{ messageId: "a-private", origin: "native", text: "a secret" }, { messageId: "a-ok", origin: "native", text: "a allowed" }]
        : [{ messageId: "b-private", origin: "native", text: "b secret" }, { messageId: "b-ok", origin: "native", text: "b allowed" }];
    });
    await learnFromSend({ orgId: "org-a", draftId: "draft-a" });
    await learnFromSend({ orgId: "org-a", draftId: "draft-b" });
    expect(mocks.distill.mock.calls.map((call) => call[2])).toEqual([["a allowed"], ["b allowed"]]);
    expect(mocks.corpus.mock.calls.map((call) => call.slice(0, 2))).toEqual([["org-a", "account-a"], ["org-a", "account-b"]]);
  });

  it.each([
    { ...state(), consent: { granted: false } },
    { ...state(), learningPaused: true },
    state([], 2),
  ])("does not call the model if consent, pause or consent version changes while loading", async (changed) => {
    mocks.profile.mockResolvedValueOnce(state()).mockResolvedValueOnce(changed);
    mocks.corpus.mockResolvedValue([{ messageId: "sample", origin: "native", text: "private" }]);
    expect(await learnFromSend({ orgId: "org-a", draftId: "draft-a" })).toMatchObject({ distilled: false });
    expect(mocks.distill).not.toHaveBeenCalled();
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });
});
