import { Queue } from "bullmq";
import { QUEUES, type IngestionJob } from "@dealdock/core";
import { asOrgId, countClassifications, findDemoBootstrap, getIngestionLagsMs } from "@dealdock/db";
import { redisConnection } from "./connection";

/**
 * M5 load harness (PLAN.md): synthetic DM storm → measure the PRD §7.3 budget
 * "new DM → visible in Revenue Inbox < 60s" at p50/p95.
 *
 * Scale via LOAD_N:
 *   CI integration job:   LOAD_N=2000  (fast signal every push)
 *   Full pilot-scale run: LOAD_N=25000 (50 creators × 500 DMs/day peak)
 * Requires: Postgres + Redis up, worker running, demo org seeded.
 * Exits non-zero if p95 ingestion→classified lag exceeds 60s.
 */
const LOAD_N = Number(process.env.LOAD_N ?? 2000);
const BUDGET_MS = 60_000;

const HINGLISH_SAMPLES = [
  "Bhai paid collab karna hai, budget hai hamare paas. Rates batao?",
  "Aapke program ke baare mein poochna tha, serious hoon main.",
  "Course ki next batch kab hai? EMI chalega kya?",
  "Love your content!! 🔥",
  "Hum ek brand hain, campaign ke liye baat karni hai.",
  "Follow for follow? Check our page!!",
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

async function main() {
  const bootstrap = await findDemoBootstrap();
  if (!bootstrap) {
    console.error("Demo org not found — run db:seed first.");
    process.exit(1);
  }
  const { org, igAccount } = bootstrap;
  const orgId = asOrgId(org.id);
  const runId = Date.now().toString(36);

  const queue = new Queue(QUEUES.ingestion, { connection: redisConnection() });
  const baseline = await countClassifications(orgId);

  console.log(`load: enqueueing ${LOAD_N} synthetic DMs (run ${runId})…`);
  const enqueueStart = Date.now();
  const BATCH = 500;
  for (let offset = 0; offset < LOAD_N; offset += BATCH) {
    const jobs = [];
    for (let i = offset; i < Math.min(offset + BATCH, LOAD_N); i++) {
      const payload: IngestionJob = {
        orgId: org.id,
        igAccountId: igAccount.id,
        igThreadId: `load-${runId}-t${i % 500}`, // ~500 distinct senders, like a real inbox
        participantHandle: `load.sender${i % 500}`,
        participantIgId: `load-p-${runId}-${i % 500}`,
        igMessageId: `load-${runId}-m${i}`,
        direction: "inbound",
        contentType: "text",
        text: HINGLISH_SAMPLES[i % HINGLISH_SAMPLES.length]!,
        sentAt: new Date().toISOString(),
        source: "live",
        raw: { loadTest: runId, enqueuedAt: Date.now() },
      };
      jobs.push({ name: "load", data: payload });
    }
    await queue.addBulk(jobs);
  }
  console.log(`load: enqueued in ${((Date.now() - enqueueStart) / 1000).toFixed(1)}s`);

  // Wait for the pipeline to classify everything (generous ceiling).
  const target = baseline.total + LOAD_N;
  const deadline = Date.now() + Math.max(300_000, LOAD_N * 50);
  let stats = baseline;
  while (Date.now() < deadline) {
    stats = await countClassifications(orgId);
    if (stats.total >= target) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (stats.total < target) {
    console.error(`LOAD FAILED: classified ${stats.total - baseline.total}/${LOAD_N} before deadline`);
    process.exit(1);
  }

  // Ingestion lag: message.sentAt (== enqueue time here) → classification.createdAt.
  const lags = (await getIngestionLagsMs(orgId, `load-${runId}-m`)).sort((a, b) => a - b);
  const p50 = percentile(lags, 50);
  const p95 = percentile(lags, 95);
  const p99 = percentile(lags, 99);
  console.log(
    `load: ${lags.length} messages · lag p50 ${(p50 / 1000).toFixed(1)}s · p95 ${(p95 / 1000).toFixed(1)}s · p99 ${(p99 / 1000).toFixed(1)}s · budget ${BUDGET_MS / 1000}s`
  );

  await queue.close();
  if (p95 > BUDGET_MS) {
    console.error(`LOAD FAILED: p95 ${(p95 / 1000).toFixed(1)}s exceeds the 60s budget (PRD §7.3)`);
    process.exit(1);
  }
  console.log("LOAD TEST PASSED ✓ — ingestion budget held under storm");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
