import assert from "node:assert/strict";
import type { FullConfig } from "@playwright/test";

/**
 * Seeds one explicit, disposable local org with a high-confidence coaching
 * enquiry. This is deliberately repository-level setup, not a network mock:
 * the browser still exercises the API, its auth guards, DB transactions and
 * mock messaging provider. The API dev-org must be supplied before it starts.
 */
export default async function globalSetup(_config: FullConfig) {
  assert.equal(process.env.E2E_REAL_PRODUCT, "true", "Run the browser gate through scripts/run-browser-gate.mjs with disposable services");

  const databaseUrl = process.env.TEST_DATABASE_URL;
  const orgId = process.env.E2E_DEV_ORG_ID;
  assert.ok(databaseUrl, "E2E_REAL_PRODUCT requires TEST_DATABASE_URL");
  assert.ok(orgId, "E2E_REAL_PRODUCT requires E2E_DEV_ORG_ID configured on the local API and web dev proxy");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname), "E2E only permits a loopback disposable database");
  process.env.DATABASE_URL = databaseUrl;

  const db = await import("@dealdock/db");
  const scopedOrg = db.asOrgId(orgId);
  const org = await db.getOrganization(scopedOrg);
  assert.ok(org, "E2E_DEV_ORG_ID must identify a pre-seeded disposable org");
  const account = org.igAccounts[0];
  assert.ok(account, "E2E fixture org requires a mock Instagram account");
  assert.equal(account.provider, "mock", "E2E uses the explicit mock messaging provider only");
  const seat = await db.findSeat(scopedOrg, "user_demo_local");
  assert.ok(seat, "E2E fixture org requires the local demo creator seat");

  await db.setVoiceConsent(scopedOrg, account.id, seat.id, true);
  await db.upsertBusinessContext(scopedOrg, {
    businessSummary: "Test fitness coach selling a coaching programme.",
    typicalCoachingMinor: { min: 100_000, max: 250_000 },
  });
  for (const project of ["chromium", "mobile"]) {
    const nonce = `e2e-${project}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const message = await db.upsertInboundMessage(scopedOrg, {
      igAccountId: account.id,
      igThreadId: nonce,
      participantHandle: `e2e.${project}`,
      participantIgId: nonce,
      igMessageId: `${nonce}-message`,
      direction: "inbound",
      text: "I want 1:1 coaching. What is the price and how can I start?",
      sentAt: new Date(),
      source: "live",
    });
    assert.ok("messageId" in message && "threadId" in message, "E2E fixture inbound message was not persisted");
    await db.saveClassification(scopedOrg, {
      messageId: message.messageId,
      label: "coaching_lead",
      confidence: 0.99,
      language: "en",
      valueMinMinor: 10_000_000,
      valueMaxMinor: 12_000_000,
      rationale: "Direct coaching purchase enquiry.",
      modelVersion: "heuristic-e2e-fixture",
      promptVersion: "e2e-fixture",
      routedTo: "inbox",
      source: "live",
    });
  }

  // Deleting a whole org is deliberately opt-in: a CI harness may create an
  // org exclusively for this run, while local diagnostics often reuse a seed.
  return async () => {
    if (process.env.E2E_DELETE_ORG === "true") await db.hardDeleteOrg(scopedOrg);
  };
}
