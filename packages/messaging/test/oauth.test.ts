import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  buildUnifiedAuthorizeUrl,
  exchangeUnifiedCode,
  fetchIgProfile,
  fetchUnifiedAccounts,
  fetchUnifiedMetaUserId,
  refreshLongLivedToken,
  subscribeToInstagramWebhooks,
} from "../src/instagram/oauth";

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const { status = 200, body } = handler(String(url), init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("Instagram Login OAuth helpers", () => {
  it("builds an official authorize URL with the two required scopes and opaque state", () => {
    const url = new URL(buildAuthorizeUrl({ appId: "app_1", redirectUri: "https://api.example/ig/callback" }, "signed-state"));
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("scope")).toContain("instagram_business_manage_messages");
  });

  it("uses a bounded request and official subscription endpoint after a professional connection", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    await subscribeToInstagramWebhooks(
      {
        fetchImpl: fakeFetch((url, init) => {
          captured = { url, init };
          return { body: { success: true } };
        }),
      },
      "IGQVJ-token",
      "17841400000000"
    );
    expect(captured?.url).toBe("https://graph.instagram.com/17841400000000/subscribed_apps");
    expect(captured?.init?.method).toBe("POST");
    expect(captured?.init?.headers).toMatchObject({ Authorization: "Bearer IGQVJ-token" });
    expect(String(captured?.init?.body)).toBe("subscribed_fields=messages");
    expect(captured?.init?.signal).toBeTruthy();
  });

  it("rejects malformed account ids before any subscription request", async () => {
    let called = false;
    await expect(subscribeToInstagramWebhooks({ fetchImpl: fakeFetch(() => {
      called = true;
      return { body: {} };
    }) }, "token", "not-an-igsid")).rejects.toThrow("invalid");
    expect(called).toBe(false);
  });

  it("fails closed for profile and refresh errors", async () => {
    const failed = fakeFetch(() => ({ status: 500, body: {} }));
    await expect(fetchIgProfile({ fetchImpl: failed }, "token")).rejects.toThrow("profile fetch failed");
    await expect(refreshLongLivedToken({ fetchImpl: failed }, "token")).rejects.toThrow("refresh failed");
  });
});

describe("Unified Login OAuth helpers", () => {
  const cfg = { appId: "meta_app", appSecret: "meta_secret", redirectUri: "https://api.example/ig/callback" };

  it("builds a Facebook Login for Business URL with the configuration instead of scopes", () => {
    const url = new URL(buildUnifiedAuthorizeUrl({ ...cfg, configId: "cfg_9" }, "signed-state"));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "meta_app", config_id: "cfg_9", redirect_uri: cfg.redirectUri, response_type: "code", override_default_response_type: "true", state: "signed-state", prompt: "login",
    });
  });

  it("exchanges the code once on graph.facebook.com; no expires_in means a token that never expires", async () => {
    let called = "";
    const token = await exchangeUnifiedCode({ ...cfg, fetchImpl: fakeFetch((url) => { called = url; return { body: { access_token: "SUAT", token_type: "bearer" } }; }) }, "code_1");
    expect(token).toEqual({ accessToken: "SUAT", expiresIn: null });
    const url = new URL(called);
    expect(url.origin + url.pathname).toBe("https://graph.facebook.com/v25.0/oauth/access_token");
    expect(url.searchParams.get("redirect_uri")).toBe(cfg.redirectUri);
    await expect(exchangeUnifiedCode({ ...cfg, fetchImpl: fakeFetch(() => ({ status: 400, body: { error: { message: "bad code" } } })) }, "code_1")).rejects.toThrow("IG token exchange failed");
  });

  it("lists the shared Instagram accounts (one or several)", async () => {
    const accounts = await fetchUnifiedAccounts({ ...cfg, fetchImpl: fakeFetch((url) => {
      expect(url).toContain("/me/assigned_instagram_accounts?fields=id,username");
      return { body: { data: [{ id: "17841400000001", username: "one" }, { id: "17841400000002", username: "two" }, { id: "../x" }] } };
    }) }, "SUAT");
    expect(accounts.map((account) => [account.userId, account.username])).toEqual([["17841400000001", "one"], ["17841400000002", "two"]]);
  });

  it("falls back to the token's granted ids when the assigned list is empty", async () => {
    const urls: string[] = [];
    const accounts = await fetchUnifiedAccounts({ ...cfg, fetchImpl: fakeFetch((url) => {
      urls.push(url);
      if (url.includes("assigned_instagram_accounts")) return { body: { data: [] } };
      if (url.includes("debug_token")) {
        return { body: { data: { granular_scopes: [{ scope: "instagram_manage_messages", target_ids: ["17841400000003"] }, { scope: "ads_read", target_ids: ["999"] }] } } };
      }
      return { body: { id: "17841400000003", username: "three" } };
    }) }, "SUAT");
    expect(accounts.map((account) => account.userId)).toEqual(["17841400000003"]);
    expect(new URL(urls[1]!).searchParams.get("access_token")).toBe("meta_app|meta_secret");
    expect(urls.some((url) => url.includes("/999?"))).toBe(false);
  });

  it("subscribes on the Unified host when given one", async () => {
    let called = "";
    await subscribeToInstagramWebhooks({ graphBase: "https://graph.facebook.com/v25.0", fetchImpl: fakeFetch((url) => { called = url; return { body: { success: true } }; }) }, "SUAT", "17841400000001");
    expect(called).toBe("https://graph.facebook.com/v25.0/17841400000001/subscribed_apps");
  });
});

describe("ids for Meta's deauthorize and data-deletion callbacks", () => {
  it("keeps Instagram Login's app-scoped id next to the professional account id", async () => {
    const profile = await fetchIgProfile({ fetchImpl: fakeFetch((url) => {
      expect(url).toContain("fields=id,user_id,username,account_type");
      return { body: { id: "9001", user_id: "17841400000009", username: "solo", account_type: "MEDIA_CREATOR" } };
    }) }, "token");
    expect(profile).toMatchObject({ userId: "17841400000009", metaUserId: "9001" });
  });

  it("reads the Unified Login token's user, and gives null instead of failing the connection", async () => {
    expect(await fetchUnifiedMetaUserId({ fetchImpl: fakeFetch((url) => {
      expect(url).toContain("/me?fields=id");
      return { body: { id: "61550000000001" } };
    }) }, "SUAT")).toBe("61550000000001");
    expect(await fetchUnifiedMetaUserId({ fetchImpl: fakeFetch(() => ({ status: 500, body: {} })) }, "SUAT")).toBeNull();
    expect(await fetchUnifiedMetaUserId({ fetchImpl: fakeFetch(() => ({ body: { id: "../x" } })) }, "SUAT")).toBeNull();
    expect(await fetchUnifiedMetaUserId({ fetchImpl: (async () => { throw new Error("network"); }) as typeof fetch }, "SUAT")).toBeNull();
  });
});
