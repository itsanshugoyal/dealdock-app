#!/usr/bin/env node
/**
 * Sync the local .env with Doppler's dev configs (project dealdock), split the
 * way production is: dev_api, dev_web, dev_worker. Never touches stg or prd.
 *
 *   npm run env:push   # .env → dev_api / dev_web / dev_worker (adds and updates, never deletes)
 *   npm run env:pull   # dev_* → .env (merged) and apps/web/.env.development.local (read by `next dev` only)
 *
 * Needs the Doppler CLI, logged in (`doppler login`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = "dealdock";
const ENV_FILE = ".env";
// .development.local: read by `next dev` only, never by `next build` / `next start`.
const WEB_ENV_FILE = "apps/web/.env.development.local";

const isWeb = (k) => k.startsWith("NEXT_PUBLIC_") || k === "CLERK_SECRET_KEY";
// The worker exits if it sees API-only credentials (apps/worker/src/refuse-api-secrets.ts);
// it also has no use for auth, webhook or Graph secrets.
const notForWorker = (k) =>
  /^(META_|GOOGLE_|GMAIL_|GRAPH_|CLERK_)/.test(k) ||
  /_WEBHOOK_SECRET$/.test(k) ||
  ["TOKEN_ENCRYPTION_KEY", "MEDIA_SIGNING_KEY", "IG_OAUTH_REDIRECT_URI"].includes(k);
const SPLIT = {
  dev_api: (k) => !k.startsWith("NEXT_PUBLIC_"),
  dev_web: isWeb,
  dev_worker: (k) => !k.startsWith("NEXT_PUBLIC_") && !notForWorker(k),
};

const doppler = (args, input) => execFileSync("doppler", args, { input, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] }).toString();

function parse(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

/** Update keys in place, append new ones, keep comments and order. */
function merge(file, values) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  if (lines.at(-1) === "") lines.pop();
  for (const [k, v] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i > -1) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
}

function push() {
  const env = parse(ENV_FILE);
  // A live key never belongs in a dev config.
  const live = Object.entries(env).filter(([, v]) => /^(rzp_live_|pdl_live_|sk_live_|pk_live_)/.test(v)).map(([k]) => k);
  if (live.length) throw new Error(`.env holds live keys (${live.join(", ")}); move them to .env.live.local first`);
  const dir = mkdtempSync(join(tmpdir(), "dealdock-env-"));
  try {
    for (const [config, wanted] of Object.entries(SPLIT)) {
      const subset = Object.entries(env).filter(([k]) => wanted(k));
      const file = join(dir, `${config}.env`);
      writeFileSync(file, subset.map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
      doppler(["secrets", "upload", file, "-p", PROJECT, "-c", config, "--silent"]);
      console.log(`  ✓ ${config}: ${subset.length} keys`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function pull() {
  const merged = {};
  for (const config of Object.keys(SPLIT)) {
    const values = JSON.parse(doppler(["secrets", "download", "-p", PROJECT, "-c", config, "--no-file", "--format", "json"]));
    for (const [k, v] of Object.entries(values)) {
      if (k.startsWith("DOPPLER_")) continue;
      if (k in merged && merged[k] !== v) console.warn(`  ! ${k} differs between dev configs; keeping the ${config} value`);
      merged[k] = v;
    }
    if (config === "dev_web") merge(WEB_ENV_FILE, Object.fromEntries(Object.entries(values).filter(([k]) => !k.startsWith("DOPPLER_"))));
    console.log(`  ✓ ${config}`);
  }
  merge(ENV_FILE, merged);
  console.log(`  ✓ ${ENV_FILE} and ${WEB_ENV_FILE} updated`);
}

const cmd = process.argv[2];
try {
  if (cmd === "push") push();
  else if (cmd === "pull") pull();
  else throw new Error("use push or pull");
} catch (err) {
  console.error(`env-sync: ${err.stderr?.toString().trim() || err.message}`);
  process.exit(1);
}
