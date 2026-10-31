// Must stay the first import: refuses API-only secrets before any consumer loads.
import "./refuse-api-secrets";
import { QUEUES } from "@dealdock/core";
import { startIngestionWorker } from "./consumers/ingestion";
import { startClassificationWorker } from "./consumers/classification";
import { startDraftingWorker } from "./consumers/drafting";
import { startNudgeScheduler } from "./consumers/nudges";
import { startBillingScheduler } from "./consumers/billing";
import { startNotificationWorker, startWeeklyDigestScheduler } from "./consumers/notifications";
import { startRetentionScheduler } from "./consumers/retention";
import { startOutboxDispatcher } from "./consumers/outbox";
import { startVoiceLearningWorker } from "./consumers/voice-learning";

/**
 * apps/worker — BullMQ consumers: ingestion (live), classification/drafting/
 * backfill/nudges/notifications/billing/retention land per PLAN.md milestones.
 *
 * Invariant (ARCHITECTURE.md §6.2): this process holds NO send capability —
 * CI's boundary check (scripts/check-boundaries.mjs) enforces it.
 */
async function main() {
  if (!process.env.REDIS_URL) {
    console.error("REDIS_URL is required");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const workers = [
    startIngestionWorker(),
    startClassificationWorker(),
    startDraftingWorker(),
    startNudgeScheduler(),
    startBillingScheduler(),
    startNotificationWorker(),
    startWeeklyDigestScheduler(),
    startRetentionScheduler(),
    startOutboxDispatcher(),
    startVoiceLearningWorker(),
  ];
  console.log(
    `dealdock-worker up — consuming: ${QUEUES.ingestion}, ${QUEUES.classification}, ${QUEUES.drafting}. Registered queues: ${Object.values(QUEUES).join(", ")}`
  );

  const shutdown = async () => {
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
