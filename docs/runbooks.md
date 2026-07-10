# DealDock — On-Call Runbooks

**Audience:** founding team. **Scope:** pilot (single API + single worker instance).
**Golden rule:** creators' IG accounts and their money data outrank uptime. When in doubt, stop ingestion rather than risk account safety or data integrity.

## 0. Health surface

| Signal | Where | Healthy |
|---|---|---|
| API | `GET /health` (Railway health check + uptime monitor) | 200, <500ms |
| Worker | Railway process status + queue depths | consuming |
| Queue depth | BullMQ (Redis) — `ingestion`, `classification`, `drafting` | < 500 each, draining |
| Ingestion lag | `getIngestionLagsMs` sample / weekly metrics | p95 < 60s |
| Meta rate headroom | adapter budget logs | > 20% |
| Claude spend | Anthropic console, per-day | < set org threshold |

Alerting windows follow org timezones (pilot ≈ IST 8:00–23:00). Page on: API /health failing 3×, ingestion queue > 2000, any `retention tick failed`.

---

## 1. Meta / Instagram outage or policy break

**Symptoms:** webhook volume drops to zero, Graph calls return 5xx/4xx bursts, `token_expired` storms.

1. Check [Meta status](https://metastatus.com) and the app dashboard for policy notices.
2. **Do nothing destructive.** Ingestion self-heals: the 15-min backfill sweeps `listConversations(since)` on recovery — no messages are lost on the IG side (PRD §7.6).
3. If it's a *policy/permission revocation* (not outage): freeze sends — set the worker's Graph accounts to paused by marking status via Portal ops; creators can still triage and reply natively.
4. Post a banner note to affected creators (manual in pilot): "Instagram is having issues; your inbox will catch up automatically."
5. After recovery: verify backfill checkpoints advanced (`IngestionCheckpoint.lastBackfillAt`), spot-check one account's thread count vs IG app.

**Never:** retry sends in a loop against policy errors; that's how accounts get flagged.

## 2. Queue backlog (ingestion/classification piling up)

**Symptoms:** queue depth alert, inbox lag complaints, load p95 > 60s.

1. Identify the slow stage: depth per queue. Classification slow → usually Claude latency; ingestion slow → DB or Redis.
2. Claude degraded → see runbook 3. DB CPU pegged → check for a missing-index query in recent deploy; roll back first, investigate second.
3. Scale-up (Railway): bump worker instances — every consumer is idempotent (`igMessageId` unique; classification upsert), so horizontal scaling is safe.
4. If backlog is from a leak-scan batch of a big onboarding: expected — leak-scan jobs share the queue; they drain. Only act if LIVE messages lag (check a fresh DM end-to-end).
5. Post-incident: record peak depth + drain time in the weekly review.

## 3. Claude API degradation

**Symptoms:** classification jobs failing/retrying, drafting timeouts, Anthropic status page incidents.

1. Confirm on the Anthropic status page; check error class (429 vs 5xx vs auth).
2. **429/spend cap:** check daily spend; raise cap or lower classification concurrency (worker env) — never disable the confidence gate.
3. **Extended outage:** messages keep ingesting (inbox rows appear without badges — degraded but honest). Do NOT flip to the heuristic in production — heuristic rows would need re-classification and its quality never met the bar (`heuristic-fallback-1` stamps exist so any accidental rows are findable and re-runnable).
4. On recovery, jobs retry automatically. Re-enqueue any dead-lettered classification jobs.
5. If drafts were the casualty: creators saw "Drafting…" states; no action needed — regenerate is on-demand.

## 4. Billing webhook loss / state drift (Razorpay or Paddle)

**Symptoms:** creator paid but shows `pending_first_invoice`/`past_due`; rail dashboard disagrees with our `Subscription.status`.

1. Don't touch the DB by hand. The **reconciliation poller** fetches remote status daily and applies the same normalized events — force a run by triggering the billing scheduler job.
2. Check `WebhookEvent` rows for the rail: signature failures (secret rotated?) show up as 401s in API logs.
3. If the rail secret rotated: update `RAZORPAY_WEBHOOK_SECRET` / `PADDLE_WEBHOOK_SECRET`, redeploy API, reconcile.
4. Paddle-specific: a `txn_…` externalId that never became `sub_…` means checkout was abandoned — the creator needs the checkout link again (`Subscription.checkoutUrl`).
5. **Grace stance:** payment confusion never cuts features for 7 days (`past_due` is a banner, not a wall). Fix state before it matters.

## 5. Token-expiry storm (many accounts disconnect at once)

**Symptoms:** many `token_expired` marks in a short window.

1. Usually one cause: app secret rotated, app switched dev/live mode, or a Meta-side permission change — check the app dashboard first. Individual expiries are normal (60-day tokens; the token-health job refreshes ahead of expiry).
2. Fix the app-level cause, then creators reconnect via Settings (banner already prompts them).
3. Backfill covers the gap after reconnect — verify checkpoints advance.

## 6. Database restore

1. Neon point-in-time restore to a branch; verify counts on the branch before promoting.
2. Reconcile after restore: run backfill (fills IG-side gaps newer than the restore point) and billing reconciliation (rails are the billing source of truth).
3. Ledger entries created after the restore point are creator-entered and NOT recoverable from anywhere else — this is why restore-point verification comes before promotion. Communicate any confirmed loss honestly and immediately.

## 7. Deletion request during an incident

Retention is a daily tick. If a creator requests deletion mid-incident, nothing special is needed — the 7-day grace absorbs incident time. If legal/urgent, run the manual path: `npm run drill:deletion` logic applies (backdate is drill-only; for real urgency call `hardDeleteOrg` from a maintenance script) and record the residue check output.

---

## Escalation & cadence

- **Weekly:** metrics dashboard review (accuracy, fidelity, lag p95, queue peaks, spend) — PRD §7.4.
- **Quarterly:** Meta platform-feature review (PLAN.md risk #11) + dependency audit (`npm audit`) + token-crypto key rotation.
- Incidents get a 5-line postmortem in this file's changelog: what, impact, cause, fix, prevention.

## Accepted risks (review quarterly)

| Date | Finding | Assessment | Revisit when |
|---|---|---|---|
| 2026-07-06 | `npm audit`: postcss <8.5.10 XSS-in-stringify (GHSA-qx2v-qp2m-jg93), transitive via next + @clerk/nextjs, no fix published | Build-time CSS tooling only; we never stringify untrusted CSS at runtime. Accepted. | Next.js releases a patched version — bump on next dependency pass |
