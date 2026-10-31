import type { FastifyInstance } from "fastify";

import { MinorUnits, type LeakScanSummary } from "@dealdock/core";
import { enqueueVoiceRefresh, getLeakScanSummary, getOnboardingProfile, isOnboardingComplete, markLeakScanStarted, setIgnoreList, setVoiceConsent, upsertOnboardingProfile } from "@dealdock/db";
import { z } from "zod";

import { requireAuth } from "../auth";
import { AccountRef, IgAccountId, requireIgAccount, requirePermission, requireWritable } from "../guards";
import { scheduleLeakScan } from "../graph-maintenance";

/** A typical price range in minor units of the org currency; null means not given. */
const TypicalRange = z
  .object({ min: MinorUnits, max: MinorUnits })
  .refine((range) => range.min <= range.max, "The lowest price cannot exceed the highest.")
  .nullable()
  .optional();

const OnboardingBody = z.object({
  // Free-form answers, except the price ranges every prompt reads as money.
  businessContext: z
    .object({ typicalBrandDealMinor: TypicalRange, typicalCoachingMinor: TypicalRange, typicalCourseMinor: TypicalRange })
    .catchall(z.unknown())
    .refine((value) => Object.keys(value).length > 0, "business context is required"),
  currencyCode: z.enum(["INR", "USD", "GBP", "EUR", "AED"]),
  locale: z.string().min(2).max(20),
  timezone: z.string().min(3).max(50),
  ignoreHandles: z.array(z.string().min(1).max(80)).max(200).optional(),
  voiceConsent: z.boolean().optional(),
  igAccountId: IgAccountId.optional(),
});

export async function onboardingRoutes(app: FastifyInstance) {
  app.get("/onboarding", { preHandler: requireAuth }, async (req, reply) => {
    const profile = await getOnboardingProfile(req.auth!.orgId);
    if (!profile) return reply.code(404).send({ error: "org_not_found" });
    return profile;
  });

  /** Business context, explicit voice consent and ignore list are saved before any scan. */
  app.put("/onboarding", { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] }, async (req, reply) => {
    const parsed = OnboardingBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const auth = req.auth!;
    try {
      const org = await upsertOnboardingProfile(auth.orgId, auth.seatId, parsed.data);
      if (parsed.data.ignoreHandles) await setIgnoreList(auth.orgId, auth.seatId, parsed.data.ignoreHandles);
      if (typeof parsed.data.voiceConsent === "boolean") {
        // An explicit id must be this org's (404 otherwise); the default is the first active account.
        const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
        if (!account) return reply;
        await setVoiceConsent(auth.orgId, account.id, auth.seatId, parsed.data.voiceConsent);
        // Read their style right away, so the voice step has a card without a manual click.
        if (parsed.data.voiceConsent) await enqueueVoiceRefresh(auth.orgId, account.id, { reason: "consent" });
      }
      return { currencyCode: org.currencyCode, locale: org.locale, timezone: org.timezone, complete: await isOnboardingComplete(auth.orgId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "onboarding_save_failed";
      if (message === "currency_immutable_for_organization") return reply.code(409).send({ error: message, hint: "Currency is chosen when the organisation is created and cannot reinterpret historic money." });
      throw error;
    }
  });

  /**
   * Leak Scan trigger (PRD §5.1.6): backfills the last 30 days of history
   * through the SAME ingestion→classification pipeline, tagged source=leak_scan
   * (batch mode of ARCHITECTURE.md §5.1 — no separate code path, no drafts).
   */
  app.post("/onboarding/leak-scan", { preHandler: [requireAuth, requireWritable, requirePermission("manage_settings")] }, async (req, reply) => {
    const parsed = AccountRef.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const auth = req.auth!;
    const account = await requireIgAccount(auth.orgId, parsed.data.igAccountId, reply);
    if (!account) return reply;
    // Marked before the job can run, so the reveal reads "running" until the job marks it complete.
    await markLeakScanStarted(auth.orgId, account.id);
    // The scan job re-reads the voice once the scanned history has settled (graph-maintenance.ts).
    await scheduleLeakScan(auth.orgId, account.id);
    return reply.code(202).send({ scheduled: true, enqueued: 0 });
  });

  /** Poll for the reveal numbers while the batch classifies; `status` says when they are final. */
  app.get("/onboarding/leak-scan", { preHandler: requireAuth }, async (req) => {
    return (await getLeakScanSummary(req.auth!.orgId)) satisfies LeakScanSummary;
  });
}
