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
    // Equal string length alone is not enough: malformed hex must never be
    // coerced into an apparently valid HMAC buffer.
    expect(
      adapter.verifyWebhook({
        headers: { "x-hub-signature-256": `sha256=${"z".repeat(64)}` },
        rawBody: raw,
      })
    ).toBe(false);
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

  it("treats a 2xx response without a message receipt as ambiguous, never successful", async () => {
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch(() => ({ body: { recipient_id: "igsid-user-9" } })),
    });
    await expect(adapter.sendMessage(ACCOUNT, target, "hello")).rejects.toThrow("no verifiable message receipt");
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

  it("rejects an untrusted pagination host rather than following it with a creator token", async () => {
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch(() => ({
        body: {
          data: [],
          paging: { next: "https://attacker.invalid/steal-token" },
        },
      })),
    });
    await expect(adapter.listConversations(ACCOUNT)).rejects.toThrow("untrusted URL");
  });

  it("carries the conversation id so reading its messages needs no lookup", async () => {
    const urls: string[] = [];
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch((url) => {
        urls.push(url);
        if (url.includes("/me/conversations")) {
          return { body: { data: [{ id: "conv-7", updated_time: "2026-07-05T10:00:00+0000", participants: { data: [{ id: "igsid-user-7", username: "buyer" }] } }] } };
        }
        return { body: { data: [{ id: "m.7", created_time: "2026-07-05T10:00:00+0000", from: { id: "igsid-user-7" }, message: "Rates?" }] } };
      }),
    });
    const [thread] = await adapter.listConversations(ACCOUNT);
    expect(thread!.conversationId).toBe("conv-7");
    const messages = await adapter.fetchMessages(ACCOUNT, thread!.platformThreadId, undefined, thread!.conversationId);
    expect(messages.map((m) => m.platformMessageId)).toEqual(["m.7"]);
    expect(urls).toHaveLength(2);
    expect(urls.some((url) => url.includes("user_id="))).toBe(false);
    expect(urls[1]).toContain("/v25.0/conv-7/messages?");
  });

  it("stops paging once a whole page is older than since", async () => {
    const since = new Date("2026-07-05T00:00:00Z");
    const conversation = (id: string, updated: string) => ({
      id,
      updated_time: updated,
      participants: { data: [{ id: `igsid-${id}`, username: id }] },
    });
    const pages = [
      // Mixed page: the list's order is not documented, so keep going.
      [conversation("fresh", "2026-07-05T09:00:00+0000"), conversation("old-1", "2026-07-04T09:00:00+0000")],
      [conversation("old-2", "2026-07-03T09:00:00+0000"), conversation("old-3", "2026-07-02T09:00:00+0000")],
      [conversation("never-read", "2026-07-05T10:00:00+0000")],
    ];
    let calls = 0;
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch(() => {
        const data = pages[calls]!;
        calls += 1;
        return { body: { data, paging: { next: `https://graph.instagram.com/v25.0/me/conversations?page=${calls}` } } };
      }),
    });
    const threads = await adapter.listConversations(ACCOUNT, since);
    expect(calls).toBe(2);
    expect(threads.map((t) => t.participantHandle)).toEqual(["fresh"]);
  });

  it("fails the backfill rather than silently truncating history beyond the page cap", async () => {
    let calls = 0;
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch(() => {
        calls += 1;
        return {
          body: {
            data: [],
            paging: { next: `https://graph.instagram.com/v25.0/me/conversations?page=${calls}` },
          },
        };
      }),
    });
    await expect(adapter.listConversations(ACCOUNT)).rejects.toThrow("bounded page budget");
    // First request plus nineteen accepted continuation pages: no unbounded scan.
    expect(calls).toBe(20);
  });
});

describe("voice notes and conversation source (webhook)", () => {
  const adapter = new InstagramGraphAdapter({ appSecret: APP_SECRET });
  const item = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    object: "instagram",
    entry: [{ messaging: [{ sender: { id: "igsid-user-9" }, recipient: { id: ACCOUNT.platformUserId }, timestamp: 1720000000000, message: { mid: "mid.v", ...message }, ...extra }] }],
  });

  it("maps attachments[].type audio to an audio media url, detected by type", () => {
    const url = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x";
    const [event] = adapter.parseWebhook(item({ attachments: [{ type: "audio", payload: { url } }] }));
    expect(event!.message.text).toBe("");
    expect(event!.message.media).toEqual({ kind: "audio", url });
    expect(event!.message.threadSource).toBeUndefined();
  });

  it("tags story replies, story mentions, reel shares and ad/link referrals", () => {
    const source = (message: Record<string, unknown>, extra?: Record<string, unknown>) =>
      adapter.parseWebhook(item(message, extra))[0]!.message.threadSource;
    expect(source({ text: "omg this story", reply_to: { story: { id: "s1", url: "https://x" } } })).toBe("story");
    expect(source({ attachments: [{ type: "story_mention", payload: { url: "https://x" } }] })).toBe("story");
    expect(source({ attachments: [{ type: "ig_reel", payload: { url: "https://x" } }] })).toBe("reel");
    expect(source({ text: "Hi", referral: { source: "ADS", ad_id: "ad-1" } })).toBe("ad");
    expect(source({ text: "Hi" }, { referral: { source: "SHORTLINK", ref: "bio" } })).toBe("link");
    expect(source({ text: "plain hello" })).toBeUndefined();
  });
});

