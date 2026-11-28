#!/usr/bin/env node
/**
 * One-time Razorpay account setup, safe to re-run. Run it once per mode:
 *
 *   node --env-file=.env scripts/razorpay-setup.mjs --env test
 *   RAZORPAY_KEY_ID=rzp_live_... RAZORPAY_KEY_SECRET=... node scripts/razorpay-setup.mjs --env live
 *
 * Creates (or finds) the monthly INR plan per tier and the webhook to
 * <api>/webhooks/razorpay, then prints the values to store. Razorpay plans can't
 * be edited or deleted, so a price change means a new plan (the script warns).
 * Set RAZORPAY_WEBHOOK_SECRET first (openssl rand -hex 32); Razorpay never shows
 * it again, so the script uses yours and never prints it.
 * Options: --api <url> (default: live → https://api.dealdock.io, test → https://api-dev.dealdock.io,
 * the local tunnel in docs/local-sandbox.md)  --alert-email you@dealdock.io
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PRICING } = require("@dealdock/billing");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const env = arg("env");
const api = arg("api", env === "live" ? "https://api.dealdock.io" : "https://api-dev.dealdock.io").replace(/\/$/, "");
const alertEmail = arg("alert-email");
const keyId = process.env.RAZORPAY_KEY_ID ?? "";
const keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";

if (env !== "test" && env !== "live") fail("Pass --env test or --env live.");
if (!keyId || !keySecret) fail("Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET for that mode.");
// Razorpay keys carry their mode; refuse the wrong one rather than configure the wrong account.
if (!keyId.startsWith(`rzp_${env}_`)) fail(`RAZORPAY_KEY_ID is not a ${env}-mode key.`);
if (!api.startsWith("https://")) fail(`${api} must be https.`);

const WEBHOOK_URL = `${api}/webhooks/razorpay`;
// The events packages/billing/src/razorpay.ts maps; anything else is ignored there.
const EVENTS = [
  "subscription.authenticated",
  "subscription.activated",
  "subscription.charged",
  "subscription.pending",
  "subscription.halted",
  "subscription.cancelled",
  "subscription.completed",
];
const TIERS = /** @type {const} */ (["solo", "studio", "roster"]);
const TIER_NAMES = { solo: "Solo", studio: "Studio", roster: "Roster" };

function fail(message) {
  console.error(`razorpay-setup: ${message}`);
  process.exit(1);
}

async function razorpay(method, path, body) {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.error?.description ?? "request failed"}`);
  return json;
}

async function plans() {
  const existing = (await razorpay("GET", "/plans?count=100")).items ?? [];
  const ids = {};
  for (const tier of TIERS) {
    const amount = PRICING[tier].inrMinor;
    const found = existing.find((p) => p.notes?.dealdock === "plans" && p.notes?.tier === tier && p.item?.amount === amount);
    if (found) {
      ids[tier] = found.id;
      continue;
    }
    const stale = existing.find((p) => p.notes?.dealdock === "plans" && p.notes?.tier === tier);
    if (stale) console.warn(`  ! ${tier}: plan ${stale.id} charges ${stale.item?.amount}, code expects ${amount}. Creating a new plan.`);
    const created = await razorpay("POST", "/plans", {
      period: "monthly",
      interval: 1,
      item: {
        name: `DealDock ${TIER_NAMES[tier]}`,
        amount,
        currency: "INR",
        description: `DealDock ${TIER_NAMES[tier]}, monthly`,
      },
      notes: { dealdock: "plans", tier },
    });
    ids[tier] = created.id;
  }
  return ids;
}

async function webhook() {
  const found = ((await razorpay("GET", "/webhooks")).items ?? []).find((w) => w.url === WEBHOOK_URL);
  const events = Object.fromEntries(EVENTS.map((e) => [e, true]));
  if (found) {
    const active = Object.entries(found.events ?? {}).filter(([, on]) => on).map(([e]) => e);
    if (!found.active || EVENTS.some((e) => !active.includes(e))) {
      await razorpay("PUT", `/webhooks/${found.id}`, { url: WEBHOOK_URL, events: { ...found.events, ...events }, active: true });
    }
    return { id: found.id, created: false };
  }
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) fail("Set RAZORPAY_WEBHOOK_SECRET (openssl rand -hex 32) before creating the webhook.");
  const created = await razorpay("POST", "/webhooks", {
    url: WEBHOOK_URL,
    secret,
    events,
    ...(alertEmail ? { alert_email: alertEmail } : {}),
  });
  return { id: created.id, created: true };
}

try {
  console.log(`Razorpay ${env}: configuring for ${api}\n`);
  const ids = await plans();
  console.log(`  ✓ plans ${TIERS.map((t) => `${t}=${ids[t]}`).join(" ")}`);
  const hook = await webhook();
  console.log(`  ✓ webhook ${hook.id} → ${WEBHOOK_URL}`);

  const cfg = env === "test" ? "stg" : "prd";
  console.log(`
Store these (${cfg}_* configs):

  API (${cfg}_api) and worker (${cfg}_worker):
    RAZORPAY_KEY_ID=${keyId}
    RAZORPAY_KEY_SECRET=<the secret you ran this with>
    RAZORPAY_PLAN_SOLO=${ids.solo}
    RAZORPAY_PLAN_STUDIO=${ids.studio}
    RAZORPAY_PLAN_ROSTER=${ids.roster}

  API only (${cfg}_api):
    RAZORPAY_WEBHOOK_SECRET=<${hook.created ? "the one you ran this with" : "unchanged: the one set when the webhook was created"}>
`);
} catch (err) {
  fail(err.message);
}
