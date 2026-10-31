import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('production web fails closed with missing Clerk keys even when local bypass flags are set', { timeout: 45_000 }, async () => {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
  Object.assign(env, { NODE_ENV: 'production', DEALDOCK_DISABLE_AUTH: 'true', DEALDOCK_DEV_ORG_ID: 'must-not-authorize', DEALDOCK_API_URL: 'http://127.0.0.1:1' });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url)), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: fileURLToPath(new URL('../apps/web/', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  // Drain output without logging request/session information.
  child.stdout.resume(); child.stderr.resume();
  try {
    let response;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Production web exited before readiness (${child.exitCode})`);
      try { response = await fetch(`http://127.0.0.1:${port}/inbox`, { redirect: 'manual', signal: AbortSignal.timeout(2_000) }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 150)); }
    }
    assert.ok(response, 'Production web did not start');
    assert.ok([401, 403, 500].includes(response.status), `Unauthenticated inbox must fail closed, got ${response.status}`);
    const bridge = await fetch(`http://127.0.0.1:${port}/api/dev/inbox`, { headers: { 'x-demo-org': 'must-not-authorize' }, redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    assert.ok([401, 403, 404, 500].includes(bridge.status), `Development bridge must be unavailable in production, got ${bridge.status}`);
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
  }
});
