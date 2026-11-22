import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@dealdock/db";
import * as messaging from "@dealdock/messaging";
import { buildServer } from "../src/index";
import { scanAccountHistory } from "../src/graph-maintenance";

// The HTTP layer only: repositories and Meta calls are stubbed, auth is a creator seat.
vi.mock("@dealdock/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dealdock/db")>()),
  isOrgReadOnly: vi.fn(async () => false),
  getOrganization: vi.fn(async () => ({ id: "org_1" })),
  connectGraphAccount: vi.fn(async (_org: string, input: { handle: string }) => ({ handle: input.handle })),
  getConnectedAccount: vi.fn(),
  adoptParticipantHandles: vi.fn(async () => undefined),
  updateBackfillCheckpoint: vi.fn(async () => undefined),
}));
vi.mock("@dealdock/messaging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dealdock/messaging")>()),
  exchangeCodeForToken: vi.fn(async () => ({ accessToken: "IG-token", expiresIn: 5_184_000 })),
  fetchIgProfile: vi.fn(async () => ({ userId: "17841400000009", username: "solo", accountType: "MEDIA_CREATOR" })),
  exchangeUnifiedCode: vi.fn(async () => ({ accessToken: "SUAT", expiresIn: null })),
  fetchUnifiedAccounts: vi.fn(async () => []),
  subscribeToInstagramWebhooks: vi.fn(async () => undefined),
  refreshLongLivedToken: vi.fn(async () => ({ accessToken: "refreshed", expiresIn: 1 })),
}));
vi.mock("../src/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/graph")>()),
  getGraphAdapter: () => ({ listConversations: async () => [], fetchMessages: async () => [] }),
}));
vi.mock("../src/auth", () => ({
  requireAuth: async (req: { auth?: unknown }) => {
    req.auth = { clerkUserId: "user_1", orgId: "org_1", seatId: "seat_1", role: "creator" };
  },
}));

const app = buildServer();
app.log.level = "silent";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("META_APP_ID", "meta_app");
  vi.stubEnv("META_APP_SECRET", "meta_secret");
  vi.stubEnv("IG_OAUTH_REDIRECT_URI", "https://api.example.test/ig/callback");
  vi.stubEnv("WEB_APP_URL", "https://app.example.test");
});
afterEach(() => vi.unstubAllEnvs());

const connect = async () => (await app.inject({ method: "POST", url: "/ig/connect" }));
const callback = async () => {
  const state = new URL((await connect()).json().authorizeUrl).searchParams.get("state")!;
  return app.inject({ method: "GET", url: `/ig/callback?code=code_1&state=${encodeURIComponent(state)}` });
};

describe("Instagram Login (flag off)", () => {
  it("sends people to instagram.com with scopes, and connects one professional account", async () => {
    const url = new URL((await connect()).json().authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toContain("instagram_business_manage_messages");

    const response = await callback();
    expect(response.statusCode).toBe(302);
    expect(messaging.subscribeToInstagramWebhooks).toHaveBeenCalledWith({ graphBase: undefined }, "IG-token", "17841400000009", ["messages"]);
    expect(db.connectGraphAccount).toHaveBeenCalledWith("org_1", expect.objectContaining({ igUserId: "17841400000009", accountType: "creator", expiresIn: 5_184_000 }));
    expect(messaging.exchangeUnifiedCode).not.toHaveBeenCalled();
  });

  it("still rejects a personal account, back on the Instagram step", async () => {
    vi.mocked(messaging.fetchIgProfile).mockResolvedValueOnce({ userId: "1", username: "me", accountType: "PERSONAL" });
    const response = await callback();
    expect([response.statusCode, response.headers.location]).toEqual([302, "https://app.example.test/onboarding?step=connect&error=personal_account"]);
  });
});

describe("Unified Login (META_UNIFIED_LOGIN_ENABLED)", () => {
  beforeEach(() => vi.stubEnv("META_UNIFIED_LOGIN_ENABLED", "true"));

  it("fails closed without the login configuration id", async () => {
    const response = await connect();
    expect([response.statusCode, response.json()]).toEqual([503, { error: "meta_app_not_configured" }]);
  });

  it("sends people to Facebook Login for Business with the configuration, never scopes", async () => {
    vi.stubEnv("META_LOGIN_CONFIG_ID", "cfg_9");
    const url = new URL((await connect()).json().authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(url.searchParams.get("config_id")).toBe("cfg_9");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("connects every shared account with the one non-expiring token, subscribed on graph.facebook.com", async () => {
    vi.stubEnv("META_LOGIN_CONFIG_ID", "cfg_9");
    vi.mocked(messaging.fetchUnifiedAccounts).mockResolvedValueOnce([
      { userId: "17841400000001", username: "one", accountType: "UNKNOWN" },
      { userId: "17841400000002", username: "two", accountType: "UNKNOWN" },
    ]);
    const response = await callback();
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://app.example.test/onboarding?connected=one");
    expect(messaging.subscribeToInstagramWebhooks).toHaveBeenCalledWith({ graphBase: "https://graph.facebook.com/v25.0" }, "SUAT", "17841400000002", ["messages"]);
    expect(vi.mocked(db.connectGraphAccount).mock.calls.map(([, input]) => [input.igUserId, input.expiresIn])).toEqual([["17841400000001", null], ["17841400000002", null]]);
    expect(messaging.fetchIgProfile).not.toHaveBeenCalled();
  });

  it("keeps the first account when a later one hits the plan's cap", async () => {
    vi.stubEnv("META_LOGIN_CONFIG_ID", "cfg_9");
    vi.mocked(messaging.fetchUnifiedAccounts).mockResolvedValueOnce([
      { userId: "17841400000001", username: "one", accountType: "UNKNOWN" },
      { userId: "17841400000002", username: "two", accountType: "UNKNOWN" },
    ]);
    vi.mocked(db.connectGraphAccount).mockResolvedValueOnce({ handle: "one" } as never).mockRejectedValueOnce(new Error("ig_account_limit:1"));
    const response = await callback();
    expect([response.statusCode, response.headers.location]).toEqual([302, "https://app.example.test/onboarding?connected=one"]);
  });

  it("returns to onboarding with no_instagram_account when nothing was shared", async () => {
    vi.stubEnv("META_LOGIN_CONFIG_ID", "cfg_9");
    const response = await callback();
    expect([response.statusCode, response.headers.location]).toEqual([302, "https://app.example.test/onboarding?step=connect&error=no_instagram_account"]);
    expect(db.connectGraphAccount).not.toHaveBeenCalled();
  });

  it("never refreshes a Unified Login token during backfill", async () => {
    vi.mocked(db.getConnectedAccount).mockResolvedValueOnce({
      accountId: "ig_1", platformUserId: "17841400000001", handle: "one", accessToken: "SUAT", refreshToken: null,
      provider: "instagram_graph", status: "active", tokenRefreshedAt: new Date(Date.now() - 30 * 864e5), tokenExpiresAt: null, syncCursor: null,
    } as never);
    await expect(scanAccountHistory("org_1", "ig_1", new Date(0), "live")).resolves.toBe(0);
    expect(messaging.refreshLongLivedToken).not.toHaveBeenCalled();
  });
});
