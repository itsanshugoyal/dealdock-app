import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  cancelAccountDeletion,
  exportOrgArchive,
  getDataSummary,
  getIgnoreList,
  getOrgSettings,
  getWeeklyMetrics,
  requestAccountDeletion,
  setIgnoreList,
  setMonthlyGoal,
  updateRegion,
} from "@dealdock/db";
import { listSpeakingVoicesToRevoke } from "@dealdock/db";
import { requireAuth } from "../auth";
import { isHumanAgentEnabled, isSpeechConfigured } from "../feature-flags";
import { revokeSpeakingVoiceFully } from "./speaking";
import { requirePermission, requireWritable } from "../guards";

const GoalBody = z.object({
  monthlyGoalMinor: z.number().int().positive().safe().nullable(),
});

const RegionBody = z.object({
  currencyCode: z.enum(["INR", "USD", "GBP", "EUR", "AED"]).optional(),
  locale: z.string().max(20).optional(),
  timezone: z.string().max(50).optional(),
  nudgeDelayDays: z.number().int().min(1).max(14).optional(),
});

const IgnoreListBody = z.object({
  handles: z.array(z.string().min(1).max(80)).max(200),
});

export async function settingsRoutes(app: FastifyInstance) {
  /** Single settings read model for the PWA; no caller may select another org. */
  app.get("/settings", { preHandler: requireAuth }, async (req, reply) => {
    // One organization read (region, goal, tier, deletion, accounts with their voice consent).
    const settings = await getOrgSettings(req.auth!.orgId);
    if (!settings) return reply.code(404).send({ error: "org_not_found" });
    return { ...settings, humanAgentEnabled: isHumanAgentEnabled(), speechAvailable: isSpeechConfigured() };
  });

  /** Monthly confirmed-revenue goal for the Revenue goal ring; null clears it. */
  app.put("/settings/goal", { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] }, async (req, reply) => {
    const parsed = GoalBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    return setMonthlyGoal(req.auth!.orgId, req.auth!.seatId, parsed.data.monthlyGoalMinor);
  });

  // PUT /settings/voice/consent lives in ./voice (refreshing the style is POST /voice/refresh).

  /** Weekly internal metrics (PRD §7.4) — feeds the founding-team dashboard. */
  app.get("/metrics/weekly", { preHandler: requireAuth }, async (req) => {
    return getWeeklyMetrics(req.auth!.orgId);
  });

  /**
   * Region preferences: locale/timezone may change; organization currency is
   * frozen and every persisted monetary value retains that denomination.
   */
  app.put(
    "/settings/region",
    { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] },
    async (req, reply) => {
      const parsed = RegionBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const org = await updateRegion(req.auth!.orgId, req.auth!.seatId, parsed.data);
      return {
        currencyCode: org.currencyCode,
        locale: org.locale,
        timezone: org.timezone,
        nudgeDelayDays: org.nudgeDelayDays,
      };
    }
  );

  /** "View what data DealDock has stored" (PRD §6.11) — honest counts. */
  app.get("/settings/data", { preHandler: requireAuth }, async (req) => {
    return getDataSummary(req.auth!.orgId);
  });

  /** Full archive export — works even post-cancellation (PRD §5.7). */
  app.post(
    "/settings/export",
    { preHandler: [requireAuth, requirePermission("export_data")] },
    async (req, reply) => {
      const archive = await exportOrgArchive(req.auth!.orgId);
      reply.header("content-type", "application/json");
      reply.header(
        "content-disposition",
        `attachment; filename="dealdock-export-${new Date().toISOString().slice(0, 10)}.json"`
      );
      return archive;
    }
  );

  /** Delete account: 7-day grace, then the retention job hard-deletes (PRD §6.11). */
  app.delete(
    "/account",
    { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] },
    async (req) => {
      // Cloned voices go first: the vendor copy lives outside our database, so
      // the hard-delete cascade cannot reach it. Best effort; logs carry no content.
      for (const { igAccountId } of await listSpeakingVoicesToRevoke(req.auth!.orgId)) {
        await revokeSpeakingVoiceFully(req.auth!.orgId, igAccountId, req.auth!.seatId, req.log).catch(() =>
          req.log.warn({ igAccountId }, "speaking voice revocation failed during account deletion")
        );
      }
      const gracePeriodEnds = await requestAccountDeletion(req.auth!.orgId, req.auth!.seatId);
      return {
        scheduled: true,
        gracePeriodEnds,
        hint: "Sign in any time in the next 7 days to cancel deletion.",
      };
    }
  );

  app.post(
    "/account/cancel-deletion",
    { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] },
    async (req) => cancelAccountDeletion(req.auth!.orgId, req.auth!.seatId)
  );

  app.get("/settings/ignore-list", { preHandler: requireAuth }, async (req) => {
    return { handles: await getIgnoreList(req.auth!.orgId) };
  });

  app.put(
    "/settings/ignore-list",
    { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] },
    async (req, reply) => {
      const parsed = IgnoreListBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      await setIgnoreList(req.auth!.orgId, req.auth!.seatId, parsed.data.handles);
      return { handles: parsed.data.handles };
    }
  );
}