describe("history attachments", () => {
  it("requests attachments and recognises an audio attachment", async () => {
    const urls: string[] = [];
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch((url) => {
        urls.push(url);
        if (url.includes("user_id=")) return { body: { data: [{ id: "conv-1" }] } };
        return {
          body: {
            data: [
              {
                id: "m.1",
                created_time: "2026-07-05T10:00:00+0000",
                from: { id: "igsid-user-9" },
                attachments: { data: [{ mime_type: "audio/mpeg", audio_data: { url: "https://scontent.xx.fbcdn.net/a.mp4" } }] },
              },
              { id: "m.2", created_time: "2026-07-05T10:01:00+0000", from: { id: ACCOUNT.platformUserId }, message: "Thanks!" },
            ],
          },
        };
      }),
    });
    const messages = await adapter.fetchMessages(ACCOUNT, "igsid-user-9");
    expect(urls[1]).toContain("fields=id%2Ccreated_time%2Cfrom%2Cmessage%2Cattachments");
    expect(messages[0]!.media).toEqual({ kind: "audio", url: "https://scontent.xx.fbcdn.net/a.mp4" });
    expect(messages[1]!.media).toBeUndefined();
  });
});

describe("send payloads", () => {
  const target = { platformThreadId: "igsid-user-9", recipientPlatformId: "igsid-user-9" };
  function capture() {
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch((_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return { body: { message_id: "mid.sent" } };
      }),
    });
    return { adapter, bodies };
  }

  it("adds the HUMAN_AGENT message tag only when asked", async () => {
    const { adapter, bodies } = capture();
    await adapter.sendMessage(ACCOUNT, target, "hello");
    await adapter.sendMessage(ACCOUNT, target, "hello again", { humanAgentTag: true });
    expect(bodies[0]).toEqual({ recipient: { id: "igsid-user-9" }, message: { text: "hello" } });
    expect(bodies[1]).toEqual({
      recipient: { id: "igsid-user-9" },
      message: { text: "hello again" },
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
    });
  });

  it("sends a voice note as a single audio attachment fetched from an https url", async () => {
    const { adapter, bodies } = capture();
    const url = "https://api.example.test/media/a/x?exp=1&sig=s";
    const receipt = await adapter.sendAudio(ACCOUNT, target, url, { humanAgentTag: true });
    expect(receipt.platformMessageId).toBe("mid.sent");
    expect(bodies[0]).toEqual({
      recipient: { id: "igsid-user-9" },
      message: { attachment: { type: "audio", payload: { url } } },
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
    });
    await expect(adapter.sendAudio(ACCOUNT, target, "http://insecure.test/a.wav")).rejects.toThrow("https");
    expect(bodies).toHaveLength(1);
  });

  it("maps audio send rejections like text sends", async () => {
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch(() => ({ status: 400, body: { error: { message: "outside of allowed window", code: 10 } } })),
    });
    await expect(adapter.sendAudio(ACCOUNT, target, "https://x.test/a.wav")).rejects.toBeInstanceOf(SendWindowClosedError);
  });
});

describe("getUserProfile", () => {
  it("reads the sender profile fields within the rate budget", async () => {
    const urls: string[] = [];
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch((url) => {
        urls.push(url);
        return {
          body: {
            name: "Glow Herbals",
            username: "glowherbals.in",
            profile_pic: "https://scontent.cdninstagram.com/p.jpg",
            follower_count: 48200,
            is_verified_user: true,
            is_user_follow_business: false,
          },
        };
      }),
    });
    await expect(adapter.getUserProfile(ACCOUNT, "123456")).resolves.toEqual({
      name: "Glow Herbals",
      username: "glowherbals.in",
      profilePicUrl: "https://scontent.cdninstagram.com/p.jpg",
      followerCount: 48200,
      isVerified: true,
      followsBusiness: false,
    });
    expect(urls[0]).toBe(
      "https://graph.instagram.com/v25.0/123456?fields=name%2Cusername%2Cprofile_pic%2Cfollower_count%2Cis_verified_user%2Cis_user_follow_business"
    );
  });

  it("returns null when Meta withholds the profile or the id is not an IGSID", async () => {
    let calls = 0;
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch(() => {
        calls += 1;
        return { status: 400, body: { error: { message: "Unsupported get request", code: 100 } } };
      }),
    });
    await expect(adapter.getUserProfile(ACCOUNT, "123456")).resolves.toBeNull();
    await expect(adapter.getUserProfile(ACCOUNT, "../me/messages")).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it("still surfaces an expired token", async () => {
    const adapter = new InstagramGraphAdapter({
      appSecret: APP_SECRET,
      fetchImpl: fakeFetch(() => ({ status: 400, body: { error: { message: "Error validating access token", code: 190 } } })),
    });
    await expect(adapter.getUserProfile(ACCOUNT, "123456")).rejects.toBeInstanceOf(TokenExpiredError);
  });
});
