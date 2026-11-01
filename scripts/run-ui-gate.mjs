import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Fictional browser-only data. This gate does not exercise the API or providers.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const reuse = process.env.E2E_UI_REUSE_SERVER === "true";
assert.ok(!reuse || process.env.E2E_BASE_URL, "E2E_BASE_URL is required when reusing the demo server");
const base = new URL(reuse ? process.env.E2E_BASE_URL : "http://127.0.0.1:3101");
assert.ok(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) && !base.username && !base.password && base.pathname === "/" && !base.search && !base.hash, "E2E_BASE_URL must be a plain loopback HTTP origin");
assert.ok(!reuse || base.port === "3100", "A reused demo server must use port 3100");
const origin = base.origin;
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(CLERK|ANTHROPIC|OPENAI|META|FACEBOOK|INSTAGRAM|GRAPH|RAZORPAY|STRIPE|ELEVEN|GOOGLE|API|SECRET|TOKEN|PASSWORD|CREDENTIAL|VAPID|DATABASE|REDIS|(^|_)KEY($|_))/i.test(key)));
const env = {
  ...safeEnv,
  NODE_ENV: "development", NEXT_PUBLIC_DEALDOCK_DEMO_MODE: "true",
  DEALDOCK_DISABLE_AUTH: "true", DEALDOCK_DEV_ORG_ID: "",
  DEALDOCK_API_URL: "", NEXT_PUBLIC_API_URL: "",
  CLERK_SECRET_KEY: "", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
  ANTHROPIC_API_KEY: "", META_APP_ID: "", META_APP_SECRET: "", META_WEBHOOK_VERIFY_TOKEN: "", GRAPH_ACCESS_TOKEN: "", NEXT_PUBLIC_VAPID_PUBLIC_KEY: "",
  E2E_BASE_URL: origin, E2E_START_WEB: "false", E2E_DEMO_PRODUCT: "true", E2E_REAL_PRODUCT: "false", NEXT_TELEMETRY_DISABLED: "1",
};
let output = "";
function start(label, args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  const log = (stream, chunk) => { output = (output + chunk).slice(-12000); if (label === "Playwright") stream.write(chunk); };
  child.stdout.on("data", (chunk) => log(process.stdout, chunk));
  child.stderr.on("data", (chunk) => log(process.stderr, chunk));
  return child;
}
async function unused(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
async function ready(url, child) {
  const until = Date.now() + 120000;
  let last = "not attempted";
  while (Date.now() < until) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`Demo server exited (${child.exitCode ?? child.signalCode}).`);
    try { const response = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (response.ok) { await response.arrayBuffer(); return; } last = `HTTP ${response.status}`; }
    catch (error) { last = String(error); }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Demo server did not become ready: ${last}`);
}
async function warm() {
  const assets = new Set();
  for (const path of ["/", "/inbox", "/thread/t-monsoon", "/thread/t-saffron", "/ledger", "/settings", "/review", "/onboarding", "/voice", "/offers", "/roster"]) {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(60000) });
    assert.ok(response.ok, `Development route failed to compile: ${path} (${response.status})`);
    const html = await response.text();
    for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      const url = new URL(match[1].replaceAll("&amp;", "&"), origin);
      if (url.origin === origin && url.pathname.startsWith("/_next/")) assets.add(url.href);
    }
  }
  for (const url of assets) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    assert.ok(response.ok, `Development asset unavailable: ${new URL(url).pathname}`);
    await response.arrayBuffer();
  }
}
async function verifyDemo() {
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    const marker = page.getByTestId("demo-mode");
    await marker.waitFor({ state: "visible", timeout: 30000 });
    assert.match(await marker.innerText(), /demo/i, "The reused server must display its demo marker");
    await page.getByRole("link", { name: /@diya\.moves/ }).first().waitFor({ state: "visible", timeout: 30000 });
  } finally { await browser.close(); }
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise((resolve) => { killer.once("exit", resolve); killer.once("error", resolve); });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
  }
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (process.platform !== "win32" && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
  }
}
let web;
let exitCode = 1;
try {
  if (!reuse) {
    await unused(3101);
    web = start("web", [join(root, "node_modules", "next", "dist", "bin", "next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3101"], join(root, "apps", "web"));
  }
  await ready(origin, web);
  await warm();
  await verifyDemo();
  console.log(`Verified fictional DealDock Demo at ${origin}; starting UI regressions (no API/provider proof).`);
  const test = start("Playwright", [join(root, "node_modules", "@playwright", "test", "cli.js"), "test", "--config", join(root, "playwright.demo.config.ts")]);
  exitCode = await new Promise((resolve) => { test.once("error", () => resolve(1)); test.once("exit", (code) => resolve(code ?? 1)); });
} catch (error) {
  console.error(error);
} finally {
  await stop(web);
  if (exitCode !== 0 && output) console.error(`Recent gate output:\n${output}`);
}
process.exitCode = exitCode;
