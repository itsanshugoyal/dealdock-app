# 05b — Backend inventory (read-only)

31 October 2026. This is a read-only inventory of `apps/api`, `apps/worker`, `packages/{db,core,ai,messaging}`, the Prisma schema, migrations, boundary scripts and CI, written so the redesigned frontend and new features (edit-learning, audio, insights) integrate without breaking invariants. No code was changed. Every `file:line` is relative to `c:\code\dealdock-app`.

---

## 0. Ground rules the frontend must know

| Topic | Fact | Source |
|---|---|---|
| Base | Fastify on `PORT` (default 4000). CORS allows only `WEB_APP_URL` (default `http://localhost:3100`), `credentials: true`, methods GET/POST/PUT/PATCH/DELETE. Body limit 512 KB. Rate limit 300 req/IP/min (webhooks exempt). | `apps/api/src/index.ts:34-50` |
| Auth | `Authorization: Bearer <Clerk session JWT>`. The tenant comes **only** from the signed Clerk org claim (`org_id` or compact `o.id`). A valid session without an org claim gets 403 `org_membership_required`, and without a `Seat` row gets 403 `no_seat_in_org`. | `apps/api/src/auth.ts:33-81`, `clerk-claims.ts:2-6` |
| Dev bypass | Only when `CLERK_SECRET_KEY` is unset, `NODE_ENV!=production`, `DEALDOCK_DISABLE_AUTH=true` and `DEALDOCK_DEV_ORG_ID` is set: header `x-demo-org: <DEALDOCK_DEV_ORG_ID>` acts as clerk user `user_demo_local`. Otherwise 500 `auth_not_configured`. | `auth.ts:36-54` |
| Web dev bridge | `apps/web/src/app/api/dev/[...path]/route.ts:9` proxies only first path segments in an allowlist: `onboarding, inbox, review-queue, dashboard, threads, classifications, ledger, settings, notifications, billing, account, me, seats, roster, ig`. **`/metrics/*` and `/organizations/*` are not in it.** Any new top-level route must be added there for local integration. It forwards only `content-type` and `idempotency-key`. | that file, lines 2-19 |
| Money | Every amount is an integer in **minor units** (paise/cents) as a JS number. Postgres BIGINT is converted with a safe-integer check. Format only with `@dealdock/core` `formatMoneyExact/Compact/Range` (en-IN → L/Cr). | `packages/core/src/money.ts:59-105`, `packages/db/src/money.ts:5-18` |
| Currency | Org currency is immutable (DB trigger + repo checks). Allowed: INR, USD, GBP, EUR, AED. | `migrations/202610280001_finish_safety/migration.sql:11-20` |
| Dates | Prisma `Date` objects serialize to ISO-8601 strings. | — |
| Labels | `brand_deal, coaching_lead, course_inquiry, other_commerce, fan, spam, personal, uncertain`. High-intent = first four. Review threshold 0.8. | `packages/core/src/index.ts:17-40` |
| Roles | `creator`, `assistant` (Studio), `manager` (Roster). | `packages/core/src/permissions.ts` |

### 0.1 Permission matrix (`can(role, action)`)

| action | creator | assistant | manager |
|---|---|---|---|
| send, review, close | yes | yes | yes |
| view_roster | yes | no | yes |
| manage_seats | yes | no | yes |
| manage_billing | yes | no | no |
| manage_settings | yes | no | no |
| export_data | yes | no | yes |

Source: `packages/core/src/permissions.ts:27-58`. Guard failures: `requirePermission` → 403 `{error:"forbidden", action}`. `requireWritable` → 403 `{error:"org_read_only", hint}` when the subscription is `cancelled` and past `currentPeriodEnd` (`apps/api/src/guards.ts:10-27`, `packages/db/src/repos/billing.ts:256-264`).

### 0.2 Global error mapping (`setErrorHandler`)

`apps/api/src/index.ts:67-74`. Errors thrown from repos are snake_case strings mapped by regex:

- message matches `/not in org|not_in_org|not_found/` → **404** `{error:"not_found"}`
- matches `/conflict|immutable|consent_required|already_claimed|send_in_flight/` → **409** `{error:<message>}`
- has `statusCode` (zod-region 400, 413 `WEBHOOK_BODY_TOO_LARGE`, 429 rate limit) → that code, `{error:<message>}`
- otherwise **500** `{error:"request_failed"}`

**Convention for new repo errors:** name them so the regex maps them correctly (`x_not_in_org` → 404, `x_conflict` → 409). An unmapped domain error becomes a 500 (several exist today, see §6).

---

## 1. API contract (every route)

Legend: **A** = `requireAuth`, **W** = `requireWritable`, **P(x)** = `requirePermission(x)`. "400 body" = `{error:"invalid_body"}` (sometimes with `detail: zodFlatten`).

### 1.1 Health / bootstrap / identity

| Method path | Guards | Request | 2xx response | Errors |
|---|---|---|---|---|
| GET `/health` | none | — | `{status:"ok", service:"dealdock-api", ts:string}` | — |
| GET `/ready` | none | — | `{status:"ready"}` (DB + Redis ok) | 503 `{status:"unavailable"}` |
| POST `/organizations/bootstrap` (`routes/bootstrap.ts:9`) | Bearer + Clerk **org admin** claim (no seat needed) | `{currencyCode:"INR"\|"USD"\|"GBP"\|"EUR"\|"AED", locale:string(2-20), timezone:string(3-80)}` | 201 (created) / 200 (exists) `{id:string, created:boolean}`. Creates Org (id = Clerk org id, tier `solo`), User, creator Seat, Subscription(tier solo, rail by currency), audit row. | 503 `auth_not_configured`; 401 `unauthenticated`/`invalid_token`; 400 `invalid_body`/`invalid_region`; 403 `organization_admin_required`/`verified_email_required` |
| GET `/me` (`routes/inbox.ts:19`) | A | — | `{clerkUserId, orgId, role}` | 401/403 |
| POST `/seats/activate` (`routes/seats.ts:15`) | Bearer (no seat) | — | `{activated:true, seatId, role}` | 503 `invite_activation_unavailable`; 401; 403 `org_membership_required`/`verified_email_required`; 404 `matching_invitation_not_found` |

### 1.2 Inbox / threads / send gate

