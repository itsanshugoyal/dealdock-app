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
    },
    bodyLimit: 512 * 1024, // webhooks and drafts are small; refuse anything bigger
    trustProxy: true, // PaaS terminates TLS in front of us
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

  app.register(webhookRoutes);
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

  return app;
}

async function main() {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
