import { Queue } from "bullmq";
import { CORPUS } from "@dealdock/messaging";
import { QUEUES } from "@dealdock/core";
import {
  asOrgId,
  countClassifications,
  countMessages,
  findDemoBootstrap,
  listInboxThreads,
} from "@dealdock/db";
import { parseRedisConnection } from "@dealdock/core"; const redisConnection = () => parseRedisConnection(process.env.REDIS_URL);

/**
 * M0 exit demo: push the full fixture corpus through the real queue into
 * Postgres, then read it back through the repository layer.
 * Prereqs: docker compose up, migrations applied, seed run, worker running.
 */
async function main() {
  const bootstrap = await findDemoBootstrap();
  if (!bootstrap) {
    console.error("Demo org not found — run `npm run db:seed -w @dealdock/db` first.");
    process.exit(1);
  }
  const { org, igAccount } = bootstrap;

  const queue = new Queue(QUEUES.ingestion, { connection: redisConnection() });
  const now = Date.now();

  const jobs = CORPUS.map((f, i) => {
    const payload = {
      orgId: org.id,
      igAccountId: igAccount.id,
      igThreadId: `mock-thread-${i}`,
      participantHandle: f.handle,
      participantIgId: `mock-user-${i}`,
      igMessageId: `mock-msg-${i}-0`,
      direction: "inbound",
      contentType: "text",
      text: f.text,
      sentAt: new Date(now - f.minutesAgo * 60_000).toISOString(),
      source: "live",
      raw: { mock: true, fixtureIndex: i },
    };
    return { name: "inbound", data: payload };
  });

  await queue.addBulk(jobs);
  console.log(`Enqueued ${jobs.length} fixture DMs onto '${QUEUES.ingestion}'.`);

  // Poll until the worker drains them into Postgres (max 60s).
  const orgId = asOrgId(org.id);
  const deadline = Date.now() + 60_000;
  let count = 0;
  while (Date.now() < deadline) {
    count = await countMessages(orgId);
    if (count >= jobs.length) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }

  console.log(`Messages in Postgres for org ${org.id}: ${count}/${jobs.length}`);

  // M1: wait for the classification pipeline to process everything too.
  const classifyDeadline = Date.now() + 120_000;
  let stats = { total: 0, review: 0, drafts: 0 };
  while (Date.now() < classifyDeadline) {
    stats = await countClassifications(orgId);
    if (stats.total >= jobs.length) break;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  console.log(
    `Classified: ${stats.total}/${jobs.length} · review queue: ${stats.review} · drafts pre-generated: ${stats.drafts}`
  );

  const inbox = await listInboxThreads(orgId, { limit: 5 });
  console.log("Top Revenue Inbox rows (value-desc):");
  for (const row of inbox) {
    const value =
      row.estValueMaxMinor === null ? "—" : `₹${Math.round(row.estValueMaxMinor / 100).toLocaleString("en-IN")}`;
    console.log(
      `  [${row.topLabel ?? "?"}] @${row.participantHandle} · est ${value} — "${(row.preview ?? "").slice(0, 48)}..."`
    );
  }

  const ok = count >= jobs.length && stats.total >= jobs.length;
  await queue.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
