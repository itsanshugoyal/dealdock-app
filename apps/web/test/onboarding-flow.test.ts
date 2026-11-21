import { afterEach, describe, expect, it, vi } from "vitest";
import { featureFlags } from "@dealdock/core";
import { connectChecklist, flowSteps, friendlyConnectError, nextStep, progressSteps, shouldRedirectToSetup, stepFromQuery, type FlowContext, type Step } from "../src/lib/onboarding-flow";
import { demoStore } from "../src/lib/demo-store";
import { ApiStore } from "../src/lib/api-store";

/** Every step from welcome to the end, following nextStep. */
const walk = (context: FlowContext) => {
  const seen: Step[] = ["welcome"];
  for (let step: Step = "welcome"; nextStep(step, context) !== step;) seen.push((step = nextStep(step, context)));
  return seen;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("onboarding steps", () => {
  it("with Instagram and Gmail: the Gmail step follows Instagram, and the scan ends on the reveal", () => {
    const context = { instagram: true, gmail: true };
    expect(walk(context)).toEqual(["welcome", "region", "connect", "email", "business", "voice", "scan", "reveal"]);
    expect(progressSteps(context).map((item) => item.label)).toEqual(["Region", "Instagram", "Email", "Business", "Voice", "Scan"]);
  });

  it("without Gmail on this deployment the Gmail step never appears, and a stray visit moves on", () => {
    const context = { instagram: true, gmail: false };
    expect(walk(context)).toEqual(["welcome", "region", "connect", "business", "voice", "scan", "reveal"]);
    expect(progressSteps(context).map((item) => item.label)).toEqual(["Region", "Instagram", "Business", "Voice", "Scan"]);
    expect(nextStep("email", context)).toBe("business");
  });

  it("connecting Instagram later skips Gmail, voice and the scan, and ends on You're set up", () => {
    for (const gmail of [true, false]) {
      const context = { instagram: false, gmail };
      expect(walk(context)).toEqual(["welcome", "region", "connect", "business", "done"]);
      expect(progressSteps(context).map((item) => item.label)).toEqual(["Region", "Instagram", "Business"]);
      expect(flowSteps(context)).not.toContain("email");
    }
  });

  it("Instagram's callback, which only says connected or error, lands on the Connect step", () => {
    expect(stepFromQuery(null, true)).toBe("connect");
    expect(stepFromQuery(null, false)).toBe("welcome");
    expect(stepFromQuery("nonsense", false)).toBe("welcome");
    expect(stepFromQuery("email", true)).toBe("email");
    expect(stepFromQuery("done", false)).toBe("done");
  });
});

describe("pilot Instagram guidance (instagramOpenAccess)", () => {
  it("off: a three-item checklist with the tester steps and the address as text", () => {
    const items = connectChecklist(false);
    expect(items.map((item) => item.title)).toEqual(["A Creator or Business account", "We add you as a tester", "Accept the invite"]);
    expect(items[1]!.body).toContain("hello@dealdock.io");
    expect(items[2]!.body).toContain("Tester invites");
  });

  it("on: no tester content at all", () => {
    expect(connectChecklist(true)).toEqual([]);
  });

  it("is off by default in demo mode and comes from GET /dashboard otherwise", async () => {
    expect(demoStore.getSnapshot().features.instagramOpenAccess).toBe(false);
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.test");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const { pathname } = new URL(url);
      if (pathname === "/dashboard") return Response.json({ org: { currencyCode: "INR", locale: "en-IN" }, mtdRecoveredMinor: 0, biggestMinor: 0, avgMinor: 0, mtdDealCount: 0, features: { ...featureFlags({}), instagramOpenAccess: true } });
      if (pathname === "/onboarding") return Response.json({ complete: true });
      return Response.json({ rows: [], entries: [] });
    }));
    const store = new ApiStore();
    store.authenticate("actor", async () => "actor");
    await vi.waitFor(() => expect(store.getSnapshot().state).toBe("ready"));
    expect(store.getSnapshot().features.instagramOpenAccess).toBe(true);
  });
});

describe("Instagram connection errors", () => {
  it("explain an unconfigured Meta app and an empty share, and keep the existing cases", () => {
    expect(friendlyConnectError("meta_app_not_configured")).toBe("Instagram connections open soon. You can finish setup and connect later.");
    expect(friendlyConnectError("no_instagram_account")).toBe("No Instagram account was shared. Reconnect and choose your professional account.");
    expect(friendlyConnectError("ig_account_limit")).toMatch(/plan.s Instagram accounts are all connected/);
    expect(friendlyConnectError("invalid_state_or_code")).toBe("That connection link expired. Start again here.");
    expect(friendlyConnectError("personal_account")).toMatch(/personal account/);
    expect(friendlyConnectError("access_denied")).toMatch(/didn't give access/);
    expect(friendlyConnectError("instagram_connection_failed")).toBe("Instagram didn't finish connecting. Try again.");
  });
});

describe("new users go to onboarding", () => {
  it("redirects only a signed-in person with no workspace, outside onboarding, sign-in and Settings", () => {
    expect(shouldRedirectToSetup({ demo: false, setupNeeded: true, pathname: "/" })).toBe(true);
    expect(shouldRedirectToSetup({ demo: false, setupNeeded: true, pathname: "/inbox" })).toBe(true);
    expect(shouldRedirectToSetup({ demo: false, setupNeeded: false, pathname: "/" })).toBe(false);
    expect(shouldRedirectToSetup({ demo: true, setupNeeded: true, pathname: "/" })).toBe(false);
    for (const pathname of ["/onboarding", "/sign-in", "/sign-in/sso-callback", "/sign-up", "/settings"]) {
      expect(shouldRedirectToSetup({ demo: false, setupNeeded: true, pathname }), pathname).toBe(false);
    }
  });
});

describe("Gmail from onboarding", () => {
  it("the demo consent screen returns to the onboarding Gmail step; Settings keeps its own return", async () => {
    expect(await demoStore.connectEmail("ig-demo-rohan", "onboarding")).toEqual({ authorizeUrl: "/onboarding?step=email&email=connected" });
    expect(await demoStore.connectEmail("ig-demo-rohan")).toEqual({ authorizeUrl: "/settings?email=connected#email" });
  });
});
