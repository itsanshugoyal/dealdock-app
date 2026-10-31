import type { SeatRole } from "./index";

/**
 * Role–permission matrix (PRD §6.10, §5.6). The single source of truth —
 * route guards call can(); the matrix test pins every cell so a permission
 * change is always a deliberate, reviewed diff.
 *
 *  - creator: the org owner. Everything, and the only seat that may record,
 *    change or delete the creator's own speaking voice (manage_voice).
 *  - assistant (Studio): triage operator — send/review/close on the account,
 *    no org administration, no data controls.
 *  - manager (Roster): roster-wide triage + seat/report administration,
 *    but billing and destructive data controls stay with the creator.
 */

export const PERMISSION_ACTIONS = [
  "send",
  "review",
  "close",
  "view_roster",
  "manage_seats",
  "manage_billing",
  "manage_settings",
  "manage_voice",
  "export_data",
] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

const MATRIX: Record<SeatRole, Record<PermissionAction, boolean>> = {
  creator: {
    send: true,
    review: true,
    close: true,
    view_roster: true,
    manage_seats: true,
    manage_billing: true,
    manage_settings: true,
    manage_voice: true,
    export_data: true,
  },
  assistant: {
    send: true,
    review: true,
    close: true,
    view_roster: false,
    manage_seats: false,
    manage_billing: false,
    manage_settings: false,
    manage_voice: false,
    export_data: false,
  },
  manager: {
    send: true,
    review: true,
    close: true,
    view_roster: true,
    manage_seats: true,
    manage_billing: false,
    manage_settings: false,
    manage_voice: false,
    export_data: true,
  },
};

export function can(role: SeatRole, action: PermissionAction): boolean {
  return MATRIX[role][action];
}
