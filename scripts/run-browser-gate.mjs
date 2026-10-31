import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

function assertLoopback(label, value) {
  assert.ok(value, `${label} is required`);
  const host = new URL(value).hostname;
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(host), `${label} must point to a loopback-only disposable service`);
}

async function assertPortUnused(port) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); reject(new Error(`Port ${port} is already in use; browser gate refuses to attach to an unknown service.`)); });
    socket.once("error", (error) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
  });
}

assertLoopback("TEST_DATABASE_URL", databaseUrl);
assertLoopback("REDIS_URL", redisUrl);
await assertPortUnused(4000);
await assertPortUnused(3100);
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = "development";

const db = require("@dealdock/db");
const nonce = crypto.randomUUID();
const created = await db.createOrganizationWithCreator({
  name: `DealDock browser E2E ${nonce}`,
  tier: "solo",
  currencyCode: "INR",
  locale: "en-IN",
  timezone: "Asia/Kolkata",
  creator: { clerkUserId: "user_demo_local", email: `e2e-${nonce}@example.test`, name: "Browser Test Creator" },
  igAccount: { provider: "mock", igUserId: `e2e-ig-${nonce}`, handle: "e2e.creator", accountType: "creator" },
});
const orgId = created.org.id;
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(CLERK|ANTHROPIC|META|FACEBOOK|INSTAGRAM|GRAPH|API_KEY|SECRET|TOKEN)/i.test(key)));
const baseEnv = {
  ...safeEnv,
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  NODE_ENV: "development",
  DEALDOCK_DISABLE_AUTH: "true",
  DEALDOCK_DEV_ORG_ID: orgId,
  DEALDOCK_API_URL: "http://127.0.0.1:4000",
  DEALDOCK_AI_MODE: "heuristic",
  ANTHROPIC_API_KEY: "",
  CLERK_SECRET_KEY: "",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "",
  META_APP_ID: "",
  META_APP_SECRET: "",
  META_WEBHOOK_VERIFY_TOKEN: "",
  GRAPH_ACCESS_TOKEN: "",
  E2E_START_WEB: "false",
  E2E_REAL_PRODUCT: "true",
  E2E_DEV_ORG_ID: orgId,
  E2E_BASE_URL: "http://localhost:3100",
  NEXT_PUBLIC_DEALDOCK_DEMO_MODE: "false",
  NEXT_TELEMETRY_DISABLED: "1",
};

function start(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: baseEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...options,
  });
  let output = "";
  const remember = (chunk) => { output = `${output}${chunk}`.slice(-6_000); };
  child.stdout?.on("data", (chunk) => { remember(chunk); if (label === "Playwright") process.stdout.write(chunk); });
  child.stderr?.on("data", (chunk) => { remember(chunk); if (label === "Playwright") process.stderr.write(chunk); });
  child.once("exit", (code) => { if (label !== "Playwright" && code !== 0 && code !== null) console.error(`${label} exited (${code}):\n${output}`); });
  return child;
}

async function waitFor(url, label) {
  const until = Date.now() + 120_000;
  let last = "not attempted";
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) { await response.arrayBuffer(); return; }
      last = `HTTP ${response.status}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready: ${last}`);
}

function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
}

async function prepareDevelopmentRoutes() {
  // Next dev compiles routes on first access. Keep that tooling work outside
  // the product assertions, without extending timeouts or retrying mutations.
  const origin = "http://localhost:3100";
  const assets = new Set();
  for (const path of ["/inbox", "/thread/readiness-only", "/ledger", "/settings", "/review", "/onboarding"]) {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(60_000) });
    assert.ok(response.ok, `Development route did not compile: ${path} (${response.status})`);
    const html = await response.text();
    for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      const url = new URL(match[1].replaceAll("&amp;", "&"), origin);
      if (url.origin === origin && url.pathname.startsWith("/_next/")) assets.add(url.href);
    }
  }
  for (const url of assets) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `Development asset unavailable: ${new URL(url).pathname}`);
    await response.arrayBuffer();
  }
  console.log("Development routes/assets compiled; starting unchanged browser assertions.");
}

let api;
let web;
let exitCode = 1;
try {
  assert.ok(require("node:fs").existsSync(join(root, "apps", "api", "dist", "index.js")), "Build apps/api before the browser gate");
  api = start("API", process.execPath, [join(root, "apps", "api", "dist", "index.js")], { env: { ...baseEnv, PORT: "4000", WEB_APP_URL: "http://localhost:3100" } });
  await waitFor("http://127.0.0.1:4000/ready", "API");
  web = start("web", process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "dev", "--webpack", "--port", "3100"], { cwd: join(root, "apps", "web") });
  await waitFor("http://localhost:3100", "web");
  await prepareDevelopmentRoutes();
  const playwright = start("Playwright", process.execPath, [join(root, "node_modules", "@playwright", "test", "cli.js"), "test", "--config", join(root, "playwright.config.ts")]);
  exitCode = await new Promise((resolve) => playwright.once("exit", (code) => resolve(code ?? 1)));
  if (exitCode === 0) console.log("PASS: browser critical path used the real local API, PostgreSQL, Redis and mock provider.");
} catch (error) {
  console.error(error);
} finally {
  stop(web);
  stop(api);
  await Promise.allSettled([web, api].filter(Boolean).map((child) => new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", resolve);
  })));
  await db.hardDeleteOrg(orgId).catch((error) => { console.error(`Fixture cleanup failed: ${error.message}`); exitCode = 1; });
}
process.exit(exitCode);
