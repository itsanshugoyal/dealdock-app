#!/usr/bin/env node
/**
 * One-time Paddle account setup, safe to re-run. Run it once per environment:
 *
 *   PADDLE_API_KEY=pdl_sdbx_apikey_... node scripts/paddle-setup.mjs --env sandbox
 *   PADDLE_API_KEY=pdl_live_apikey_... node scripts/paddle-setup.mjs --env live
 *
 * Creates (or finds) the DealDock product, a monthly USD price per tier, the
 * webhook destination, the default payment link (<app>/pay) and a client-side
 * token, then prints the values to store in Doppler. It never prints the API key.
 * Options: --app https://app.dealdock.io  --api https://api.dealdock.io
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PRICING } = require("@dealdock/billing");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const env = arg("env");
const app = arg("app", "https://app.dealdock.io").replace(/\/$/, "");
const api = arg("api", "https://api.dealdock.io").replace(/\/$/, "");
const key = process.env.PADDLE_API_KEY ?? "";

if (env !== "sandbox" && env !== "live") fail("Pass --env sandbox or --env live.");
if (!key) fail("Set PADDLE_API_KEY for that environment.");
// Paddle keys carry their environment; refuse the wrong one rather than configure the wrong account.
if ((env === "sandbox" && key.startsWith("pdl_live_")) || (env === "live" && key.startsWith("pdl_sdbx_"))) {
  fail(`That API key belongs to the other Paddle environment, not ${env}.`);
}
for (const url of [app, api]) if (!url.startsWith("https://")) fail(`${url} must be https.`);

const BASE = env === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
const WEBHOOK_URL = `${api}/webhooks/paddle`;
const CHECKOUT_URL = `${app}/pay`;
// The events packages/billing/src/paddle.ts maps; anything else is ignored there.
const EVENTS = ["transaction.completed", "subscription.activated", "subscription.past_due", "subscription.canceled"];
const TIERS = /** @type {const} */ (["solo", "studio", "roster"]);
const TIER_NAMES = { solo: "Solo", studio: "Studio", roster: "Roster" };

function fail(message) {
  console.error(`paddle-setup: ${message}`);
  process.exit(1);
}

async function paddle(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status} ${json.error?.code ?? ""}: ${json.error?.detail ?? "request failed"}`);
    err.code = json.error?.code;
    throw err;
  }
  return json.data;
}

async function product() {
  const found = (await paddle("GET", "/products?status=active&per_page=200")).find((p) => p.custom_data?.dealdock === "plans");
  if (found) return found;
  return paddle("POST", "/products", {
    name: "DealDock",
    tax_category: "saas",
    description: "A deal inbox and CRM for creators, with replies you approve.",
    custom_data: { dealdock: "plans" },
  });
}

async function prices(productId) {
  const existing = await paddle("GET", `/prices?product_id=${productId}&status=active&per_page=200`);
  const ids = {};
  for (const tier of TIERS) {
    const amount = String(PRICING[tier].usdMinor);
    const found = existing.find((p) => p.custom_data?.tier === tier);
    if (found) {
      if (found.unit_price?.amount !== amount || found.unit_price?.currency_code !== "USD") {
        console.warn(`  ! ${tier}: Paddle has ${found.unit_price?.amount} ${found.unit_price?.currency_code}, code expects ${amount} USD. Archive it in Paddle and re-run to replace it.`);
      }
      ids[tier] = found.id;
      continue;
    }
    const created = await paddle("POST", "/prices", {
      product_id: productId,
      name: TIER_NAMES[tier],
      description: `DealDock ${TIER_NAMES[tier]}, monthly`,
      unit_price: { amount, currency_code: "USD" },
      billing_cycle: { interval: "month", frequency: 1 },
      quantity: { minimum: 1, maximum: 1 },
      custom_data: { tier },
    });
    ids[tier] = created.id;
  }
  return ids;
}

async function webhook() {
  const found = (await paddle("GET", "/notification-settings")).find((n) => n.destination === WEBHOOK_URL && n.type === "url");
  if (found) {
    const have = new Set((found.subscribed_events ?? []).map((e) => e.name));
    if (!found.active || EVENTS.some((e) => !have.has(e))) {
      await paddle("PATCH", `/notification-settings/${found.id}`, { active: true, subscribed_events: [...new Set([...have, ...EVENTS])] });
    }
    return found.endpoint_secret_key;
  }
  const created = await paddle("POST", "/notification-settings", {
    description: "DealDock API",
    type: "url",
    destination: WEBHOOK_URL,
    subscribed_events: EVENTS,
    // Sandbox also receives the dashboard's webhook simulations.
    traffic_source: env === "sandbox" ? "all" : "platform",
  });
  return created.endpoint_secret_key;
}

async function checkoutLink() {
  try {
    await paddle("PATCH", "/settings/checkout-url", { default_url: CHECKOUT_URL });
    return true;
  } catch (err) {
    if (err.code === "checkout_url_domain_not_approved") {
      console.warn(`  ! ${new URL(app).host} isn't an approved domain yet. Get it approved (Paddle > Checkout > Website approval), then re-run.`);
      return false;
    }
    throw err;
  }
}

async function clientToken() {
  const found = (await paddle("GET", "/client-tokens?status=active")).find((t) => t.name === "DealDock web app" && t.token);
  if (found) return found.token;
  return (await paddle("POST", "/client-tokens", { name: "DealDock web app", description: `Paddle.js on ${CHECKOUT_URL}` })).token;
}

try {
  console.log(`Paddle ${env}: configuring for ${app} and ${api}\n`);
  const prod = await product();
  console.log(`  ✓ product ${prod.id}`);
  const ids = await prices(prod.id);
  console.log(`  ✓ prices ${TIERS.map((t) => `${t}=${ids[t]}`).join(" ")}`);
  const secret = await webhook();
  console.log(`  ✓ webhook → ${WEBHOOK_URL}`);
  const linked = await checkoutLink();
  if (linked) console.log(`  ✓ default payment link → ${CHECKOUT_URL}`);
  const token = await clientToken();
  console.log(`  ✓ client-side token`);

  const envName = env === "sandbox" ? "sandbox" : "live";
  const cfg = env === "sandbox" ? "stg" : "prd";
  console.log(`
Store these in Doppler (${cfg}_* configs):

  API (${cfg}_api) and worker (${cfg}_worker):
    PADDLE_ENV=${envName}
    PADDLE_API_KEY=<the key you ran this with>
    PADDLE_PRICE_SOLO=${ids.solo}
    PADDLE_PRICE_STUDIO=${ids.studio}
    PADDLE_PRICE_ROSTER=${ids.roster}

  API only (${cfg}_api):
    PADDLE_WEBHOOK_SECRET=${secret ?? "<not returned: copy it from Paddle > Developer tools > Notifications>"}

  Web (${cfg}_web):
    NEXT_PUBLIC_PADDLE_ENV=${envName}
    NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=${token}
${linked ? "" : "\n  Not done yet: the default payment link (domain approval). Re-run after approval.\n"}`);
} catch (err) {
  fail(err.message);
}