| Method path | Guards | Request | 2xx response | Errors |
|---|---|---|---|---|
| GET `/inbox?state=open\|waiting\|closed` (`routes/inbox.ts:7`) | A | query `state` (anything else → `open`) | `{rows: InboxRow[]}`. `InboxRow = {threadId, participantHandle, state, lastMessageAt, topLabel:Label\|null, estValueMaxMinor:number\|null, estCurrencyCode:string\|null, preview:string\|null, messageCount:number, unreplied:boolean}`. Fixed limit 50, sort value desc then recent. Side effect: starts the billing active-use clock. | — |
| GET `/threads/:id` (`routes/threads.ts:67`) | A | — | `ThreadDetail = {id, participantHandle, state, waitingSince\|null, topLabel\|null, estValueMaxMinor\|null, igAccountId, igThreadRemoteId, messages:[{id, direction:"inbound"\|"outbound", contentType:"text"\|"audio"\|"attachment", text, sentAt, classification:{id,label,confidence,rationale\|null,valueMinMinor\|null,valueMaxMinor\|null}\|null}], sendInFlight:boolean, currentDraft:{id, body, kind:"reply"\|"nudge", status:"ready"\|"edited", version}\|null, closedDeals:[{id, amountMinor, dealType, closedAt}]}` (`packages/db/src/repos/threads.ts:35-84`) | 404 `not_found` |
| POST `/threads/:id/draft` (`threads.ts:75`) | A, W, P(send) | none | `{id, body, version}`. Synchronous Claude call; discards any prior ready/edited draft. | 404; 409 `voice_modeling_disabled`, `voice_consent_required`, `draft_send_in_flight`; 500 on model error |
| POST `/threads/:id/send` (`threads.ts:116`) — **THE SEND GATE** | A, W, P(send) | body `{draftId:string, finalText:string(1-4000), idempotencyKey?:string(16-200)}` + header `Idempotency-Key` (header wins; must match `^[A-Za-z0-9._:-]{16,200}$`) | 200 `{status:"accepted", sent:true, intentId, messageId, editDistance:number}`; 202 `{status:"pending"\|"remote_accepted"\|"persisted"\|"unknown", intentId, hint}` (already claimed / retry); 202 `{error:"send_result_ambiguous", status:"unknown", intentId, hint?}` (provider window/token/rate error) | 400 body / `idempotency_key_required`; 404 `draft_not_found_or_already_sent`; 409 `account_not_active`, `send_window_closed` (24h pre-check, Graph only), `send_idempotency_key_conflict`, `draft_not_sendable_or_already_claimed`; 500 other provider errors (intent left `unknown`) |
| POST `/threads/:id/close` (`threads.ts:218`) | A, W, P(close) | body `{amountMinor:int>0, dealType:"brand"\|"coaching"\|"course"\|"other", note?:string≤500}` + **header** `Idempotency-Key` (body key not accepted) | `{entryId, amountMinor}`. Sets thread `closed`. | 400 body / `idempotency_key_required`; 404; 409 `close_idempotency_key_conflict` |
| POST `/threads/:id/nudge/dismiss` (`threads.ts:236`) | A, W, P(close) | — | `{dismissed:true}` | 404 |
| PATCH `/threads/:id` (`threads.ts:243`) | A, W, P(close) | `{state:"open"\|"waiting"\|"closed"}` | `{state, waitingSince:string\|null}` | 400; 404 |

### 1.3 Review queue

| Method path | Guards | Request | 2xx response | Errors |
|---|---|---|---|---|
| GET `/review-queue` (`routes/review.ts:24`) | A | — | `{rows:[{classificationId, threadId, handle, text, sentAt, bestGuess:Label, confidence:number, rationale:string\|null}]}` oldest first, limit 50 | — |
| POST `/classifications/:id/review` (`review.ts:30`) | A, W, P(review) | `{outcome:"confirmed"\|"overridden", overrideLabel?:Label}` | `{label, outcome}`. Idempotent: the first human decision wins. | 400; 404; **500** if `overridden` without `overrideLabel` (unmapped) |

### 1.4 Ledger / dashboard / metrics

| Method path | Guards | Request | 2xx response | Errors |
|---|---|---|---|---|
| GET `/ledger?month=YYYY-MM` (`routes/ledger.ts:14`) | A | optional month (org timezone) | `{months:[{month, totalMinor, count}] (asc), selectedMonth, timezone, currencyCode, totalMinor, biggestMinor, avgMinor, byType:{brand?,coaching?,course?,other?:number}, entries:[{id, closedAt, handle, threadId, dealType, amountMinor, currencyCode, note\|null}]}` (`repos/ledger.ts:184-208`) | 404 |
| PATCH `/ledger/:id` | A, W, P(close) | `{amountMinor?, dealType?, note?≤500}` | `{id, amountMinor}` | 400; 404 |
| DELETE `/ledger/:id` | A, W, P(close) | — | `{deleted:true}` (soft delete) | 404 |
| GET `/ledger/export.csv` | A (works read-only) | — | `text/csv` attachment, header `date,handle,deal_type,amount_minor,currency,note`, formula-injection escaped. Date is a UTC slice (`ledger.ts:52`). | — |
| GET `/dashboard` (`ledger.ts:65`) | A | — | `{org:{currencyCode, locale, name}\|null, mtdRecoveredMinor, mtdDealCount, prevMonthMinor, biggestMinor, avgMinor, needsYou:[{threadId, handle, label, estValueMaxMinor, lastMessageAt}] (top 3 open by value), reviewQueueCount}` (`repos/ledger.ts:212-257`) | — |
| GET `/metrics/weekly` (`routes/settings.ts:98`) | A (no role check) | — | `{since, sends, nudgesSent, voiceFidelity:number\|null, classificationAccuracy:number\|null, reviewQueueDepth, avgReviewClearanceHours:number\|null, dealsClosed}` — trailing 7 days, heuristic rows excluded (`repos/metrics.ts:80-120`) | — |

### 1.5 Onboarding / leak scan

| Method path | Guards | Request | 2xx response | Errors |
|---|---|---|---|---|
| GET `/onboarding` (`routes/onboarding.ts:21`) | A | — | `{currencyCode, locale, timezone, businessContext:object\|null, igAccounts:[{id, handle, voice:{enabled, consentedAt, revokedAt}\|null}], voiceConsent:[{igAccountId, consented}], complete:boolean}` | 404 `org_not_found` |
| PUT `/onboarding` (`onboarding.ts:28`) | A, W, P(manage_settings) | `{businessContext: Record<string,unknown> (non-empty), currencyCode, locale(2-20), timezone(3-50), ignoreHandles?:string[≤200], voiceConsent?:boolean, igAccountId?:string}` | `{currencyCode, locale, timezone, complete}` | 400 body/region; 409 `currency_immutable_for_organization` (with hint), `no_connected_account` |
| POST `/onboarding/leak-scan` (`onboarding.ts:53`) | A, W, P(manage_settings) | — | 202 `{scheduled:true, enqueued:0}` (constant 0; async API-owned job) | 409 `no_connected_account` |
| GET `/onboarding/leak-scan` (`onboarding.ts:63`) | A | — | `{scannedCount, commerceCount, totalMinMinor, topThreads:[{threadId, handle, label, estValueMaxMinor}] (≤3)}` — no progress/state field | — |

