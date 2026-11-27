import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/index";

const app = buildServer();
afterAll(() => app.close());

describe("the API stays out of search engines", () => {
  it("serves a robots.txt that disallows everything", async () => {
    const response = await app.inject({ method: "GET", url: "/robots.txt" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toBe("User-agent: *\nDisallow: /\n");
  });

  it("marks every response noindex, errors included", async () => {
    for (const url of ["/health", "/does-not-exist"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    }
  });
});
