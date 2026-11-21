import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  IG_INSIGHTS_SCOPE,
  INSIGHT_METRICS,
  InstagramGraphAdapter,
  MOCK_INSIGHTS,
  MockInstagramAdapter,
  postShortcode,
  TokenExpiredError,
  type ConnectedAccount,
} from "../src/index";

const ACCOUNT: ConnectedAccount = { accountId: "acc-1", platformUserId: "17841400000000", handle: "demo.creator", accessToken: "IGQVJ-token" };
const media = (id: string, shortcode: string, type = "VIDEO") => ({ id, permalink: `https://www.instagram.com/reel/${shortcode}/`, timestamp: "2026-10-30T12:00:00+0000", media_type: type });

function graph(pages: Array<Array<ReturnType<typeof media>>>, insights: unknown = { data: [] }) {
  const calls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const href = String(url);
    calls.push(href);
    const page = /after=(\d+)/.exec(href);
    const index = page ? Number(page[1]) : 0;
    const body = href.includes("/insights")
      ? insights
      : { data: pages[index] ?? [], paging: index + 1 < pages.length ? { next: `https://graph.instagram.com/v25.0/me/media?after=${index + 1}` } : {} };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { adapter: new InstagramGraphAdapter({ appSecret: "s", fetchImpl }), calls };
}

describe("post links", () => {
  it("reads the shortcode from reel, post and tv links, with or without the handle", () => {
    expect(postShortcode("https://www.instagram.com/reel/Cx1AbC_9/")).toBe("Cx1AbC_9");
    expect(postShortcode("https://instagram.com/p/Cx1AbC9?igsh=abc")).toBe("Cx1AbC9");
    expect(postShortcode("https://www.instagram.com/diya.moves/reel/Cx1AbC9/")).toBe("Cx1AbC9");
    for (const link of ["http://www.instagram.com/reel/Cx1AbC9/", "https://evil.example/reel/Cx1AbC9/", "https://www.instagram.com/stories/diya/123/", "not a url"]) {
      expect(postShortcode(link), link).toBeNull();
    }
  });
});

describe("Instagram media insights", () => {
  const insights = { data: [
    { name: "views", values: [{ value: 12_400 }] },
    { name: "reach", values: [{ value: 9_800 }] },
    { name: "likes", total_value: { value: 1_130 } },
    { name: "comments", values: [{ value: 84 }] },
    { name: "saved", values: [{ value: 210 }] },
    { name: "shares", values: [{ value: -1 }] },
  ] };

  it("finds the post by its link a few pages back and reads its lifetime results", async () => {
    const { adapter, calls } = graph([[media("111", "AAAAA")], [media("222", "BBBBB"), media("333", "Cx1AbC9")]], insights);
    const result = await adapter.getMediaInsights(ACCOUNT, "https://www.instagram.com/reel/Cx1AbC9/?igsh=x");
    expect(result).toEqual({
      mediaId: "333", permalink: "https://www.instagram.com/reel/Cx1AbC9/", mediaType: "VIDEO", postedAt: "2026-10-30T12:00:00.000Z",
      // `saved` is saves; a number Instagram can't have sent (negative) reads as none.
      metrics: { views: 12_400, reach: 9_800, likes: 1_130, comments: 84, shares: null, saves: 210 },
    });
    expect(calls[0]).toContain("/me/media?fields=id%2Cpermalink%2Ctimestamp%2Cmedia_type");
    expect(calls.at(-1)).toContain(`/333/insights?metric=${encodeURIComponent(INSIGHT_METRICS.join(","))}`);
    // Never the deprecated metrics.
    expect(INSIGHT_METRICS.join(",")).not.toMatch(/impressions|plays|video_views/);
  });

  it("gives up after a few pages, and never builds a path from a link it can't read", async () => {
    const pages = Array.from({ length: 8 }, (_, i) => [media(String(100 + i), `POST${i}X`)]);
    const { adapter, calls } = graph(pages);
    expect(await adapter.getMediaInsights(ACCOUNT, "https://www.instagram.com/reel/POST7X/")).toBeNull();
    expect(calls).toHaveLength(4);
    const unread = graph(pages);
    expect(await unread.adapter.getMediaInsights(ACCOUNT, "https://www.instagram.com/stories/x/1/")).toBeNull();
    expect(unread.calls).toHaveLength(0);
  });

  it("asks to reconnect when the token is gone", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 190, message: "expired" } }), { status: 400 })) as typeof fetch;
    await expect(new InstagramGraphAdapter({ fetchImpl }).getMediaInsights(ACCOUNT, "https://www.instagram.com/reel/Cx1AbC9/")).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("gives fixed results in the mock", async () => {
    expect((await new MockInstagramAdapter().getMediaInsights(ACCOUNT, "https://www.instagram.com/reel/Cx1AbC9/"))?.metrics).toEqual(MOCK_INSIGHTS);
    expect(await new MockInstagramAdapter().getMediaInsights(ACCOUNT, "https://example.com/x")).toBeNull();
  });

  it("asks for the insights permission only when it is turned on", () => {
    const scopes = (extra?: string[]) => new URL(buildAuthorizeUrl({ appId: "a", redirectUri: "https://api.example/ig/callback" }, "s", extra)).searchParams.get("scope");
    expect(scopes()).not.toContain(IG_INSIGHTS_SCOPE);
    expect(scopes([IG_INSIGHTS_SCOPE])).toContain("instagram_business_manage_insights");
  });
});