`businessContext` keys actually consumed by AI: `businessSummary:string`, `typicalBrandDealMinor|typicalCoachingMinor|typicalCourseMinor: {min,max}` (minor units). Other keys are stored but ignored (`repos/creator-context.ts:42-56`). The server adds `currencyCode` (`repos/settings.ts:73`).

### 1.6 Settings / data controls / voice

| Method path | Guards | Request | 2xx response | Errors |
|---|---|---|---|---|
| GET `/settings` (`routes/settings.ts:36`) | A | — | `{currencyCode, locale, timezone, nudgeDelayDays, accounts:[{id, handle, status:"active"\|"disconnected"\|"token_expired", provider:"mock"\|"instagram_graph"}], voiceConsent:[{igAccountId, consented}], deletionRequestedAt\|null}` | 404 |
| PUT `/settings/voice/consent` | A, W, P(manage_settings) | `{igAccountId, consented:boolean}` | `{consented}` (revoke clears styleCard/samples and discards unsent drafts) | 400; 404 |
| POST `/settings/voice/resample` (`settings.ts:64`) | A, W, P(manage_settings) | — | `{styleCard:{greeting, tone, sentenceLength, signoff, emojiUsage, codeSwitching, characteristicPhrases[]}, modelVersion}`. Synchronous model call. | 409 `no_connected_account`, `voice_modeling_disabled`, `not_enough_samples` (<3), `voice_consent_required`/`voice_consent_changed` |
| PUT `/settings/voice` | A, W, P(manage_settings) | `{enabled:boolean}` | `{enabled}` | 400; 409 `voice_consent_required` (enabling requires consent on **every** account) |
| PUT `/settings/region` | A, W, P(manage_settings) | `{currencyCode?, locale?≤20, timezone?≤50, nudgeDelayDays?:1-14}` | `{currencyCode, locale, timezone, nudgeDelayDays}` | 400; 409 `currency_immutable_for_organization` |
| GET `/settings/data` | A | — | `{messagesProcessed, classifications, draftsGenerated, ledgerEntries, auditRows, storingSince, deletionRequestedAt}` | — |
| POST `/settings/export` | A, P(export_data) (not W) | — | JSON attachment `{exportedAt, org, threads[{…, messages[{…, classification}], drafts[]}], ledger[], audit[]}` | — |
| DELETE `/account` | A, W, P(manage_settings) | — | `{scheduled:true, gracePeriodEnds, hint}` | — |
| POST `/account/cancel-deletion` | A, W, P(manage_settings) | — | `{cancelled:boolean}` | — |
| GET `/settings/ignore-list` | A | — | `{handles:string[]}` (org-wide rules only) | — |
| PUT `/settings/ignore-list` | A, W, P(manage_settings) | `{handles:string[≤200]}` | `{handles}` (echoes the input, not the normalized values) | 400 |

### 1.7 Instagram connection

| Method path | Guards | Request | 2xx response | Errors |
|---|---|---|---|---|
| POST `/ig/connect` (`routes/ig.ts:53`) | A, W, P(manage_settings) | — | `{authorizeUrl}` (state = HMAC(orgId.ts), 15 min TTL) | 503 `meta_app_not_configured` (missing or unsafe `IG_OAUTH_REDIRECT_URI`; must be https and end in `/ig/callback`) |
| GET `/ig/callback?code&state&error_description` (`ig.ts:65`) | none (signed state) | — | **302** → `${WEB_APP_URL}/onboarding?connected=<handle>` | JSON (not redirect): 400 `oauth_denied`/`invalid_state_or_code`; 404 `org_not_found`; 502 `instagram_connection_failed`; 409 `personal_account {guidance}`; **500** for `account_connected_to_other_org`, `ig_account_limit:N`, webhook-subscribe failure |
| POST `/ig/disconnect` (`ig.ts:116`) | A, W, P(manage_settings) | — (no account id) | `{disconnected:true}` (first account only) | 409 `no_connected_account` |

### 1.8 Billing, seats, roster, notifications

