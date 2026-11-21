import { describe, expect, it } from "vitest";
import { loggedPath } from "../src/log-path";

describe("loggedPath", () => {
  it("never logs a booking or payment tool's secret address token", () => {
    const token = "Kq3v_Z8-x".repeat(5);
    expect(loggedPath(`/webhooks/leads/${token}`)).toBe("/webhooks/leads/:token");
    expect(loggedPath(`/webhooks/leads/${token}?attempt=2`)).toBe("/webhooks/leads/:token");
    expect(loggedPath(`/webhooks/leads/${token}/extra`)).toBe("/webhooks/leads/:token/extra");
    expect(loggedPath(`/webhooks/leads/${token}#x`)).toBe("/webhooks/leads/:token#x");
  });

  it("keeps every other path, without its query string", () => {
    expect(loggedPath("/threads/t1/draft?purpose=renewal")).toBe("/threads/t1/draft");
    expect(loggedPath("/webhooks/razorpay")).toBe("/webhooks/razorpay");
    expect(loggedPath("/lead-sources/src_1")).toBe("/lead-sources/src_1");
    expect(loggedPath("/inbox")).toBe("/inbox");
  });
});
