import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  fetchIgProfile,
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
