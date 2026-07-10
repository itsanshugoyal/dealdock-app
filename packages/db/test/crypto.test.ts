import { beforeAll, describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "../src/crypto";

describe("token crypto (AES-256-GCM)", () => {
  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("round-trips a token", () => {
    const token = "IGQVJ-very-secret-long-lived-token";
    const enc = encryptToken(token);
    expect(enc).not.toContain(token);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(decryptToken(enc)).toBe(token);
  });

  it("produces unique ciphertexts per call (random IV)", () => {
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });

  it("rejects tampered ciphertext (auth tag)", () => {
    const enc = encryptToken("token");
    const parts = enc.split(":");
    const data = Buffer.from(parts[3]!, "base64");
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString("base64");
    expect(() => decryptToken(parts.join(":"))).toThrow();
  });

  it("rejects unknown formats", () => {
    expect(() => decryptToken("v2:a:b:c")).toThrow(/unrecognized/);
  });
});
