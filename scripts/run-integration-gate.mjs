import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
for (const name of ['TEST_DATABASE_URL', 'REDIS_URL']) {
  assert.ok(process.env[name], `${name} is required; integration tests cannot skip`);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env[name]).hostname), `${name} must be a disposable loopback service`);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(CLERK|ANTHROPIC|META|FACEBOOK|INSTAGRAM|GRAPH|API_KEY|SECRET|TOKEN)/i.test(key)));
Object.assign(env, { DATABASE_URL: process.env.TEST_DATABASE_URL, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, REDIS_URL: process.env.REDIS_URL, NODE_ENV: 'test', DEALDOCK_AI_MODE: 'heuristic', RUN_DB_INTEGRATION: '1', RUN_REDIS_INTEGRATION: '1', LOAD_N: '2000' });
process.env.DATABASE_URL = env.DATABASE_URL;
const db = require('@dealdock/db');
const { Queue } = require('bullmq');
const { QUEUES, parseRedisConnection } = require('@dealdock/core');
let worker, demoId, seedStarted = false;
function child(args, cwd = root) {
  return spawn(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
}
async function run(args, cwd) {
  const proc = child(args, cwd);
  const code = await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('exit', code => resolve(code)); });
  if (code !== 0) throw new Error(`${args[0]} failed (${code})`);
}
async function stop(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill();
  await new Promise(resolve => proc.once('exit', resolve));
}
let failed = false;
try {
  await db.requireUtf8Database();
  const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
  await run([vitest, 'run', 'test/tenancy.integration.test.ts', 'test/safety.integration.test.ts', 'test/billing.integration.test.ts', 'test/media.integration.test.ts', 'test/insights.integration.test.ts', 'test/voice-learning.integration.test.ts'], join(root, 'packages/db'));
  await run([vitest, 'run', 'test/graph-budget.integration.test.ts'], join(root, 'packages/messaging'));
  await run([join(root, 'scripts/verify-private-pilot.mjs')]);
  assert.equal(await db.findDemoBootstrap(), null, 'Refusing to overwrite or delete an existing demo organization');
  seedStarted = true;
  await run([join(root, 'packages/db/dist/seed.js')]);
  const demo = await db.findDemoBootstrap();
  assert.ok(demo, 'Demo seed did not create an organization');
  demoId = demo.org.id;
  // Start only the pipeline consumers required by the corpus/load gates, avoiding recurring jobs.
  const bootstrap = `const a=require('./apps/worker/dist/consumers/ingestion.js').startIngestionWorker();const b=require('./apps/worker/dist/consumers/classification.js').startClassificationWorker();const c=require('./apps/worker/dist/consumers/drafting.js').startDraftingWorker();const d=require('./apps/worker/dist/consumers/outbox.js').startOutboxDispatcher();process.on('SIGTERM',()=>Promise.all([a.close(),b.close(),c.close(),d.close()]).then(()=>process.exit(0)));`;
  worker = child(['-e', bootstrap]);
  await run([join(root, 'scripts/demo-ingest.mjs')]);
  await run([join(root, 'apps/worker/dist/load-test.js')]);
  await stop(worker); worker = undefined;
  await run([join(root, 'apps/worker/dist/deletion-drill.js')]);
  console.log('Integration gate passed: real PostgreSQL and Redis, corpus, 2000 DM load, deletion drill and mock-provider pilot.');
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await stop(worker);
  if (seedStarted && !demoId) {
    const seeded = await db.findDemoBootstrap();
    demoId = seeded?.org.id;
  }
  if (demoId) {
    try {
      for (const name of Object.values(QUEUES)) {
        const queue = new Queue(name, { connection: parseRedisConnection(env.REDIS_URL) });
        try { for (const job of await queue.getJobs(['completed', 'failed', 'waiting', 'delayed'])) if (job.data?.orgId === demoId) await job.remove(); }
        finally { await queue.close(); }
      }
      await db.hardDeleteOrg(demoId);
    } catch (error) { failed = true; console.error('Fixture cleanup failed:', error); }
  }
  await db.disconnectDatabase();
}
process.exit(failed ? 1 : 0);
