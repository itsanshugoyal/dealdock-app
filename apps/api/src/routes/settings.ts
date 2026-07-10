import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { extractStyleCard } from "@dealdock/ai";
import {
  exportOrgArchive,
  getDataSummary,
  getIgnoreList,
  getOrganization,
  getSentSamples,
  getWeeklyMetrics,
  requestAccountDeletion,
  saveStyleCard,
  setIgnoreList,
  setVoiceEnabled,
  updateRegion,
} from "@dealdock/db";
import { requireAuth } from "../auth";
import { requirePermission } from "../guards";

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
  /**
   * Voice re-sample (PRD §6.4): consented sent-DM samples → style card.
   * Triggered at onboarding and on demand from Settings; weekly auto-refresh
   * joins the scheduler in M5 hardening.
   */
  app.post("/settings/voice/resample", { preHandler: requireAuth }, async (req, reply) => {
    const auth = req.auth!;
    const org = await getOrganization(auth.orgId);
    const account = org?.igAccounts[0];
    if (!account) return reply.code(409).send({ error: "no_connected_account" });

    const samples = await getSentSamples(auth.orgId, account.id);
    if (samples === null) return reply.code(409).send({ error: "voice_modeling_disabled" });
    if (samples.length < 3) {
      return reply.code(409).send({
        error: "not_enough_samples",
        hint: "Send a few replies first — voice tuning needs at least 3 sent messages.",
      });
    }

    const result = await extractStyleCard(samples.map((s) => s.text));
    await saveStyleCard(
      auth.orgId,
      account.id,
      result.styleCard,
      samples.map((s) => s.id)
    );
    return { styleCard: result.styleCard, modelVersion: result.modelVersion };
  });

  /** Weekly internal metrics (PRD §7.4) — feeds the founding-team dashboard. */
  app.get("/metrics/weekly", { preHandler: requireAuth }, async (req) => {
    return getWeeklyMetrics(req.auth!.orgId);
  });

  /**
   * Region (PRD §6.11): currency change is confirmed UI-side; historical
   * ledger entries keep their logged currency (ADR-9 — history never rewrites).
   */
  app.put(
    "/settings/region",
    { preHandler: [requireAuth, requirePermission("manage_settings")] },
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
    { preHandler: [requireAuth, requirePermission("manage_settings")] },
    async (req) => {
      const gracePeriodEnds = await requestAccountDeletion(req.auth!.orgId, req.auth!.seatId);
      return {
        scheduled: true,
        gracePeriodEnds,
        hint: "Sign in any time in the next 7 days to cancel deletion.",
      };
    }
  );

  app.get("/settings/ignore-list", { preHandler: requireAuth }, async (req) => {
    return { handles: await getIgnoreList(req.auth!.orgId) };
  });

  app.put(
    "/settings/ignore-list",
    { preHandler: [requireAuth, requirePermission("manage_settings")] },
    async (req, reply) => {
      const parsed = IgnoreListBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      await setIgnoreList(req.auth!.orgId, req.auth!.seatId, parsed.data.handles);
      return { handles: parsed.data.handles };
    }
  );

  /** Voice modeling toggle (PRD §6.11) — classification-only mode when off. */
  app.put(
    "/settings/voice",
    { preHandler: [requireAuth, requirePermission("manage_settings")] },
    async (req, reply) => {
      const { enabled } = (req.body ?? {}) as { enabled?: boolean };
      if (typeof enabled !== "boolean") return reply.code(400).send({ error: "invalid_body" });
      await setVoiceEnabled(req.auth!.orgId, req.auth!.seatId, enabled);
      return { enabled };
    }
  );
}
