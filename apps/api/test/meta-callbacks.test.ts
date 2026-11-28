import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@dealdock/db";
import { buildServer } from "../src/index";
import { parseSignedRequest } from "../src/routes/meta-callbacks";

// The HTTP layer only: repositories and the queue are stubbed.
vi.mock("@dealdock/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dealdock/db")>()),
  deauthorizeMetaUser: vi.fn(async () => 1),
  createMetaDeletionRequest: vi.fn(async () => ({ id: "req_1", confirmationCode: "a".repeat(32) })),
  getMetaDeletionStatus: vi.fn(async () => null),
}));
const queueAdd = vi.fn(async () => ({}));
vi.mock("../src/queues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/queues")>()),
  getRetentionQueue: () => ({ add: queueAdd }),
}));

const SECRET = "meta-app-secret";
const sign = (payload: object, secret = SECRET) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${createHmac("sha256", secret).update(body).digest("base64url")}.${body}`;
};
const valid = sign({ algorithm: "HMAC-SHA256", issued_at: 1795800000, user_id: "17841400000009" });
const form = (signed: string) => ({ headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ signed_request: signed }).toString() });

const app = buildServer();
app.log.level = "silent";
const env = { secret: process.env.META_APP_SECRET, api: process.env.PUBLIC_API_URL };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.META_APP_SECRET = SECRET;
  process.env.PUBLIC_API_URL = "https://api.dealdock.io";
});
afterAll(() => {
  process.env.META_APP_SECRET = env.secret;
  process.env.PUBLIC_API_URL = env.api;
});

describe("parseSignedRequest", () => {
  it("returns the user id only for a request signed with the app secret", () => {
    expect(parseSignedRequest(valid, SECRET)).toBe("17841400000009");
    expect(parseSignedRequest(valid, "other-secret")).toBeNull();
    expect(parseSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: "1" }, "other-secret"), SECRET)).toBeNull();
    const [sig, body] = valid.split(".");
    const tampered = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "999" })).toString("base64url");
    expect(parseSignedRequest(`${sig}.${tampered}`, SECRET)).toBeNull();
    expect(parseSignedRequest(`${sig}.${body}.extra`, SECRET)).toBeNull();
    expect(parseSignedRequest(sign({ algorithm: "none", user_id: "1" }), SECRET)).toBeNull();
    expect(parseSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: "not-a-number" }), SECRET)).toBeNull();
    expect(parseSignedRequest("garbage", SECRET)).toBeNull();
    expect(parseSignedRequest(valid, "")).toBeNull();
  });
});

describe("POST /meta/deauthorize", () => {
  it("disconnects the signed user's accounts", async () => {
    const res = await app.inject({ method: "POST", url: "/meta/deauthorize", ...form(valid) });
    expect(res.statusCode).toBe(200);
    expect(db.deauthorizeMetaUser).toHaveBeenCalledWith("17841400000009");
  });

  it("refuses unsigned or forged requests without touching data", async () => {
    for (const signed of ["", "a.b", sign({ algorithm: "HMAC-SHA256", user_id: "1" }, "forged")]) {
      const res = await app.inject({ method: "POST", url: "/meta/deauthorize", ...form(signed) });
      expect(res.statusCode).toBe(400);
    }
    expect(db.deauthorizeMetaUser).not.toHaveBeenCalled();
  });

  it("answers 503 when the Meta app isn't configured", async () => {
    delete process.env.META_APP_SECRET;
    const res = await app.inject({ method: "POST", url: "/meta/deauthorize", ...form(valid) });
    expect(res.statusCode).toBe(503);
    expect(db.deauthorizeMetaUser).not.toHaveBeenCalled();
  });
});

describe("POST /meta/data-deletion", () => {
  it("disconnects, records the request, starts the worker and answers Meta's url + confirmation_code", async () => {
    const res = await app.inject({ method: "POST", url: "/meta/data-deletion", ...form(valid) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      url: `https://api.dealdock.io/meta/data-deletion/status?code=${"a".repeat(32)}`,
      confirmation_code: "a".repeat(32),
    });
    expect(db.deauthorizeMetaUser).toHaveBeenCalledWith("17841400000009");
    expect(db.createMetaDeletionRequest).toHaveBeenCalledWith("17841400000009");
    expect(queueAdd).toHaveBeenCalledOnce();
  });

  it("still answers when the queue is down (the daily tick runs it)", async () => {
    queueAdd.mockRejectedValueOnce(new Error("redis down"));
    const res = await app.inject({ method: "POST", url: "/meta/data-deletion", ...form(valid) });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a forged request", async () => {
    const res = await app.inject({ method: "POST", url: "/meta/data-deletion", ...form(sign({ algorithm: "HMAC-SHA256", user_id: "1" }, "forged")) });
    expect(res.statusCode).toBe(400);
    expect(db.createMetaDeletionRequest).not.toHaveBeenCalled();
  });
});

describe("GET /meta/data-deletion/status", () => {
  it("shows pending and completed requests, and 404 for unknown or malformed codes", async () => {
    vi.mocked(db.getMetaDeletionStatus).mockResolvedValueOnce({ status: "pending", createdAt: new Date("2026-11-28T00:00:00Z"), completedAt: null });
    const pending = await app.inject({ method: "GET", url: `/meta/data-deletion/status?code=${"b".repeat(32)}` });
    expect(pending.statusCode).toBe(200);
    expect(pending.headers["content-type"]).toContain("text/html");
    expect(pending.body).toContain("Deletion in progress");

    vi.mocked(db.getMetaDeletionStatus).mockResolvedValueOnce({ status: "completed", createdAt: new Date("2026-11-28T00:00:00Z"), completedAt: new Date("2026-11-28T01:00:00Z") });
    const done = await app.inject({ method: "GET", url: `/meta/data-deletion/status?code=${"b".repeat(32)}` });
    expect(done.body).toContain("Your data has been deleted");
    expect(done.body).toContain("28 November 2026");

    expect((await app.inject({ method: "GET", url: `/meta/data-deletion/status?code=${"c".repeat(32)}` })).statusCode).toBe(404);
    const malformed = await app.inject({ method: "GET", url: "/meta/data-deletion/status?code=<script>" });
    expect(malformed.statusCode).toBe(404);
    expect(malformed.body).not.toContain("<script>");
    expect(db.getMetaDeletionStatus).toHaveBeenCalledTimes(3);
  });
});
