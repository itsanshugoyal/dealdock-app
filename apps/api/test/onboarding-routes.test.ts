import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@dealdock/db";
import { GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from "@dealdock/messaging";
import { buildServer } from "../src/index";

// The HTTP layer only: repositories, Google and the sync queue are stubbed, auth is a creator seat.
vi.mock("@dealdock/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dealdock/db")>()),
  isOrgReadOnly: vi.fn(async () => false),
  resolveInboxOwner: vi.fn(async () => ({ id: "ig_1", handle: "solo" })),
  connectEmailAccount: vi.fn(async () => ({ id: "gm_1", igUserId: "solo@example.test", handle: "solo@example.test" })),
  getDashboard: vi.fn(async () => ({ org: { currencyCode: "INR", locale: "en-IN", name: "Studio" } })),
}));
vi.mock("@dealdock/messaging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dealdock/messaging")>()),
  exchangeGoogleCode: vi.fn(async () => ({ accessToken: "g-access", refreshToken: "g-refresh", expiresIn: 3600, scopes: [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE] })),
  fetchGmailAddress: vi.fn(async () => "solo@example.test"),
}));
vi.mock("../src/email-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/email-sync")>()),
  scheduleEmailSync: vi.fn(async () => undefined),
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
  vi.stubEnv("GOOGLE_CLIENT_ID", "google_client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google_secret");
  vi.stubEnv("GOOGLE_REDIRECT_URI", "https://api.example.test/email/callback");
  vi.stubEnv("WEB_APP_URL", "https://app.example.test");
});
afterEach(() => vi.unstubAllEnvs());

const connect = (query = "") => app.inject({ method: "GET", url: `/email/connect${query}` });
const stateFrom = async (query = "") => new URL((await connect(query)).json().authorizeUrl).searchParams.get("state")!;
const callback = (state: string, extra = "code=code_1") => app.inject({ method: "GET", url: `/email/callback?${extra}&state=${encodeURIComponent(state)}` });

describe("Gmail OAuth return target", () => {
  it("returns to Settings by default", async () => {
    const response = await callback(await stateFrom());
    expect([response.statusCode, response.headers.location]).toEqual([302, "https://app.example.test/settings?email=connected#email"]);
  });

  it("returns to the onboarding Gmail step when started there, with the same success and error flags", async () => {
    const state = await stateFrom("?returnTo=onboarding");
    expect((await callback(state)).headers.location).toBe("https://app.example.test/onboarding?step=email&email=connected");
    expect((await callback(state, "error=access_denied")).headers.location).toBe("https://app.example.test/onboarding?step=email&email_error=access_denied");
  });

  it("accepts only the allow-listed targets, never a URL", async () => {
    for (const returnTo of ["https://evil.example", "//evil.example", "/dashboard", "ONBOARDING", "dashboard"]) {
      const response = await connect(`?returnTo=${encodeURIComponent(returnTo)}`);
      expect([response.statusCode, response.json()], returnTo).toEqual([400, { error: "invalid_query" }]);
    }
    expect(db.resolveInboxOwner).not.toHaveBeenCalled();
    expect((await connect("?returnTo=settings")).statusCode).toBe(200);
  });

  it("a state whose target was changed fails its signature and goes back to Settings", async () => {
    const [org, owner, , ts, sig] = Buffer.from(await stateFrom(), "base64url").toString().split(".");
    const forged = Buffer.from([org, owner, "onboarding", ts, sig].join(".")).toString("base64url");
    const response = await callback(forged);
    expect(response.headers.location).toBe("https://app.example.test/settings?email_error=invalid_state#email");
    expect(db.connectEmailAccount).not.toHaveBeenCalled();
  });
});

describe("META_ADVANCED_ACCESS_ENABLED", () => {
  it("tells the web through GET /dashboard features, off by default", async () => {
    expect((await app.inject({ method: "GET", url: "/dashboard" })).json().features.instagramOpenAccess).toBe(false);
    vi.stubEnv("META_ADVANCED_ACCESS_ENABLED", "true");
    expect((await app.inject({ method: "GET", url: "/dashboard" })).json().features.instagramOpenAccess).toBe(true);
  });
});
