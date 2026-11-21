import { describe, expect, it } from "vitest";
import { buildGoogleAuthorizeUrl, exchangeGoogleCode, fetchGmailAddress, refreshGoogleToken, GMAIL_SEND_SCOPE } from "../src/index";

const CFG = { clientId: "123.apps.googleusercontent.com", clientSecret: "GOCSPX-secret", redirectUri: "https://api.dealdock.app/email/callback" };

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init?: RequestInit }> = []) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("Google OAuth for Gmail", () => {
  it("asks for offline access with consent, the four scopes and the signed state", () => {
    const url = new URL(buildGoogleAuthorizeUrl(CFG, "signed.state"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(
      "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send"
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("signed.state");
    expect(url.searchParams.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("exchanges the code with the secret in the POST body and reports granted scopes", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const tokens = await exchangeGoogleCode(
      { ...CFG, fetchImpl: fakeFetch(200, { access_token: "ya29.a", refresh_token: "1//r", expires_in: 3599, scope: `openid ${GMAIL_SEND_SCOPE}` }, seen) },
      "4/0Ab-code"
    );
    expect(tokens).toEqual({ accessToken: "ya29.a", refreshToken: "1//r", expiresIn: 3599, scopes: ["openid", GMAIL_SEND_SCOPE] });
    expect(seen[0]!.url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(seen[0]!.init!.body));
    expect(Object.fromEntries(form)).toEqual({
      client_id: CFG.clientId,
      client_secret: CFG.clientSecret,
      code: "4/0Ab-code",
      grant_type: "authorization_code",
      redirect_uri: CFG.redirectUri,
    });
    await expect(exchangeGoogleCode({ ...CFG, fetchImpl: fakeFetch(400, { error: "invalid_grant" }) }, "x")).rejects.toThrow("invalid_grant");
  });

  it("refreshes; a refused refresh token is null (reconnect), an outage throws", async () => {
    expect(await refreshGoogleToken({ ...CFG, fetchImpl: fakeFetch(200, { access_token: "ya29.b", expires_in: 3599 }) }, "1//r")).toEqual({
      accessToken: "ya29.b",
      expiresIn: 3599,
    });
    expect(await refreshGoogleToken({ ...CFG, fetchImpl: fakeFetch(400, { error: "invalid_grant" }) }, "1//r")).toBeNull();
    await expect(refreshGoogleToken({ ...CFG, fetchImpl: fakeFetch(500, {}) }, "1//r")).rejects.toThrow("refresh failed");
  });

  it("reads the mailbox address, failing for a Google account without Gmail", async () => {
    expect(await fetchGmailAddress({ fetchImpl: fakeFetch(200, { emailAddress: "aanya.creates@gmail.com", historyId: "1" }) }, "ya29.a")).toBe("aanya.creates@gmail.com");
    await expect(fetchGmailAddress({ fetchImpl: fakeFetch(400, { error: { status: "FAILED_PRECONDITION" } }) }, "ya29.a")).rejects.toThrow("profile fetch failed");
  });
});
