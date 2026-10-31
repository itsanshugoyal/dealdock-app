import { describe, expect, it } from "vitest";
import { DomainError, isDomainError } from "../src/errors";

describe("DomainError", () => {
  it("carries a machine code and the HTTP status to answer with", () => {
    const error = new DomainError("voice_rule_not_found", 404);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DomainError");
    expect(error.code).toBe("voice_rule_not_found");
    expect(error.status).toBe(404);
    expect(error.message).toBe("voice_rule_not_found");
    expect(new DomainError("send_in_flight", 409, "A send is already in progress.").message).toBe("A send is already in progress.");
  });

  it("is recognised by instance or by shape, and nothing else is", () => {
    expect(isDomainError(new DomainError("conflict", 409))).toBe(true);
    // Another copy of the class (a second bundle of this package) still counts.
    const foreign = Object.assign(new Error("conflict"), { name: "DomainError", code: "conflict", status: 409 });
    expect(isDomainError(foreign)).toBe(true);
    expect(isDomainError(Object.assign(new Error("x"), { name: "DomainError", code: "x" }))).toBe(false);
    expect(isDomainError(Object.assign(new Error("not_found"), { statusCode: 404 }))).toBe(false);
    expect(isDomainError({ name: "DomainError", code: "x", status: 400 })).toBe(false);
    expect(isDomainError(null)).toBe(false);
    expect(isDomainError("conflict")).toBe(false);
  });
});
