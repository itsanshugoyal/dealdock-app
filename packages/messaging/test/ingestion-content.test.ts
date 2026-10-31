import { describe, expect, it } from "vitest";
import { IngestionJob } from "@dealdock/core";
import { ingestionContent, ingestionDedupeKey, type RemoteMessage } from "../src/index";

const base: RemoteMessage = { platformMessageId: "mid", platformThreadId: "t", direction: "inbound", text: "", sentAt: new Date(0), raw: {} };

describe("ingestionContent", () => {
  it("marks voice notes as audio with their media url", () => {
    const content = ingestionContent({ ...base, media: { kind: "audio", url: "https://lookaside.fbsbx.com/a" } });
    expect(content).toEqual({ contentType: "audio", mediaUrl: "https://lookaside.fbsbx.com/a", mediaKind: "audio" });
  });

  it("keeps text and other attachments as before, with the conversation source", () => {
    expect(ingestionContent({ ...base, text: "hi", threadSource: "story" })).toEqual({ contentType: "text", threadSource: "story" });
    expect(ingestionContent({ ...base, media: { kind: "image", url: null } })).toEqual({ contentType: "attachment", mediaKind: "image" });
  });

  it("drops values that would make the job fail validation", () => {
    const content = ingestionContent({ ...base, media: { kind: "x".repeat(80), url: `https://lookaside.fbsbx.com/${"a".repeat(5000)}` } });
    expect(content.mediaUrl).toBeUndefined();
    expect(content.mediaKind).toHaveLength(40);
    const job = { orgId: "o", igAccountId: "a", igThreadId: "t", participantHandle: "h", participantIgId: "h", igMessageId: "m", direction: "inbound", text: "", sentAt: new Date(0).toISOString(), ...content };
    expect(IngestionJob.safeParse(job).success).toBe(true);
  });
});

describe("ingestionDedupeKey", () => {
  it("is one key per account and platform message, whichever path delivers it", () => {
    expect(ingestionDedupeKey("acct-1", "mid.abc")).toBe("instagram:ingestion:acct-1:mid.abc");
    expect(ingestionDedupeKey("acct-2", "mid.abc")).not.toBe(ingestionDedupeKey("acct-1", "mid.abc"));
  });
});
