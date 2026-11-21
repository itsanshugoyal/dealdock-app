import { afterEach, describe, expect, it, vi } from "vitest";
import { clerkVerifyOptions } from "../src/clerk-claims";

afterEach(() => vi.unstubAllEnvs());

describe("clerkVerifyOptions", () => {
  it("binds production tokens to the one web origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_APP_URL", "https://app.dealdock.io/");
    expect(clerkVerifyOptions("sk")).toEqual({ secretKey: "sk", authorizedParties: ["https://app.dealdock.io"] });
  });

  it("fails closed in production without a valid web origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_APP_URL", "");
    expect(() => clerkVerifyOptions("sk")).toThrow();
  });

  it("leaves development tokens unbound", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WEB_APP_URL", "http://localhost:3100");
    expect(clerkVerifyOptions("sk")).toEqual({ secretKey: "sk" });
  });
});
