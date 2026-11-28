#!/usr/bin/env node
/**
 * Local Postgres, Redis and the Cloudflare dev tunnel, without Docker or Windows
 * services. `npm run dev` starts them first (predev); `npm run services:stop` stops them.
 *
 *   node scripts/dev-services.mjs start|stop|status
 *   node scripts/dev-services.mjs urls   # local DATABASE_URL / REDIS_URL / TEST_DATABASE_URL
 *
 * Both listen on 127.0.0.1 only and use random passwords generated once into
 * <dir>/secrets.json (this is a shared work machine: no passwordless local services).
 * Binaries live in DEALDOCK_DEV_SERVICES_DIR (default %LOCALAPPDATA%/dealdock-dev):
 *   pgsql/   PostgreSQL 16 Windows binaries zip (get.enterprisedb.com)
 *   redis/   Redis for Windows msys2 zip (github.com/redis-windows/redis-windows)
 * Data and logs go in the same folder. Redis listens on 6380, not 6379, so it never
 * touches another project's Redis (Optmyzr runs Redis 2.8 on 6379).
 * The tunnel runs only if ~/.cloudflared/dealdock-dev.yml exists (docs/local-sandbox.md).
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.env.DEALDOCK_DEV_SERVICES_DIR ?? join(process.env.LOCALAPPDATA ?? homedir(), "dealdock-dev");
const PG_BIN = join(DIR, "pgsql", "bin");
const PG_DATA = join(DIR, "pgdata");
const PG_PORT = 5432;
const PG_USER = "dealdock";
const SECRETS = join(DIR, "secrets.json");
const REDIS_DIR = join(DIR, "redis");
const REDIS_PORT = 6380;
const TUNNEL_CONFIG = join(homedir(), ".cloudflared", "dealdock-dev.yml");
const CLOUDFLARED = ["C:/Program Files (x86)/cloudflared/cloudflared.exe", "C:/Program Files/cloudflared/cloudflared.exe"].find(existsSync) ?? "cloudflared";
const exe = (dir, name) => join(dir, process.platform === "win32" ? `${name}.exe` : name);
// Self-signed cert for `next dev` on https://localhost:3000 (Paddle's sandbox payment link must be https).
// Passed to Next directly, so nothing is added to the OS trust store; the browser warns once.
const WEB_CERTS = join(import.meta.dirname, "..", "apps", "web", ".certs");
const OPENSSL = ["C:/Program Files/Git/mingw64/bin/openssl.exe", "C:/Program Files/Git/usr/bin/openssl.exe"].find(existsSync) ?? "openssl";

function ensureWebCert() {
  const key = join(WEB_CERTS, "localhost-key.pem"), cert = join(WEB_CERTS, "localhost.pem");
  if (existsSync(key) && existsSync(cert)) return;
  mkdirSync(WEB_CERTS, { recursive: true });
  execFileSync(OPENSSL, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "825",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  console.log("  ✓ localhost certificate for the web (apps/web/.certs, self-signed, not trusted system-wide)");
}

function secrets() {
  if (!existsSync(SECRETS)) {
    const hex = () => randomBytes(24).toString("hex");
    writeFileSync(SECRETS, JSON.stringify({ pgPassword: hex(), redisPassword: hex() }, null, 2));
  }
  return JSON.parse(readFileSync(SECRETS, "utf8"));
}

function urls() {
  const s = secrets();
  const pg = (db) => `postgresql://${PG_USER}:${s.pgPassword}@localhost:${PG_PORT}/${db}`;
  return {
    DATABASE_URL: pg("dealdock"),
    TEST_DATABASE_URL: pg("dealdock_test"),
    SHADOW_DATABASE_URL: pg("dealdock_shadow"),
    REDIS_URL: `redis://:${s.redisPassword}@localhost:${REDIS_PORT}`,
  };
}

const portOpen = (port) =>
  new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" }, () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });

async function waitFor(port, label) {
  for (let i = 0; i < 60; i++) {
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not start on port ${port}; see the logs in ${DIR}`);
}

function need(path, what) {
  if (!existsSync(path)) throw new Error(`${what} not found at ${path}. Install steps: docs/local-sandbox.md`);
}

function detached(cmd, args, log) {
  const out = openSync(join(DIR, log), "a");
  spawn(cmd, args, { detached: true, stdio: ["ignore", out, out], windowsHide: true }).unref();
}

async function startPostgres() {
  need(exe(PG_BIN, "pg_ctl"), "PostgreSQL");
  if (!existsSync(PG_DATA)) {
    const pw = join(DIR, "pgpass.tmp");
    writeFileSync(pw, secrets().pgPassword);
    try {
      execFileSync(exe(PG_BIN, "initdb"), ["-D", PG_DATA, "-U", PG_USER, `--pwfile=${pw}`, "-A", "scram-sha-256", "-E", "UTF8", "--locale=C"], { stdio: "ignore" });
    } finally {
      rmSync(pw, { force: true });
    }
    console.log("  ✓ postgres data folder created");
  }
  if (await portOpen(PG_PORT)) {
    // Something answers on 5432: fine if it's this cluster, otherwise refuse rather than use another database.
    try {
      execFileSync(exe(PG_BIN, "pg_ctl"), ["status", "-D", PG_DATA], { stdio: "ignore" });
    } catch {
      throw new Error(`port ${PG_PORT} is taken by another PostgreSQL; stop it first`);
    }
  } else {
    execFileSync(exe(PG_BIN, "pg_ctl"), ["start", "-D", PG_DATA, "-l", join(DIR, "postgres.log"), "-w", "-o", `-p ${PG_PORT} -c listen_addresses=localhost`], { stdio: "ignore" });
  }
  // Create the app and test databases once.
  const env = { ...process.env, PGPASSWORD: secrets().pgPassword };
  const psql = (sql, db = "postgres") =>
    execFileSync(exe(PG_BIN, "psql"), ["-h", "localhost", "-p", String(PG_PORT), "-U", PG_USER, "-d", db, "-tAc", sql], { env }).toString().trim();
  for (const db of ["dealdock", "dealdock_test", "dealdock_shadow"]) {
    if (!psql(`SELECT 1 FROM pg_database WHERE datname='${db}'`)) psql(`CREATE DATABASE ${db} ENCODING 'UTF8'`);
  }
  console.log(`  ✓ postgres on localhost:${PG_PORT} (databases dealdock, dealdock_test, dealdock_shadow)`);
}

async function startRedis() {
  need(exe(REDIS_DIR, "redis-server"), "Redis");
  if (!(await portOpen(REDIS_PORT))) {
    const data = join(DIR, "redisdata");
    mkdirSync(data, { recursive: true });
    const args = ["--port", String(REDIS_PORT), "--bind", "127.0.0.1", "--protected-mode", "yes", "--dir", data.replace(/\\/g, "/"), "--appendonly", "yes", "--requirepass", secrets().redisPassword];
    detached(exe(REDIS_DIR, "redis-server"), args, "redis.log");
    await waitFor(REDIS_PORT, "Redis");
  }
  console.log(`  ✓ redis on localhost:${REDIS_PORT}`);
}

async function startTunnel() {
  if (!existsSync(TUNNEL_CONFIG)) return console.log("  - tunnel not configured (docs/local-sandbox.md)");
  const running = execFileSync("tasklist", ["/FI", "IMAGENAME eq cloudflared.exe", "/FO", "CSV", "/NH"]).toString().includes("cloudflared");
  if (!running) detached(CLOUDFLARED, ["tunnel", "--config", TUNNEL_CONFIG, "run"], "tunnel.log");
  console.log("  ✓ tunnel: api-dev.dealdock.io/webhooks/(razorpay|paddle) → 127.0.0.1:4000, all else 404");
}

async function stop() {
  if (existsSync(PG_DATA)) {
    try {
      execFileSync(exe(PG_BIN, "pg_ctl"), ["stop", "-D", PG_DATA, "-m", "fast"], { stdio: "ignore" });
      console.log("  ✓ postgres stopped");
    } catch {
      console.log("  - postgres was not running");
    }
  }
  if (await portOpen(REDIS_PORT)) {
    try {
      execFileSync(exe(REDIS_DIR, "redis-cli"), ["-p", String(REDIS_PORT), "--no-auth-warning", "-a", secrets().redisPassword, "shutdown"], { stdio: "ignore" });
    } catch {
      // redis-cli exits non-zero when the server closes the connection on shutdown.
    }
    console.log("  ✓ redis stopped");
  }
  try {
    execFileSync("taskkill", ["/IM", "cloudflared.exe", "/F"], { stdio: "ignore" });
    console.log("  ✓ tunnel stopped");
  } catch {
    // not running
  }
}

async function status() {
  console.log(`  postgres :${PG_PORT} ${(await portOpen(PG_PORT)) ? "up" : "down"}`);
  console.log(`  redis    :${REDIS_PORT} ${(await portOpen(REDIS_PORT)) ? "up" : "down"}`);
}

const cmd = process.argv[2] ?? "start";
try {
  mkdirSync(DIR, { recursive: true });
  if (cmd === "start") {
    ensureWebCert();
    await startPostgres();
    await startRedis();
    await startTunnel();
  } else if (cmd === "stop") await stop();
  else if (cmd === "status") await status();
  else if (cmd === "urls") for (const [k, v] of Object.entries(urls())) console.log(`${k}=${v}`);
  else throw new Error("use start, stop or status");
} catch (err) {
  console.error(`dev-services: ${err.message}`);
  process.exit(1);
}
