import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, isAuditAction } from "../src/audit-actions";

describe("audit actions", () => {
  it("lists each action once, as domain.event in snake case", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    for (const action of AUDIT_ACTIONS) expect(action).toMatch(/^[a-z]+(?:_[a-z]+)*\.[a-z]+(?:_[a-z]+)*$/);
  });

  it("recognises what the API writes and nothing else", () => {
    expect(isAuditAction("message.sent")).toBe(true);
    expect(isAuditAction("voice.rule_pinned")).toBe(true);
    expect(isAuditAction("digest.weekly_sent")).toBe(true);
    // Demo-only aliases are not canonical names.
    expect(isAuditAction("deal.closed")).toBe(false);
    expect(isAuditAction("settings.region_updated")).toBe(false);
    expect(isAuditAction("")).toBe(false);
  });
});
