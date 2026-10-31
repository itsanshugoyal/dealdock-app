import { describe, expect, it } from "vitest";
import { can, PERMISSION_ACTIONS, type PermissionAction } from "../src/permissions";
import type { SeatRole } from "../src/index";

/**
 * M4 exit criterion: the seat-limit and role-permission matrix fully covered.
 * Every cell is pinned — changing a permission is a deliberate, reviewed diff.
 */
const EXPECTED: Record<SeatRole, Record<PermissionAction, boolean>> = {
  creator: {
    send: true, review: true, close: true, view_roster: true,
    manage_seats: true, manage_billing: true, manage_settings: true, manage_voice: true, export_data: true,
  },
  assistant: {
    send: true, review: true, close: true, view_roster: false,
    manage_seats: false, manage_billing: false, manage_settings: false, manage_voice: false, export_data: false,
  },
  manager: {
    send: true, review: true, close: true, view_roster: true,
    manage_seats: true, manage_billing: false, manage_settings: false, manage_voice: false, export_data: true,
  },
};

describe("role-permission matrix (PRD §6.10)", () => {
  for (const role of Object.keys(EXPECTED) as SeatRole[]) {
    for (const action of PERMISSION_ACTIONS) {
      it(`${role} ${EXPECTED[role][action] ? "can" : "cannot"} ${action}`, () => {
        expect(can(role, action)).toBe(EXPECTED[role][action]);
      });
    }
  }

  it("assistants can operate the inbox but never administer the org", () => {
    expect(can("assistant", "send")).toBe(true);
    expect(can("assistant", "manage_seats")).toBe(false);
    expect(can("assistant", "manage_billing")).toBe(false);
  });

  it("billing and destructive controls stay with the creator (managers excluded)", () => {
    expect(can("manager", "manage_billing")).toBe(false);
    expect(can("manager", "manage_settings")).toBe(false);
  });

  it("only the creator may record, change or delete their own speaking voice", () => {
    expect(can("creator", "manage_voice")).toBe(true);
    expect(can("assistant", "manage_voice")).toBe(false);
    expect(can("manager", "manage_voice")).toBe(false);
  });

  it("pins every action for every role", () => {
    for (const role of Object.keys(EXPECTED) as SeatRole[]) {
      expect(Object.keys(EXPECTED[role]).sort()).toEqual([...PERMISSION_ACTIONS].sort());
    }
  });
});
