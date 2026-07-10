import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InstagramGraphAdapter,
  RateBudgetExceededError,
  SendWindowClosedError,
  TokenExpiredError,
  type ConnectedAccount,
} from "../src/index";

const APP_SECRET = "test-app-secret";
const ACCOUNT: ConnectedAccount = {
  accountId: "acc-1",
  platformUserId: "17841400000000",
  handle: "demo.creator",
  accessToken: "IGQVJ-token",
};

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const { status = 200, body } = handler(String(url), init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex");
}

describe("webhook signature verification", () => {
  const adapter = new InstagramGraphAdapter({ appSecret: APP_SECRET });

  it("accepts a valid X-Hub-Signature-256", () => {
    const raw = JSON.stringify({ object: "instagram", entry: [] });
    expect(
      adapter.verifyWebhook({ headers: { "x-hub-signature-256": sign(raw) }, rawBody: raw })
    ).toBe(true);
  });

  it("rejects tampered payloads and missing signatures", () => {
    const raw = JSON.stringify({ object: "instagram", entry: [] });
    expect(
      adapter.verifyWebhook({
        headers: { "x-hub-signature-256": sign(raw) },
        rawBody: raw + "tampered",
      })
    ).toBe(false);
    expect(adapter.verifyWebhook({ headers: {}, rawBody: raw })).toBe(false);
  });
});

describe("webhook payload parsing", () => {
  const adapter = new InstagramGraphAdapter({ appSecret: APP_SECRET });

  const payload = {
    object: "instagram",
    entry: [
      {
        time: 1720000000000,
        messaging: [
          {
            sender: { id: "igsid-user-9" },
            recipient: { id: ACCOUNT.platformUserId },
            timestamp: 1720000000000,
            message: { mid: "mid.abc", text: "Paid collab ke liye baat karni thi" },
          },
        ],
      },
    ],
  };

  it("maps an inbound message, keyed by counterparty IGSID", () => {
    const events = adapter.parseWebhook(payload);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.accountPlatformUserId).toBe(ACCOUNT.platformUserId);
    expect(e.message.direction).toBe("inbound");
    expect(e.message.platformThreadId).toBe("igsid-user-9");
    expect(e.message.platformMessageId).toBe("mid.abc");
  });

  it("maps echoes (creator's own sends from the IG app) as outbound on the same thread", () => {
    const echo = {
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: ACCOUNT.platformUserId },
              recipient: { id: "igsid-user-9" },
              timestamp: 1720000001000,
              message: { mid: "mid.echo", text: "Sure, sharing rates", is_echo: true },
            },
          ],
        },
      ],
    };
    const events = adapter.parseWebhook(echo);
    expect(events[0]!.message.direction).toBe("outbound");
    expect(events[0]!.message.platformThreadId).toBe("igsid-user-9");
    expect(events[0]!.accountPlatformUserId).toBe(ACCOUNT.platformUserId);
  });

  it("ignores non-instagram objects and malformed entries", () => {
    expect(adapter.parseWebhook({ object: "page", entry: [] })).toHaveLength(0);
    expect(adapter.parseWebhook({ object: "instagram", entry: [{ messaging: [{}] }] })).toHaveLength(0);
  });
});

describe("sendMessage error mapping", () => {
  const target = { platformThreadId: "igsid-user-9", recipientPlatformId: "igsid-user-9" };

  it("returns a receipt on success", async () => {
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch(() => ({ body: { message_id: "mid.sent.1" } })),
    });
    const receipt = await adapter.sendMessage(ACCOUNT, target, "hello");
    expect(receipt.platformMessageId).toBe("mid.sent.1");
  });

  it("maps OAuthException 190 → TokenExpiredError", async () => {
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch(() => ({
        status: 400,
        body: { error: { message: "Error validating access token", code: 190 } },
      })),
    });
    await expect(adapter.sendMessage(ACCOUNT, target, "hello")).rejects.toBeInstanceOf(
      TokenExpiredError
    );
  });

  it("maps outside-window rejections → SendWindowClosedError", async () => {
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch(() => ({
        status: 400,
        body: {
          error: {
            message: "This message is sent outside of allowed window",
            code: 10,
          },
        },
      })),
    });
    await expect(adapter.sendMessage(ACCOUNT, target, "hello")).rejects.toBeInstanceOf(
      SendWindowClosedError
    );
  });
});

describe("per-account rate budget", () => {
  it("throws RateBudgetExceededError once the bucket is spent, with retry hint", async () => {
    let clock = 0;
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      now: () => clock,
      fetchImpl: fakeFetch(() => ({ body: { message_id: "ok" } })),
    });
    const target = { platformThreadId: "t", recipientPlatformId: "t" };

    for (let i = 0; i < 180; i++) {
      await adapter.sendMessage(ACCOUNT, target, "x");
    }
    await expect(adapter.sendMessage(ACCOUNT, target, "x")).rejects.toBeInstanceOf(
      RateBudgetExceededError
    );

    // Advance the clock — refill unlocks the budget again.
    clock += 60 * 60_000;
    await expect(adapter.sendMessage(ACCOUNT, target, "x")).resolves.toBeTruthy();
  });
});

describe("listConversations mapping", () => {
  it("keys threads by counterparty and skips self", async () => {
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch(() => ({
        body: {
          data: [
            {
              id: "conv-1",
              updated_time: "2026-07-05T10:00:00+0000",
              participants: {
                data: [
                  { id: ACCOUNT.platformUserId, username: "demo.creator" },
                  { id: "igsid-brand-1", username: "glowherbals.in" },
                ],
              },
            },
          ],
        },
      })),
    });
    const threads = await adapter.listConversations(ACCOUNT);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.platformThreadId).toBe("igsid-brand-1");
    expect(threads[0]!.participantHandle).toBe("glowherbals.in");
  });
});