| Method path | Guards | Request | 2xx response | Errors |
|---|---|---|---|---|
| GET `/billing` (`routes/billing.ts:18`) | A | — | no row: `{status:"pilot_manual", rail:null}`; else `{status:"pending_first_invoice"\|"active"\|"past_due"\|"cancelled", rail:"razorpay"\|"paddle", tier, checkoutUrl\|null, activeUseStartedAt, currentPeriodEnd, cancelledAt}` | — |
| POST `/billing/cancel` | A, W, P(manage_billing) | — | `{cancelled:true, runsUntil}` | 409 `no_subscription`; 502 `cancel_failed_at_rail` |
| POST `/webhooks/razorpay`, `/webhooks/paddle` | provider signature | raw body | `{ok:true, unresolved:number}` | 401 (empty) |
| GET `/seats` (`routes/seats.ts:16`) | A | — | `{seats:[{id, role, email, name\|null, activated:boolean, createdAt}], limits: TIER_LIMITS}` (`limits` holds **all** tiers, not the org's tier) | — |
| POST `/seats/invite` | A, W, P(manage_seats) | `{email, name?≤120, role:"assistant"\|"manager"}` | `{seatId, role}` (placeholder user `invited:<email>`; no email is sent) | 400; 409 `seat_limit_reached`, `role_not_allowed_on_tier` |
| DELETE `/seats/:id` | A, W, P(manage_seats) | — | `{removed:true}` | 409 `cannot_remove_own_seat`; **500** `cannot_remove_creator` |
| GET `/roster` (`routes/roster.ts:9`) | A, P(view_roster) | — | `{rows:[{igAccountId, handle, status, mtdRecoveredMinor, unreadHighPriority, reviewQueueSize}]}` | 403 |
| GET `/notifications/prefs` | A | — | `{notifyHighValue, notifyNudge, notifyWeeklySummary, subscribed}` (defaults all true when unsubscribed) | — |
| POST `/notifications/subscribe` | A, W | `{endpoint:url (FCM/Mozilla/Apple/WNS hosts only), keys:{p256dh, auth}}` | `{subscribed:true}` | 400 |
| DELETE `/notifications/subscribe` | A, W | `{endpoint}` | `{unsubscribed:true}` | 400 `endpoint_required` |
| PUT `/notifications/prefs` | A, W | `{notifyHighValue?, notifyNudge?, notifyWeeklySummary?}` | `{updated:true}` | 409 `weekly_summary_unavailable` when enabling weekly |

### 1.9 Platform webhooks

| Method path | Auth | Behaviour |
|---|---|---|
| GET `/webhooks/instagram` | `hub.verify_token == META_WEBHOOK_VERIFY_TOKEN` | echoes `hub.challenge` as text/plain, else 403 |
| POST `/webhooks/instagram` (`routes/webhooks.ts:76`) | `X-Hub-Signature-256` HMAC (`META_APP_SECRET`) over the raw body | parse → resolve org by business IGSID → `recordWebhookIngress` (one DB transaction: WebhookEvent + per-org scope + OutboxEvent per message) → 200 `{received, accepted, deduplicated}` |
| POST `/webhooks/mock` | only if `NODE_ENV!=production` **and** `MOCK_WEBHOOK_SECRET` is set; header `x-mock-secret` | body `{events: IngestionJob[1..500]}` → 202 `{accepted, deduplicated}` |

Routes listed in ARCHITECTURE §6.1 that **do not exist**: `GET /billing/portal`, inbox `sort`/`label`/`age`/`unreplied` query params.

---

## 2. Worker jobs, queues and schedules

Queue names are a single registry: `QUEUES = {ingestion, classification, drafting, backfill, nudges, notifications, billing, retention}` (`packages/core/src/index.ts:96-105`). Note that **the API process also runs a BullMQ Worker** (the `backfill` queue).

| Queue / job | Process | Trigger | Payload | What it does |
|---|---|---|---|---|
| *(outbox dispatcher, not BullMQ)* | worker | `setInterval` 1s (`consumers/outbox.ts:60-67`) | DB `OutboxEvent` rows of kind `ingestion`/`classification` | Leases up to 100 rows (5 in parallel), publishes to BullMQ with `jobId = sha256(dedupeKey)`, marks the row complete; on failure it releases the lease with a 30s delay. Ingestion jobs carry only `{orgId, ingressEventId}` (no DM text in Redis). |
| `ingestion` | worker, concurrency 10 (`consumers/ingestion.ts`) | dispatcher | `{orgId, ingressEventId}` → loads `IngestionJob` from the outbox | `upsertInboundMessage` (thread upsert, dedupe by `igMessageId`, waiting→open on inbound, ignore list, and a **classification outbox row in the same tx**), then `touchWebhookCheckpoint`. Production refuses inline payloads. |
| `classification` | worker, concurrency 5 (`consumers/classification.ts`) | dispatcher (outbox kind `classification`) | `{orgId, igAccountId, messageId, source:"live"\|"leak_scan"}` | ignored → skip; `contentType!=="text"` → `uncertain`, conf 0, review queue, model `content-flag` (`:42-60`); else Claude classify → route (≥0.8 and not uncertain → inbox); live+inbox+high-intent+voiceEnabled → `drafting:"draft"`; live+inbox+high-intent+`valueMax ≥ HIGH_VALUE_NOTIFY_MIN_MINOR` (default 5,000,000 minor) → `notifications:"high-value"`. A model error persists an `uncertain` review row then rethrows. |
| `drafting` | worker, concurrency 3 (`consumers/drafting.ts`) | classification (`draft`), nudge scheduler (`nudge-draft`) | `{orgId, igAccountId, threadId, replyToMessageId?, label, kind:"reply"\|"nudge"}` | Skips when the thread is gone, the handle is ignored or voice is disabled; else `pipeline.draft` → `createDraft` (discards prior ready/edited, refuses if a send is in flight or consent is missing). |
| `nudges` / `nudge-tick` | worker (`consumers/nudges.ts`) | `upsertJobScheduler` every **30 min** | — | `listNudgeCandidates()` (cross-org, waiting ≥ `nudgeDelayDays`, not dismissed, no live nudge draft, take 500) → `drafting:"nudge-draft"` + `notifications:"nudge-due"`. |
| `notifications` | worker, concurrency 4 (`consumers/notifications.ts`) | classification, nudges, billing | `{orgId, kind:"high_value"\|"nudge"\|"weekly_summary"\|"billing_checkout_ready", threadId?, handle?, valueMaxMinor?, currencyCode?, locale?, checkoutUrl?, summaryText?}` | VAPID web push; `listPushTargets` drops everything outside 08:00–23:00 in the org timezone (no deferral) and filters by the per-kind toggle; prunes 404/410 endpoints. Skips when VAPID is not configured. Payload `{title, body, url}` with deep links `/thread/:id`, `/inbox?filter=waiting`, `/`, `/settings`. |
| `billing` / `first-invoice-tick` | worker (`consumers/billing.ts`) | every **1 h** | — | Subscriptions `pending_first_invoice` with active use ≥7 days → `claimFirstInvoice` → rail `createSubscription` → `saveRailSubscription` → `notifications:"billing-checkout-ready"`. |
| `billing` / `reconcile-tick` | worker | every **24 h** | — | `fetchStatus` per rail sub → `applyBillingEvent`. |
| `retention` / `retention-tick` | worker (`consumers/retention.ts`) | every **24 h** | — | `listOrgsDueHardDelete` (7-day deletion grace or 30 days after cancel) → `hardDeleteOrg` (cascade). |
| `backfill` / `graph-backfill` | **API** (`apps/api/src/graph-maintenance.ts:50-70`) | every **15 min** | — | For each active Graph account: refresh the token if it is ≥7 days old, `listConversations`/`fetchMessages` since `lastBackfillAt − 30 min`, and write ingestion outbox rows (`dedupeKey history:<acct>:<mid>`). `TokenExpiredError` → `markTokenExpired`. |
| `backfill` / `leak-scan` | **API** | `POST /onboarding/leak-scan` → `scheduleLeakScan` (jobId sha256 of org+account) | `{orgId, igAccountId}` | The same scan over 30 days with `source:"leak_scan"` (classification produces no drafts or pushes for leak-scan rows). |

Retry semantics: only queues created through `pipelineQueue()` get `attempts:3` with exponential backoff (`apps/worker/src/connection.ts:18-31`). That covers just the drafting/notification queue handles used **by the classification consumer**. Jobs published by the outbox dispatcher (ingestion, classification) and by the nudge/billing producers use plain `new Queue` with no `attempts`, so each runs **once**.

**Not implemented:** a send-intent reconciliation consumer (`listSendIntentsNeedingReconciliation` exists at `packages/db/src/repos/drafts.ts:220` with no caller), any `weekly_summary` producer, weekly voice refresh, token-expiry user notification, style/edit learning, audio handling.

---

## 3. DB repositories (`packages/db/src/repos/*`, all re-exported from `packages/db/src/index.ts:9-26`)

| File | Exports and purpose |
|---|---|
| `orgs.ts` | `createOrganizationWithCreator` (seed/tests: org+user+seat+IG account+checkpoint+voice profile), `getOrganization` (includes `igAccounts`, `seats.user`), `provisionOrganization` (Clerk bootstrap, advisory lock, Subscription tier **solo**), `findDemoBootstrap`, `findSeat(orgId, clerkUserId)`, `getOnboardingProfile`, `isOnboardingComplete` (needs businessContext + an account + a consent decision) |
| `ingestion.ts` | `upsertInboundMessage` (the idempotent write + classification outbox), `enqueueClassificationOutbox` (unused), `getMessageForClassification`, `recordWebhookEvent`, `scopeWebhookEventToOrg`, `recordWebhookIngress` (atomic webhook+outbox, cross-org dedupe guard), `enqueueIngestionOutbox`, `listRecoverableOutboxEvents`*, `getIngestionOutboxPayload`, `claimOutboxEvent`*, `completeOutboxEvent`*, `releaseOutboxEvent`*, `markWebhookProcessed`*, `touchWebhookCheckpoint` |
| `inbox.ts` | `listInboxThreads(orgId, {limit, state, label, unrepliedOnly, sort:"value"\|"recent"\|"oldest_unread"})` (the route uses only `state`), `countMessages`, `countClassifications` |
| `classifications.ts` | `saveClassification` (enforces <0.8/uncertain → review, money checks, thread lock, upsert unless human-reviewed, refreshes `topLabel/estValueMaxMinor/hasPendingReview`), `listReviewQueue`, `reviewClassification` (thread lock, first decision wins, audit), `listRecentOverrides(orgId, igAccountId, 10)` |
| `threads.ts` | `getThreadDetail`, `dismissNudge` (sets `nudgeDismissedAt`, discards nudge drafts, audit), `setThreadState` (audit) |
| `drafts.ts` | `createDraft` (thread lock + `VoiceProfile FOR SHARE` consent check; version++), `getDraftForSend`, `claimDraftForSend`†, `releaseDraftClaim`†, `createSendIntentClaim`, `markSendIntentRemoteAccepted`, `markSendIntentUnknown`, `listSendIntentsNeedingReconciliation`*†, `persistSendIntent` (message upsert, draft→sent with `finalText`+`editDistance`, audit `message.sent` with `{originalDraft, finalText, editDistance, intentId}`), `recordSend`† |
| `ledger.ts` | `closeDeal` (idempotent createMany, thread→closed, audit), `updateLedgerEntry`, `deleteLedgerEntry` (soft), `getLedger(orgId, month?)` (org-timezone months), `getDashboard` |
| `creator-context.ts` | `getCreatorContext(orgId, igAccountId)` (the **only** prompt-context assembler: org businessContext + account style card + account corrections + `voiceEnabled`), `upsertBusinessContext` (tests only) |
| `system.ts` | `checkDatabaseReadiness`, `disconnectDatabase`, `requireUtf8Database`, `listNudgeCandidates`* |
| `metrics.ts` | `getLeakScanSummary`, `getIngestionLagsMs` (load test), `getWeeklyMetrics` |
| `voice.ts` | `getSentSamples(orgId, igAccountId, 30)` (null without consent), `saveStyleCard` (row lock + consent-version check), `setVoiceConsent` (revoke clears card/samples and discards drafts) |
| `ig-accounts.ts` | `connectGraphAccount` (serializable, org row lock, tier cap roster=5 else 1, reconnect path), `getConnectedAccount` (**only decryption path**), `saveRefreshedGraphToken`, `disconnectAccount` (drops token), `markTokenExpired`, `findAccountByPlatformUserId`*, `listActiveGraphAccounts`*, `updateBackfillCheckpoint` |
| `billing.ts` | `ensureSubscription`† (tests only), `markActiveUseStarted`, `getSubscription`, `listSubscriptionsDueFirstInvoice`*, `saveRailSubscription`, `claimFirstInvoice`, `releaseFirstInvoiceClaim`†, `applyBillingEvent`* (receipt dedupe, stale/terminal guards), `requestCancellation`, `listSubscriptionsForReconciliation`*, `isOrgReadOnly` |
| `seats.ts` | `listSeats`, `inviteSeat` (serializable; solo: none, studio: 1 assistant, roster: managers), `removeSeat`, `activateInvitedSeat`, `getRosterOverview` |
| `push.ts` | `savePushSubscription` (re-homes an endpoint across orgs), `deletePushSubscription`, `updatePushPrefs`, `getPushPreferences`, `listPushTargets`* (quiet hours), `removeDeadSubscription`* |
| `settings.ts` | `updateRegion`, `upsertOnboardingProfile`, `getDataSummary`, `exportOrgArchive`, `requestAccountDeletion`, `cancelAccountDeletion`, `getIgnoreList(orgId, igAccountId?)`, `setIgnoreList(orgId, seatId, handles, igAccountId?)`, `isIgnoredHandle`, `setVoiceEnabled` |
| `retention.ts` | `listOrgsDueHardDelete`*, `hardDeleteOrg`*, `backdateDeletionRequest` (drill), `countOrgResidue` (drill: 17 tables must be 0) |

\* = SYSTEM CONTEXT (cross-org or id-keyed, no `OrgId`): used only by schedulers, the dispatcher or webhook org resolution. † = no production caller.

### 3.1 Conventions (follow these exactly)

1. **`OrgId` is the first parameter** of every tenant function (`type OrgId = string & {__brand}`, `asOrgId()` in `org-id.ts`). Look up by `{id, orgId}` with `findFirst` before any mutation, and never trust a bare id (`markTokenExpired` comment, `ig-accounts.ts:127`).
2. **Actor attribution:** call `requireSeatInOrg(orgId, seatId)` (`seat-scope.ts`) or check the seat inside the transaction. Write an `AuditLog` row `{orgId, seatId, action:"domain.verb", entityType, entityId, detail?}` in the **same transaction** for user mutations.
3. **Concurrency:** serialize per thread with `SELECT … FROM "Thread" WHERE id=… FOR UPDATE` inside `$transaction`. Consent-sensitive writes lock `VoiceProfile` (`FOR SHARE` in drafting, `FOR UPDATE` in style save). Cap checks use Serializable isolation.
4. **Money:** BigInt in the DB. Use `requireMinorUnits()` on write and `minorUnitsToNumber()` on read (`src/money.ts`). Month keys use `monthKeyInTimeZone(date, org.timezone)`.
5. **Errors:** throw `Error("snake_case")` that matches the API regex (§0.2).
6. **Prisma is internal:** `client.ts` and `crypto.ts` are never exported, and `index.ts` exports only repos plus `asOrgId`.
7. **Privacy completeness:** any new org-scoped table needs `orgId` + `onDelete: Cascade` from Organization (or a cascading parent), an entry in `countOrgResidue` (`retention.ts:84-106`, which the deletion drill asserts are all 0), inclusion in `exportOrgArchive`/`getDataSummary` (`settings.ts:97-149`), and, if voice-derived, clearing in `setVoiceConsent` revoke (`voice.ts:82-86`).

**Adding a repo function:** create or extend `packages/db/src/repos/<area>.ts` (`import { prisma } from "../client"; import type { OrgId } from "../org-id";`), add `export * from "./repos/<area>"` to `packages/db/src/index.ts` for a new file, rebuild (`apps/*` consume `dist/` via `main: dist/index.js`; turbo `build` dependsOn `^build`), add the Prisma model plus a hand-written migration (§5), and add an integration test under `packages/db/test/*.integration.test.ts`. **New integration test files must also be added to the explicit list in `scripts/run-integration-gate.mjs:37`** or CI will not run them.

---

## 4. Architecture boundary rules (enforced)

`npm run lint` = `node scripts/check-boundaries.mjs`. It scans every `apps/*/src` and `packages/*/src` file (TS AST via `scripts/boundary-rules.mjs`, covering static imports, `export … from`, `require()` and `import()`):

| Rule | Where | Exact check |
|---|---|---|
| DB only through repos | everywhere except `packages/db/` | forbids `@prisma/*`, `@dealdock/db/<deep path>`, `packages/db/(src\|dist)/(client\|crypto)`, `pg`, `postgres`, `mysql2`, `better-sqlite3` |
| Web is browser-safe | `apps/web/` | forbids importing `@dealdock/ai` or `@dealdock/messaging` (the web uses neither; provider capabilities belong to the API) |
| Worker has no send/Graph capability | `apps/worker/` | forbids modules containing `@dealdock/messaging`, `instagram`, `graph-adapter`, or ending `/graph`; forbids **identifiers** `sendMessage`, `getConnectedAccount`, `decryptToken`, `getGraphAdapter`, `InstagramGraphAdapter`; forbids string literals containing `graph.instagram.com`/`graph.facebook.com`; non-literal dynamic `import()`/`require()` is forbidden |
| Worker manifest | `apps/worker/package.json` | must not depend on `@dealdock/messaging` |
| Worker runtime | `apps/worker/src/index.ts:22-40` | exits if `TOKEN_ENCRYPTION_KEY`, `META_APP_SECRET`, `META_APP_ID`, `META_WEBHOOK_VERIFY_TOKEN` or `GRAPH_ACCESS_TOKEN` is set; requires `REDIS_URL` and `DATABASE_URL` (tested by `scripts/runtime-boundaries.test.mjs`) |
| Regression | `scripts/boundary-rules.test.mjs` | node:test cases pin the rules |

Implications for new features: **any provider send, Graph read or token use (including sending audio or fetching the sender profile with a token) must live in `apps/api`.** The worker may call AI/TTS/STT vendors and read and write via repos, but must not name `sendMessage` (choose a different method name for non-send helpers). A new `MessagingProvider` method is fine. Workers should get media by URL, never with a decrypted token.

---

## 5. Migrations, tests, env

### 5.1 Migrations
- Folder: `packages/db/prisma/migrations/<YYYYMMDDNNNN>_<snake_name>/migration.sql` (current: `0_init`, `202610260001_safety_invariants`, `202610280001_finish_safety`, `202610280002_billing_receipts`). The next migration would be `20261031000N_<name>`.
- **Hand-authored SQL**, forward-only, with comments, data backfills, CHECK constraints, partial unique indexes (`IgnoreListEntry`) and triggers (`freeze_organization_currency`). Applied with `prisma migrate deploy` (`npm run db:migrate -w @dealdock/db`).
- CI drift gate (`.github/workflows/ci.yml:83-85`): `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url … --exit-code`. Every Prisma-modelled column, index and enum in SQL must **exactly** match `schema.prisma`. Objects Prisma does not model (CHECKs, triggers, partial indexes) live only in SQL. `build` runs `prisma generate`.

### 5.2 Tests
- Vitest per package (`"test": "vitest run"`, no config files), tests in `packages/<pkg>/test/*.test.ts`. Unit tests exist for core (money, permissions, push endpoint, redis), ai (heuristic, pipeline-mode, routing-invariant, eval-scoring), messaging (adapter, oauth, corpus), billing (rails) and db (crypto).
- **`apps/api` and `apps/worker` have no unit tests.** They are exercised end to end from the built `dist/` by `scripts/verify-private-pilot.mjs` (Fastify `inject`, real Postgres/Redis, mock provider) and by the load test and deletion drill.
- DB integration: `describe.runIf(process.env.RUN_DB_INTEGRATION==="1" && TEST_DATABASE_URL)`, which throws if RUN is set without a URL. Redis: `RUN_REDIS_INTEGRATION==="1"`. `npm run test:integration` requires loopback `TEST_DATABASE_URL` + `REDIS_URL` and a UTF8 database, strips every secret-looking env var, forces `DEALDOCK_AI_MODE=heuristic`, and runs the listed vitest files, then the pilot flow, seed, demo-ingest, the 2,000-DM load test and the deletion drill.
- Root: `npm test` (turbo, concurrency 1, maxWorkers 1), `test:boundaries`, `test:safety` (needs build), `test:browser` (Playwright), and `npm run eval -w @dealdock/ai` (heuristic in CI; real Claude only on manual dispatch).

### 5.3 Env vars (no central schema; validated lazily per module)
| Var | Consumer and validation |
|---|---|
| `DATABASE_URL` | Prisma; worker exits if missing |
| `REDIS_URL` | `parseRedisConnection` (strict redis/rediss, numeric DB); required in production (`apps/api/src/queues.ts:11-18`, `graph.ts:14`) |
| `CLERK_SECRET_KEY` / `DEALDOCK_DISABLE_AUTH` / `DEALDOCK_DEV_ORG_ID` | `auth.ts:34-54`; bypass impossible in production |
| `WEB_APP_URL`, `PORT` | CORS origin and OAuth redirect target; listen port |
| `META_APP_ID`, `META_APP_SECRET`, `IG_OAUTH_REDIRECT_URI` | `ig.ts:13-24` (https or local http, path exactly `/ig/callback`); app secret also used for webhook HMAC |
| `META_WEBHOOK_VERIFY_TOKEN`, `MOCK_WEBHOOK_SECRET` | webhook handshake; mock route registered only when set and not production |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes hex or base64, checked at first encrypt/decrypt (`packages/db/src/crypto.ts:10-18`); API only |
| `ANTHROPIC_API_KEY`, `CLASSIFY_MODEL`, `DRAFT_MODEL`, `DEALDOCK_AI_MODE` | `createPipeline` throws without a key unless non-prod heuristic; `ClaudePipeline` requires both model names; style extraction uses `DRAFT_MODEL` |
| `VAPID_PUBLIC_KEY/PRIVATE_KEY` | push skipped if absent |
| `HIGH_VALUE_NOTIFY_MIN_MINOR` | `Number()` with no validation (default 5,000,000) |
| `RAZORPAY_*`, `PADDLE_*` | `packages/billing/src/{razorpay,paddle}.ts` constructors |

---

## 6. Functional gaps vs PRD and audits (backend)

### 6.1 Voice / drafting / learning
1. **No edit-learning loop.** `persistSendIntent` stores `Draft.finalText` + `editDistance` and an audit row with the original and final text (`packages/db/src/repos/drafts.ts:276-286`, `:305-315`), but nothing reads them back into prompts or style. `getWeeklyMetrics` only reports fidelity (`repos/metrics.ts:99-113`).
2. **No exemplars in the draft prompt.** `buildDraftSystem` sends only the style-card JSON (`packages/ai/src/prompts.ts:97-122`). ARCHITECTURE §5.4 promises 5–8 sent exemplars (`ARCHITECTURE.md:249`). `CreatorContext` has no slot for exemplars or edit pairs (`packages/ai/src/types.ts:4-14`).
3. **Sample selection is unfiltered.** It takes the latest 30 outbound messages of any `contentType`, including empty text, with no provenance (DealDock-assisted versus native IG) (`repos/voice.ts:17-26`). Provenance **is derivable** today: an outbound `Message` with a `Draft.sentMessageId` pointing at it was DealDock-sent (`schema.prisma:281`, `:335`), and outbound without one is a native IG echo or a backfill.
4. **Onboarding consent does not trigger style extraction** (`apps/api/src/routes/onboarding.ts:35-39`). Resample is manual and synchronous (`routes/settings.ts:64-95`). There is no weekly refresh and no fidelity-triggered refresh.
5. **First-account shortcuts:** resample uses `igAccounts[0]` (`settings.ts:67`), onboarding consent falls back to `igAccounts[0]` (`onboarding.ts:36`), leak scan uses `igAccounts[0]` (`onboarding.ts:56`), and disconnect uses `igAccounts[0]` (`ig.ts:119`). None accepts an `igAccountId`, which breaks Roster.
6. **Business context is org-wide**, not per creator (`repos/creator-context.ts:27-28`, `:42-56`). Roster creators share one offer and price context. Per-account ignore lists exist in the repo (`repos/settings.ts:201-240`) but the API only exposes org-wide (`routes/settings.ts:162-175`).
7. **No read/edit API for the style card.** `/settings` omits `styleCard`, `refreshedAt` and sample count, and there is no `PUT` to edit preferences or exclude samples.
8. **Draft controls missing:** no save-edited-draft endpoint (status `edited` is never set by the server), no discard, no version history, no regenerate-with-instruction (shorter, warmer, Hinglish). Drafting history is the last 12 messages only (`packages/ai/src/claude-pipeline.ts:115-118`).
9. A failed draft generation (voice off or model error) leaves no draft. The inbox row has no `draftReady` flag to show this.

### 6.2 Inbox / threads / sender
10. **Inbox query params are not exposed:** the route passes only `state`, limit 50, with no cursor (`routes/inbox.ts:11-15`). The repo supports `label`/`unrepliedOnly`/`sort` (`repos/inbox.ts:21-29`). Missing per PRD §6.3: `highest confidence` sort, age filter, `igAccountId` filter (Roster per-creator inbox, PRD §5.6.2), and search.
11. **Non-commerce threads are invisible everywhere.** The inbox requires `topLabel != null`, which only inbox-routed high-intent classifications set (`repos/inbox.ts:49`, `repos/classifications.ts:24-41`). Fan, spam and personal threads cannot be browsed.
12. **InboxRow lacks** `draftReady`, `nudgeDue`, `valueMin`, `confidence`, `igAccountId`/handle, `contentType`, `language` and sender profile fields. Language is stored on `Classification` but never returned.
13. **No sender profile.** The webhook sets `participantHandle = participantIgId = IGSID` (`routes/webhooks.ts:99-100`) "to be enriched by backfill", but `upsertInboundMessage` creates the thread with `update: {}` (`repos/ingestion.ts:60`), so the handle is never enriched. The Instagram User Profile API (`GET /<IGSID>?fields=name,username,profile_pic,follower_count,is_verified_user,is_user_follow_business,is_business_follow_user`) is available after the user messages the account ([Meta: User Profile API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/user-profile)). There are no columns for these fields, and the call must be made in the API (token).
14. **ThreadDetail lacks `lastInboundAt`** (needed for a 24h reply-window countdown), the account handle (Roster), participant profile and the thread's audit trail (PRD §5.6.5). There is no audit-read endpoint at all, even though AuditLog is written everywhere.
15. **Review queue rows lack `contentType`**, value estimate and thread context (`repos/classifications.ts:147-173`). Override without a label → 500 (`classifications.ts:210-212`).

### 6.3 Follow-ups / notifications / reporting
16. **Nudge re-fire bug.** After a nudge is **sent**, the thread stays `waiting` with the same `waitingSince` and no ready nudge draft, so the next 30-minute tick re-drafts and re-pushes (`repos/system.ts:39-58`, `repos/drafts.ts:291-303` never touches state). The same happens every tick if drafting is skipped (voice off). **Dismiss suppresses forever** (`nudgeDismissedAt` filter, `system.ts:44`, set at `repos/threads.ts:96-99`) rather than resetting the clock as PRD §5.3 and the route comment say.
17. **Weekly summary is missing.** The `weekly_summary` kind is rendered (`consumers/notifications.ts:46-51`) but has no producer, and the prefs route rejects enabling it (`routes/notifications.ts:46`). The DB default `notifyWeeklySummary=true` (`schema.prisma:497`) is inconsistent.
18. **Quiet hours drop pushes** instead of deferring them (`repos/push.ts:80-88`).
19. **Insights are thin:** only `/dashboard` (MTD, prev month, top 3) and `/metrics/weekly` (7 days, with no role check and not reachable through the dev bridge). Missing per PRD §6.9: monthly report, by-classification breakdown, top-10 deals, time series, fidelity trend, leak-scan versus recovered, per-creator Roster reports and export (PRD §5.6.4).
20. **Roster month bug:** `getRosterOverview` computes the month start in **server** local time, not the org timezone (`repos/seats.ts:169-171`), and runs N+1 queries.

### 6.4 Onboarding / account / billing
21. Leak scan returns a constant `enqueued:0` and has no progress or state (`onboarding.ts:59`, `repos/metrics.ts:60`), so the UI cannot show "scanning… done".
22. OAuth callback failures (`account_connected_to_other_org`, `ig_account_limit:N`, subscribe failure) return raw JSON or 500 to the browser instead of redirecting to the onboarding UI with an error code (`ig.ts:101-108`).
23. **Tier is never selectable:** `provisionOrganization` always creates Subscription tier `solo` (`repos/orgs.ts:96`), `ensureSubscription` has no caller, there is no upgrade/downgrade route (PRD §6.12) and no `/billing/portal`. As a result Studio/Roster seats and accounts are unreachable through the API. `/seats` returns all tier limits and never the org's tier. `/me` returns no name, email, tier or onboarding state.
24. **First invoice can stall:** if `createSubscription` throws after `claimFirstInvoice`, the claim is never released (`apps/worker/src/consumers/billing.ts:34-44`; `releaseFirstInvoiceClaim` is unused, `repos/billing.ts:119`).
25. **Stuck sends:** an unknown or ambiguous send leaves the draft `sending`. There is no reconciliation consumer and no "resolve" endpoint, so `createDraft` refuses that thread forever (`repos/drafts.ts:36-40`).
26. Invites send no email (placeholder seat only), and there is no role change or re-invite. `removeSeat` on the creator → 500.
27. Ingestion and classification jobs run without retries (`consumers/outbox.ts:42-46`), contrary to the F2 comment in `connection.ts:13-17`.
28. Token expiry only sets status. There is no push, banner endpoint or reconnect CTA data beyond `/settings.accounts[].status`.

### 6.5 Audio (PRD §6.2 pilot requirement is partial)
29. Voice notes are not detected. Both the webhook and history paths set `contentType = text ? "text" : "attachment"` (`routes/webhooks.ts:103`, `graph-maintenance.ts:39`). The adapter types `attachments` but never maps them (`packages/messaging/src/instagram/instagram-graph-adapter.ts:103`, `:127`), and history `fields` omit attachments (`:189`). Nothing is transcribed, played back or sent as audio.

---

## 7. Integration points for audio and voice-learning

### 7.1 Inbound audio
- **Parse:** `InstagramGraphAdapter.parseWebhook` (`instagram-graph-adapter.ts:90-135`). Add `attachments:[{type, url}]` to `RemoteMessage` (`packages/messaging/src/provider.ts:29-37`). Meta's messages webhook carries `message.attachments[].{type, payload.url}` with type `image|video|audio|file|reel|ig_reel…` ([Meta webhooks reference: Instagram](https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram), [Messenger messages webhook](https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messages/)). Whether IG voice notes arrive as `type:"audio"`, and how long the URL lives, is **not documented**. Verify against a live account.
- **Already persisted:** for live webhooks, `Message.raw` = the full messaging item (`routes/webhooks.ts:107` → `repos/ingestion.ts:104`), so audio URLs are in the DB today. History needs `attachments` in `fields` (`adapter:189`).
- **Normalize:** set `contentType:"audio"` at `routes/webhooks.ts:103` and `graph-maintenance.ts:39`. The `IngestionJob` enum already allows `audio` (`packages/core/src/index.ts:118`), and so does the schema `ContentType` (`schema.prisma:55-59`).
- **Classify:** replace the content-flag branch at `apps/worker/src/consumers/classification.ts:42-60` with fetch-by-URL → STT (new function in `packages/ai`, which has no DB access) → `pipeline.classify(transcript)`. Persist the transcript in a new column or table (org-scoped, cascade, export, residue). Keep confidence <0.8 → review. Media fetch by **un-tokened CDN URL** passes the boundary regex. A token-authenticated fetch must stay in the API.
- **Storage:** there is no blob store in the stack. Retention and hard delete only cover Postgres (`repos/retention.ts:41-73`), so any audio object store must be added to deletion, export and the drill.

### 7.2 Outbound audio (cloned-voice replies)
- **Provider interface:** `sendMessage(account, target, text)` is text-only (`provider.ts:104-108`). The Graph body is `{recipient:{id}, message:{text}}` (`adapter:223-226`). Meta supports `{"message":{"attachment":{"type":"audio","payload":{"url":"<URL>"}}}}` to `graph.instagram.com/<IG_ID>/messages` (or `/me/messages`), formats **aac, m4a, wav, mp4**, max **25 MB**, within the standard 24h window (7 days for Click-to-Direct ads; separate human-agent tag) ([Meta: Send Messages](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/)). The URL must be publicly fetchable, which needs signed short-lived object-storage URLs.
- **Send gate changes** (`apps/api/src/routes/threads.ts:116-215`): `SendBody` is `finalText` only (`:42-47`); `SendIntent.finalText` is a required string (`schema.prisma:572`); `persistSendIntent` rejects an echo whose text differs from `finalText` (`repos/drafts.ts:268-275`), and an audio echo has `text:""`. Add `kind:"text"|"audio"` plus an audio asset id to Draft and SendIntent, keep the human-approval and idempotency semantics, and keep the call API-side. TTS synthesis can run in the worker (no Meta capability), but **sending must remain in the API**.
- **Consent:** `VoiceProfile` consent covers *writing style*. A cloned *speaking* voice needs its own explicit, revocable, audited consent record, with revocation deleting the provider voice and samples (mirror `setVoiceConsent`, `repos/voice.ts:57-97`).

### 7.3 Voice-learning hook after a successful send
- **Hook point:** inside `persistSendIntent` when `sent.count === 1` (`repos/drafts.ts:276-316`). There the transaction already has `intent.draft.body` (original), `intent.finalText`, `seatId`, `draft.threadId`, and the edit distance. Recommended: append an `OutboxEvent` (kind e.g. `voice_learning`, dedupeKey `voice-learning:<draftId>`) in that same transaction. This mirrors the ingestion→classification handoff and is crash-safe. Then extend the dispatcher union `OutboxKind` and its kind list (`apps/worker/src/consumers/outbox.ts:12`, `:61`) and add a queue name to `QUEUES` (`packages/core/src/index.ts:96`).
- **Alternative (API enqueue):** `apps/api/src/queues.ts` exposes only `getIngestionQueue()`. Add a sibling getter (`new Queue(QUEUES.x, {connection: redisConnection()})`) and call it after `persistSendIntent` at `threads.ts:212`. This is not crash-safe (Redis is never the source of truth here), so prefer the outbox.
- **Native creator messages:** outbound echoes and backfilled outbound messages with no `sentFromDraft` are the cleanest "how I actually text" samples. They arrive via `upsertInboundMessage` (outbound branch, `repos/ingestion.ts:75-80`), which writes no outbox row for outbound today.
- **Consumer:** the worker reads via repos only (`getCreatorContext`-style org+account scoped). Gate on active consent (`VoiceProfile.enabled && consentedAt && !revokedAt`), and exclude heuristic models (`modelVersion startsWith "heuristic"`, as `getWeeklyMetrics` does). Write learned edit pairs/rules to a new account-scoped table and feed them through `getCreatorContext` → `CreatorContext` → `buildDraftSystem`. Bump `PROMPT_VERSION` (`packages/ai/src/prompts.ts:8`) on any prompt change. Clear the learned data on consent revoke (`repos/voice.ts:82-86`) and add it to `countOrgResidue`.

---

Sources: [Meta — Instagram Send Messages](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/), [Meta — Instagram User Profile API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/user-profile), [Meta — Webhooks reference: Instagram](https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram), [Meta — Messenger messages webhook](https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messages/).
