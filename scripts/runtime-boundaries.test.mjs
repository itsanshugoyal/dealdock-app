import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const apiOnly = ['TOKEN_ENCRYPTION_KEY', 'META_APP_SECRET', 'META_APP_ID', 'META_WEBHOOK_VERIFY_TOKEN', 'GRAPH_ACCESS_TOKEN'];

for (const key of apiOnly) {
  test(`worker refuses API-only credential ${key} before starting consumers`, () => {
    // No inherited account keys, database URLs or network services are needed.
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
    Object.assign(env, { NODE_ENV: 'production', [key]: 'test-value-never-a-real-secret' });
    const result = spawnSync(process.execPath, ['apps/worker/dist/index.js'], { cwd: root, env, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`worker refused API-only credentials: ${key}`));
    assert.doesNotMatch(result.stdout, /dealdock-worker up/);
  });
}
