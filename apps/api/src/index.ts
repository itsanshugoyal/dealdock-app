import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { inboxRoutes } from "./routes/inbox";
import { webhookRoutes } from "./routes/webhooks";
import { threadRoutes } from "./routes/threads";
import { reviewRoutes } from "./routes/review";
import { ledgerRoutes } from "./routes/ledger";
import { onboardingRoutes } from "./routes/onboarding";
import { settingsRoutes } from "./routes/settings";
import { igRoutes } from "./routes/ig";
import { billingRoutes } from "./routes/billing";
import { seatRoutes } from "./routes/seats";
import { rosterRoutes } from "./routes/roster";
import { notificationRoutes } from "./routes/notifications";
import { threadDetailRoutes } from "./routes/thread-detail";
import { offerRoutes } from "./routes/offers";
import { insightRoutes } from "./routes/insights";
import { auditRoutes } from "./routes/audit";
import { speakingRoutes } from "./routes/speaking";
import { mediaRoutes } from "./routes/media";
import { voiceRoutes } from "./routes/voice";
import { draftingRoutes } from "./routes/drafting";
import { startGraphMaintenance } from "./graph-maintenance";
import { isDomainError } from "@dealdock/core";
import { checkDatabaseReadiness } from "@dealdock/db";
import { getIngestionQueue } from "./queues";
import { bootstrapRoutes } from "./routes/bootstrap";

/**
 * apps/api — REST API, webhook receivers, and THE SEND GATE (M1).
 * Invariant (ARCHITECTURE.md §6.2): sending messages exists ONLY here, behind
 * an authenticated human actor. The worker never gets send capability.
 */
export function buildServer() {
  const app = Fastify({
    logger: {
      // DM content never enters logs (ARCHITECTURE.md §8).
      redact: { paths: ["req.body", "req.headers.authorization"], remove: true },
      serializers: { req: (request: {method:string;url:string}) => ({method:request.method,url:request.url.split("?")[0]}) },
    },
    bodyLimit: 512 * 1024, // webhooks and drafts are small; refuse anything bigger
    trustProxy: (_address, hop) => hop === 0, // trust one PaaS ingress hop only
  });

  // M5 hardening: CORS locked to the web app, standard security headers,
  // and a per-IP rate limit (per-account Graph budgets live in the adapter).
  app.register(cors, {
    origin: process.env.WEB_APP_URL ?? "http://localhost:3100",
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  });
  app.register(helmet, { global: true });
  app.register(rateLimit, {
    max: 300, // per IP per minute — generous for triage, hostile to scripts
    timeWindow: "1 minute",
    allowList: (req) => req.url.startsWith("/webhooks/"), // Meta/rails retry storms must not 429
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "dealdock-api",
    ts: new Date().toISOString(),
  }));

  app.get("/ready", async (_req, reply) => {
    try {
      await Promise.all([checkDatabaseReadiness(), getIngestionQueue().getJobCounts("waiting")]);
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.setErrorHandler((error, _req, reply) => {
    // Repository errors carry their own status and code. A 404 never says
    // what was missing, and a server fault never shows its code.
    if (isDomainError(error)) {
      const code = error.status === 404 ? "not_found" : error.status >= 500 ? "request_failed" : error.code;
      return reply.code(error.status).send({ error: code });
    }
    // Legacy errors without a DomainError are still mapped by their message.
    const message = error instanceof Error ? error.message : "request_failed";
    if (/not in org|not_in_org|not_found/.test(message)) return reply.code(404).send({ error: "not_found" });
    if (/conflict|immutable|consent_required|already_claimed|send_in_flight/.test(message)) return reply.code(409).send({ error: message });
    const statusCode = (error as {statusCode?:number}).statusCode;
    const status = typeof statusCode === "number" ? statusCode : 500;
    return reply.code(status).send({ error: status === 500 ? "request_failed" : message });
  });

  app.register(webhookRoutes);
  app.register(bootstrapRoutes);
  app.register(inboxRoutes);
  app.register(threadRoutes);
  app.register(reviewRoutes);
  app.register(ledgerRoutes);
  app.register(onboardingRoutes);
  app.register(settingsRoutes);
  app.register(igRoutes);
  app.register(billingRoutes);
  app.register(seatRoutes);
  app.register(rosterRoutes);
  app.register(notificationRoutes);
  app.register(threadDetailRoutes);
  app.register(offerRoutes);
  app.register(insightRoutes);
  app.register(auditRoutes);
  app.register(speakingRoutes);
  app.register(mediaRoutes);
  app.register(voiceRoutes);
  app.register(draftingRoutes);

  return app;
}

async function main() {
  const app = buildServer();
  const graphMaintenance = startGraphMaintenance();
  app.addHook("onClose", async () => graphMaintenance.close());
  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
