import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectSource } from './boundary-rules.mjs';
for (const code of [`import { PrismaClient } from '@prisma/client';`, `export * from '@prisma/client';`, `const db = require('@prisma/client');`, `const db = await import('@prisma/client');`, `import pg from 'pg';`]) {
  test(`rejects direct database access: ${code}`, () => assert.ok(inspectSource('apps/api/src/route.ts',code).length));
}
for (const code of [`import { InstagramGraphAdapter as Adapter } from '@dealdock/messaging';`, `const adapter = require('@dealdock/messaging');`, `const adapter = await import('@dealdock/messaging');`, `import { getConnectedAccount as credentials } from '@dealdock/db';`, `fetch('https://graph.instagram.com/v22.0/me/messages');`]) {
  test(`rejects worker capability: ${code}`, () => assert.ok(inspectSource('apps/worker/src/job.ts',code).length));
}
test('allows repository use and ignores comments',()=>assert.deepEqual(inspectSource('apps/worker/src/job.ts',`import { asOrgId, createDraft } from '@dealdock/db'; // never sendMessage`),[]));
test('allows Prisma inside its repository package',()=>assert.deepEqual(inspectSource('packages/db/src/client.ts',`import {PrismaClient} from '@prisma/client';`),[]));
for (const code of [`import { createSpeechProvider } from '@dealdock/speech';`, `export * from '@dealdock/speech/dist/elevenlabs';`, `const speech = await import('@dealdock/speech');`]) {
  test(`rejects web speech capability: ${code}`, () => assert.ok(inspectSource('apps/web/src/app/page.tsx',code).length));
}
test('allows speech providers in the API and worker',()=>{for (const path of ['apps/api/src/routes/speaking.ts','apps/worker/src/consumers/ingestion.ts']) assert.deepEqual(inspectSource(path,`import { createSpeechProvider } from '@dealdock/speech';`),[]);});
