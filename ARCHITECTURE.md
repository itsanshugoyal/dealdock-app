# DealDock — System Architecture

> Readiness update (30 October 2026): see [private pilot readiness](docs/private-pilot-readiness.md). Next.js is now 16. Graph I/O, token decryption, history polling and token refresh live only in `apps/api`; workers receive normalized jobs and reject API-only secrets. A durable PostgreSQL outbox recovers queue handoffs. Sending uses durable human-approval intents; ambiguous delivery never triggers an automatic resend. Organization currency is immutable, and monthly ledger grouping uses its time zone. Older diagrams below describe the original milestone plan where they differ from this update.

**Status:** Living document · v1.1 · Pilot scope, global-ready
**Source of truth for requirements:** `DealDock_Product_PRD.md` (PRD v1.1 — in this repo)
**Companions:** `DESIGN.md` (design system + screens) · `PLAN.md` (milestones + risks)

> **v1.1:** global-ready (org currency/locale/timezone, minor-unit money, dual-rail billing with Paddle MoR), Leak Scan onboarding backfill, `waiting` thread state + nudges, PWA push notifications. India-first pilot cohort unchanged.

Every architectural decision here traces to a PRD requirement. Where we made a judgment call, there is an ADR at the bottom recording the alternatives we rejected and why.

---

## 1. System overview

```
                        ┌─────────────────────────────────────────────────┐
                        │                   CREATOR                       │
                        │        (responsive web, mobile-first)           │
                        └──────────────────────┬──────────────────────────┘
                                               │ HTTPS
                        ┌──────────────────────▼──────────────────────────┐
                        │              apps/web · Next.js 16              │
                        │   Dashboard · Revenue Inbox · Thread view ·     │
                        │   Review Queue · Ledger · Roster · Settings     │
                        └──────────────────────┬──────────────────────────┘
                                               │ REST (typed client from packages/core)
┌───────────────┐       ┌──────────────────────▼──────────────────────────┐
│  Meta Graph   │ OAuth │              apps/api · Fastify                 │
│     API       ◄───────┤  AuthZ (Clerk JWT) · Inbox API · Ledger API ·   │
│               │ send  │  Send API (human-approval gate) · Billing hooks │
└──────┬────────┘       └───────┬──────────────────────────┬──────────────┘
       │ webhooks               │                          │
       │                 ┌──────▼──────┐          ┌────────▼────────┐
       └────────────────►│   Redis     │          │   PostgreSQL    │
                         │ BullMQ queues│          │  (Neon, SG)     │
                         └──────┬──────┘          │  single source  │
                                │                 │  of state       │
                  ┌─────────────▼───────────────┐ └────────▲────────┘
                  │     apps/worker · Node      │          │
                  │ ingest → classify → value → │──────────┘
                  │ confidence gate → draft     │
                  │        (Claude API)         │
                  └─────────────────────────────┘
```

**Core loop (PRD §5.2):** DM arrives at Meta → webhook → ingestion queue → classification pipeline → Revenue Inbox row (target < 60s) → creator opens thread → draft shown (target < 5s if not pre-generated) → creator approves/edits → send via Graph API → optional "Mark closed for ₹___" → Revenue Ledger.

### 1.1 Guiding constraints (from PRD)

| Constraint | Source | Architectural consequence |
|---|---|---|
| Never auto-send | §3.3, §6.4 | Send endpoint requires an authenticated human actor + draft approval record. No code path from worker to Graph API send. Enforced at API layer, not UI. |
| < 60s DM-to-inbox | §7.3 | Webhook-driven ingestion (not polling), dedicated queue, pre-classification on arrival. |
| < 5s draft generation | §7.3 | Drafts pre-generated at classification time for high-intent classes; on-thread generation is the fallback path. |
| Multilingual/code-switched parity (Hinglish = pilot P0) | §6.2, §7.4 | Model choice + eval harness are P0 (see §5) with per-market language slices. Language detection informs prompt, never filters. |
| Global-ready, India-first | §1, §6.1 | Org-level currency/locale/timezone; money as integer minor units; nothing hardcodes ₹ or IST. |
| Per-creator data isolation | §7.1 | Org-scoped queries enforced in a repository layer; per-creator prompt context assembled only from that creator's data. |
| Official Graph API only | §7.2 | One integration path, `MessagingProvider` interface, zero scraping/automation code anywhere in the repo. |
| 99.5% uptime IST business hours | §7.6 | Managed PaaS with health checks; ingestion self-heals via backfill job. |

---

## 2. Monorepo layout

Turborepo, TypeScript everywhere, npm workspaces.

```
dealdock-app/
├── apps/
│   ├── web/                  # Next.js 16 (App Router) — creator-facing UI
│   ├── api/                  # Fastify — REST API, webhook receivers, auth middleware
│   └── worker/               # BullMQ consumers — ingestion, AI pipeline, billing jobs
├── packages/
│   ├── core/                 # Domain types, zod schemas, shared constants, typed API client
│   ├── db/                   # Prisma schema + client + migrations + repository layer
│   ├── messaging/            # MessagingProvider interface + adapters (mock, instagram)
│   └── ai/                   # Claude pipeline: prompts, classifiers, drafter, eval harness
├── ARCHITECTURE.md           # this file
├── DESIGN.md
├── PLAN.md
└── turbo.json
```

**Dependency rule:** `apps/*` depend on `packages/*`; packages never depend on apps; `packages/core` has zero internal dependencies (it is the leaf everything shares).

### 2.1 Service responsibilities

| Service | Owns | Never does |
|---|---|---|
| `apps/web` | Rendering, optimistic UI, client-side filtering | Direct DB access, direct Claude calls, direct Graph API calls |
| `apps/api` | AuthN/Z, request validation (zod), webhook signature verification, the **send gate**, billing webhooks, CSV exports | Long-running work (anything > ~2s is enqueued) |
| `apps/worker` | Ingestion, classification, value estimation, draft pre-generation, ledger rollups, billing/notification scheduling, retention deletion | Any Graph I/O or credentials, sending Instagram messages, serving HTTP |
| `packages/messaging` | Provider abstraction: `fetchThreads`, `fetchMessages`, `sendMessage`, `subscribeWebhooks`, `verifyWebhook` | Business logic, persistence |
| `packages/ai` | Prompt assembly, model calls, confidence scoring, eval harness | Persistence (returns results; worker persists) |

---

## 3. Data model

PostgreSQL via Prisma. All tables carry `orgId` (tenancy) and timestamps. Money is stored as **integer minor units** (`valueMinMinor`, `valueMaxMinor` — paise for INR, cents for USD) with the currency defined **once per org** (PRD §6.1, ADR-9) — never floats, never mixed currencies within an org.

### 3.1 Entity relationship overview

```
Organization ─┬─< Seat >── User (Clerk identity)
              ├─< IgAccount ─< Thread ─< Message
              │                  │         └─< Classification (1:1 message)
              │                  ├─< Draft (versions)
              │                  └─── LedgerEntry (0..1 per close-out, editable)
              ├─< VoiceProfile (per IgAccount)
              ├─< IgnoreListEntry
              ├─< AuditLog
              └─── Subscription (Razorpay)
```

### 3.2 Tables

**`Organization`** — tenancy root. `tier` (`solo` | `studio` | `roster`), `name`, `pilotCohort` flag, `pricingLockedAt` (PRD §8: pilot members keep pricing), **`currencyCode`** (ISO 4217; INR/USD/GBP/EUR/AED at launch), **`locale`** (drives lakh/crore vs K/M formatting), **`timezone`** (month boundaries, quiet hours, SLA window), `nudgeDelayDays` (default 3, PRD §6.5).

**`User` / `Seat`** — `User` mirrors the Clerk identity (`clerkUserId`). `Seat` joins user↔org with `role`: `creator` | `assistant` | `manager`. Seat limits enforced per tier (§6.1: Solo=1, Studio=2, Roster=multi). Every mutating action records the acting `seatId`.

**`IgAccount`** — connected Instagram account. `igUserId`, `handle`, `accountType` (must be `business`|`creator` — personal accounts rejected with guidance, §6.1), encrypted `accessToken` (see §8), `status` (`active` | `disconnected` | `token_expired`), `connectedAt`, `disconnectedAt`. On disconnect: ingestion stops immediately (§6.1) — worker checks status before processing any job for the account.

**`Thread`** — one per IG conversation. `igThreadId`, `participantHandle`, `participantIgId`, `lastMessageAt`, `state` (`open` | `waiting` | `closed` — PRD §6.5), `waitingSince` (drives nudges: waiting + silent ≥ `nudgeDelayDays` → nudge job drafts a follow-up), `nudgeDismissedAt`, denormalized `topClassification` + `estValueMaxMinor` for inbox sorting without joins.

**`Message`** — one per DM. `igMessageId` (unique — idempotency key for webhook replays), `direction` (`inbound` | `outbound`), `text`, `sentAt`, `raw` (JSONB, provider payload). Outbound messages link to the `Draft` they were sent from.

**`Classification`** — 1:1 with inbound messages. `label` (8 classes, PRD §6.2: `brand_deal` | `coaching_lead` | `course_inquiry` | `other_commerce` | `fan` | `spam` | `personal` | `uncertain`), `confidence` (0–1), `valueMinMinor`/`valueMaxMinor` (org currency; nullable for non-commerce), `language` (`en` | `hi` | `hinglish` | `mixed` — extensible per market), `contentType` (`text` | `audio` | `attachment` — audio surfaces as "needs your ear", never silently dropped, PRD §6.2), `rationale` (one-line model-generated explanation — "mentions campaign budget; verified brand account" — shown in Review cards and on badge tap, DESIGN.md principle 9), `modelVersion`, `promptVersion`, `routedTo` (`inbox` | `review_queue`), `reviewedBySeatId`, `reviewOutcome` (`confirmed` | `overridden`), `overrideLabel`, `source` (`live` | `leak_scan` — onboarding backfill rows are tagged). Review outcomes are the labelled training data for per-creator personalization (§6.6 PRD).

**`Draft`** — `threadId`, `messageId` (the message being replied to), `body`, `version` (regenerations increment), `status` (`ready` | `edited` | `sent` | `discarded`), `editDistance` (Levenshtein, computed at send — voice-fidelity metric §6.4), `modelVersion`, `sentAt`, `sentBySeatId`.

**`LedgerEntry`** — the product's soul (PRD §6.7). `threadId`, `dealType`, `amountMinor`, `currencyCode` (denormalized from org at write time — org currency changes never rewrite history), `closedAt`, `createdBySeatId`, `note`, soft-delete via `deletedAt` (refund handling). Monthly rollups computed, not stored.

**`PushSubscription`** — per seat: Web Push endpoint + keys (VAPID), `notificationPrefs` (high-value DM / nudge due / weekly summary, individually toggleable — PRD §6.8), `quietHours` derived from org timezone.

**`VoiceProfile`** — per IgAccount. `enabled` (creators can turn drafting off, §6.9), `styleCard` (JSONB: greeting, sentence length, formality, signoff, characteristic phrases — assembled from consented sent-DM samples §6.4), `sampleMessageIds`, `refreshedAt`, `version`.

**`IgnoreListEntry`** — per IgAccount, `handle`, `reason`. Checked at ingestion; ignored handles are stored raw but never classified or drafted (§6.9).

**`AuditLog`** — append-only. `orgId`, `seatId`, `action`, `entityType`, `entityId`, `detail` (JSONB: for sends — original draft, final text, edit distance, per §7.5), `createdAt`. Exportable on request.

**`Subscription`** — `razorpaySubscriptionId`, `tier`, `status` (`pending_first_invoice` | `active` | `cancelled` | `past_due`), `activeUseStartedAt` (drives the invoice-after-one-week gate §6.10), `cancelledAt`, `currentPeriodEnd`. Post-cancel: ledger read-only 30 days, then retention job deletes (§5.6).

**`IngestionCheckpoint`** — per IgAccount: `lastWebhookAt`, `lastBackfillAt`, `lastIgMessageTimestamp`. Powers self-healing (§7.6): a scheduled job compares checkpoints against Graph API conversation list and backfills gaps.

### 3.3 Isolation & integrity rules

- **Repository layer** in `packages/db` — every query function takes `orgId` as its first argument; raw Prisma client is not exported to apps. This is the single chokepoint for tenancy (cheaper and more testable than Postgres RLS for pilot scale; RLS is the V1 upgrade path — see ADR-7).
- Prompt assembly (`packages/ai`) receives data already scoped by the repository layer; there is no code path that can mix creators' messages into one prompt.
- `igMessageId` unique constraint makes webhook ingestion idempotent — Meta redelivers, we upsert.

---

## 4. Instagram integration (`packages/messaging`)

### 4.1 The provider interface

```ts
interface MessagingProvider {
  readonly platform: "instagram" | "whatsapp";        // WhatsApp lands in V2 (PRD §9)
  verifyWebhook(req: WebhookRequest): boolean;         // X-Hub-Signature-256
  parseWebhook(payload: unknown): InboundEvent[];
  listConversations(account: ConnectedAccount, since?: Date): Promise<RemoteThread[]>;
  fetchMessages(account: ConnectedAccount, threadId: string, since?: Date): Promise<RemoteMessage[]>;
  sendMessage(account: ConnectedAccount, threadId: string, text: string): Promise<SendReceipt>;
}
```

Two implementations ship in the pilot:

- **`MockInstagramAdapter`** — deterministic, seeded with a realistic fixture corpus (Hinglish brand briefs, coaching enquiries, fan spam — see `packages/messaging/fixtures/`). Supports scripted "live" message arrival for demos and E2E tests. The entire product runs end-to-end against it before Meta app review completes.
- **`InstagramGraphAdapter`** — official Graph API (Instagram Messaging via Meta). OAuth (Instagram Login for Business flow), webhook subscription, send within the 24-hour standard messaging window.

Selection is per-IgAccount (`provider` column), so a demo org and a real org coexist in one environment.

### 4.1a Graph-adapter specifics (M3, implemented)

- **Thread identity:** threads are keyed by the **counterparty's IGSID**, not Meta's conversation id — webhooks carry only IGSIDs, so webhook and backfill writes converge on the same Thread row. Conversation ids live in `Message.raw` for audit.
- **Echo events** (`is_echo`) — the creator's own sends from the native IG app — are ingested as **outbound** messages, keeping "unreplied" logic and voice sampling truthful even when the creator replies outside DealDock.
- **API depth limits:** the Conversations API returns only the ~20 most recent messages per thread and omits Requests-folder threads inactive 30+ days. Real-account **Leak Scan depth is bounded by this** — the reveal copy says "at least" and the PRD's honesty rule (§6.2) applies.
- **Tokens:** long-lived (~60 days), AES-256-GCM encrypted at rest (`packages/db/crypto.ts`), decrypted only inside the repository layer; refreshed by the token-health path, `OAuthException 190` anywhere → `token_expired` status → reconnect banner.

### 4.2 Compliance posture (PRD §7.2 — zero tolerance)

- Graph API only. No browser automation, no scraping, no session-cookie tricks — nothing of that shape exists in the codebase.
- **Rate-limit budget:** Meta's messaging API limits are tight (order of 200 calls/hr/account observed in 2026 policy). All Graph calls flow through a per-account token-bucket limiter in the adapter; ingestion prefers webhooks (free) over fetches; backfill is spread over time. If budget is exhausted, work queues rather than drops.
- **24-hour window:** sends outside the window are rejected by the adapter with a typed error surfaced in the UI ("This thread's reply window has closed — reply from Instagram directly"), never silently retried.
- **App review track:** Meta Tech Provider status + `instagram_business_manage_messages` approval is a PLAN.md M3 gate with lead time started at M0.

### 4.3 Ingestion & self-healing (PRD §7.6)

1. Webhook arrives at `apps/api/webhooks/instagram` → signature verified → metadata and org-scoped normalized payload committed to the PostgreSQL outbox → acknowledgement. A recoverable dispatcher publishes tenant/event references to Redis; customer DM text remains in the scoped database.
2. Worker resolves event → upserts Thread/Message (idempotent) → enqueues classification.
3. **Backfill job** (every 15 min per active account): `listConversations(since = lastBackfillAt − overlap)` catches anything webhooks missed (outages on either side). No permanently lost messages.
4. Token health job: detects expiring/revoked tokens → marks `token_expired` → surfaces reconnect banner in UI.

---

## 5. AI pipeline (`packages/ai`)

### 5.1 Stages

```
inbound message (live webhook OR leak-scan backfill batch)
   │
   ├─ 0. ignore-list check (skip everything if matched)
   │      audio/attachment? → surface flagged ("needs your ear"), skip 1–5
   ├─ 1. language detect (en / hi / hinglish / mixed) — cheap heuristic + model fallback
   ├─ 2. classify → one of 8 labels + confidence            [Claude Haiku]
   ├─ 3. value estimate (commerce labels only)              [same call as 2]
   │       inputs: message text, sender profile signals,
   │       creator's onboarding deal-size context IN ORG CURRENCY (§5.1 PRD)
   ├─ 4. confidence gate:
   │       confidence ≥ 0.80 → Revenue Inbox
   │       confidence < 0.80 → Review Queue (never inbox, PRD §6.6)
   └─ 5. draft (high-intent labels only: brand_deal, coaching_lead,
           course_inquiry, other_commerce)                  [Claude Sonnet]
           inputs: thread history + voice style card + type-specific
           reply structure (§6.4: brand brief ≠ coaching enquiry ≠ follow-up nudge)
```

**Leak Scan (PRD §5.1.6, §6.2):** at onboarding, a backfill job runs the last 30 days of history (primary inbox + message-requests folder) through stages 0–4 in batch (no drafts), tags rows `source = leak_scan`, and computes the headline "unanswered commerce value last month." Same pipeline, one flag — no separate code path.

**Nudges (PRD §6.5):** a scheduled job finds `waiting` threads silent ≥ `nudgeDelayDays`, generates a follow-up draft (its own draft type: short, warm, non-pushy), and emits a notification. Nudges obey the send gate like everything else — never auto-sent.

Classification + value estimation are **one structured-output call** (Haiku, temperature 0) — halves latency and cost vs. two calls. Drafting is a separate Sonnet call only for the ~10–20% of messages that warrant it.

### 5.2 Model strategy

| Task | Model | Why |
|---|---|---|
| Classify + value estimate | Claude Haiku | High volume (50–500 DMs/day/creator), structured output, strong multilingual; cost scales linearly with inbox size |
| Draft replies | Claude Sonnet | Quality bar is "sent without edits" (≥70% target §7.4); runs on far fewer messages |
| Voice style-card extraction | Explicitly configured Claude model | Manual consented refresh; weekly automatic refresh is deferred |

**Prompt caching:** the per-creator system block (business context + voice style card + label definitions) is cache-marked; only the message content varies per call. This is the main cost lever at 500 DMs/day.

**Versioning:** every Classification and Draft row stamps `modelVersion` + `promptVersion`. Accuracy metrics (§11 PRD) are computed per version, so a prompt regression is visible within a day.

### 5.3 Personalization loop (PRD §6.5)

Review Queue confirm/override actions write `reviewOutcome` to the Classification row. A nightly per-creator job distills recent overrides into **few-shot correction examples** appended to that creator's classification prompt (org-scoped, never cross-creator, §7.1). This is deliberately simple — no fine-tuning in pilot (ADR-5).

### 5.4 Voice modeling (PRD §6.4)

- Onboarding: with explicit consent, sample recent **sent** DMs → Sonnet extracts a **style card** (greeting, sentence length, formality, signoff, characteristic phrases, emoji habits, code-switching ratio) → stored as JSONB, human-readable, editable by us during pilot support.
- Drafting prompts receive the style card + 5–8 exemplar sent messages (few-shot), not a fine-tuned model. Cold start (PRD risk §10.1.3) is mitigated by the onboarding questionnaire seeding the style card on day one.
- `editDistance` recorded at send → weekly voice-fidelity metric per creator → style card refresh when fidelity trends down.

### 5.5 Quality harness

`packages/ai/evals/` — a golden dataset of labelled DMs (seeded from fixtures, grown with anonymized pilot corrections): Hinglish-weighted per PRD risk §10.1.2. `npm run eval` scores classification accuracy + value-range calibration per prompt version. CI runs evals on any change under `packages/ai/prompts/`. Benchmarks: ≥90% top-level accuracy by pilot end (§7.4).

---

## 6. API design (`apps/api`)

REST, JSON, zod-validated at the boundary, typed client generated into `packages/core`. Auth: Clerk JWT verified by Fastify middleware → `{ userId, orgId, seatRole }` context. All routes org-scoped.

### 6.1 Surface (pilot)

```
POST   /webhooks/instagram          # Meta webhook (signature-verified, unauthenticated)
POST   /webhooks/razorpay           # billing events (signature-verified)

GET    /inbox                       # Revenue Inbox: sort=value|recent|oldest_unread|confidence,
                                    # filters: label, age, unreplied (§6.3)
GET    /threads/:id                 # full thread + messages + current draft
POST   /threads/:id/draft           # (re)generate draft on demand (<5s path)
POST   /threads/:id/send            # THE SEND GATE — see below
POST   /threads/:id/close           # Mark closed for [amount] → LedgerEntry (§5.4)
PATCH  /threads/:id                 # state: open|waiting|closed (waiting starts nudge clock)
POST   /threads/:id/nudge/dismiss   # keep waiting, silence this nudge

GET    /review-queue                # uncertain classifications (§6.5)
POST   /classifications/:id/review  # { outcome: confirm | override, label? }

GET    /ledger?month=               # entries + rollups (month totals, biggest, avg, by-type §6.6)
PATCH  /ledger/:id                  # edit amount/type (refunds)
DELETE /ledger/:id                  # soft delete
GET    /ledger/export.csv           # always available, incl. post-cancellation (§5.6)

GET    /roster                      # Roster tier: per-creator rollups (§5.5)
GET    /settings/data               # what we store (§6.9)
POST   /settings/export             # full archive job → download link
DELETE /account                     # 7-day grace → hard delete (§6.9)
GET/PUT /settings/ignore-list
PUT    /settings/voice/consent      # per-account permission to learn from sent replies
PUT    /settings/region             # locale/timezone preferences (currency is immutable),
                                    # locale, timezone, nudge delay (PRD §6.11)
POST   /notifications/subscribe     # Web Push subscription   PUT /notifications/prefs
POST   /ig/connect                  # OAuth start   POST /ig/disconnect
GET    /billing/portal              # rail-appropriate hosted management (Razorpay | Paddle)
```

### 6.2 The send gate (never-auto-send, enforced structurally)

`POST /threads/:id/send` requires **all** of:
1. Authenticated seat with send permission on this org (creator, assistant, or manager per tier).
2. A `draftId` whose current body the client echoes back (`finalText`) — server computes edit distance against the draft.
3. Thread's account `status = active` and within the platform send window.

The worker's runtime credentials have **no send capability** — sending exists only in `apps/api`, behind human auth. An `AuditLog` row (actor, original draft, final text, edit distance, timestamp) is written in the same transaction as the send receipt (§7.5).

---

## 7. Auth, seats, and tiers

- **Clerk** for identity + session management. Clerk **Organizations** map 1:1 to our `Organization`; Clerk org roles map to seat roles. Webhooks sync Clerk state → our `Seat` table (our DB is authoritative for permissions checks).
- Tier limits enforced in API middleware: Solo = 1 seat/1 IG account; Studio = 2 seats/1 account; Roster = multi-seat/≤5 accounts (§6.8).
- Roster managers get org-wide read + per-account send; every send attributes the acting seat (§5.5.5).

## 8. Security & privacy (PRD §7.1)

| Concern | Control |
|---|---|
| DM content at rest | Postgres encryption at rest (Neon default) + application-layer AES-256-GCM for IG access tokens (`packages/db/crypto.ts`, key in env/secret manager, rotated on schedule) |
| In transit | TLS everywhere; webhook signature verification (Meta + Razorpay) |
| Data isolation | Org-scoped repository layer (§3.3); prompt assembly scoped per creator; no cross-creator context ever |
| Model training | Claude API with training disabled (API data is not used for training by default); documented in the pilot privacy FAQ (§7.1) |
| Logs | Structured logs strip message bodies; DM text never enters logs, Sentry events scrubbed via beforeSend |
| Deletion | Account delete → 7-day grace → hard-delete job (all DMs, classifications, drafts, ledger, voice profile); post-cancel ledger read-only 30 days then same path (§5.6, §6.9) |
| Export | Single-archive export (DMs processed, classifications, drafts, ledger) as a background job (§6.9) |
| Secrets | Env-scoped per service; no secrets in repo; `.env.example` documents every variable |
| Least privilege | Worker: DB + Claude + Graph read scopes only. API: send scope. Web: nothing server-side beyond its own session handling |

## 9. Billing (dual-rail: Razorpay + Paddle, PRD §6.12)

Rail is selected automatically by org currency behind one `BillingProvider` interface (`createSubscription`, `cancelAtPeriodEnd`, `verifyWebhook`, `parseEvents`):

- **INR orgs → Razorpay** (UPI Autopay, cards, netbanking — how Indian creators actually pay).
- **All other currencies → Paddle (merchant of record)** — Paddle is the seller of record and owns global sales-tax/VAT/GST registration and filing. A two-person team does zero international tax compliance (ADR-4).

Shared flow, both rails:
1. Onboarding call done → org created with `Subscription.status = pending_first_invoice`, `activeUseStartedAt` set on first real inbox interaction.
2. Scheduled job: `activeUseStartedAt + 7 days` → create subscription on the org's rail → first invoice runs. Invoiced-after-the-fact trust mechanics, not a free trial (§6.12).
3. Webhooks (both rails normalized to internal events) reconcile state: charged → `active`; payment failure → `past_due` (grace banner, no feature cut for 7 days); cancellation → runs to `currentPeriodEnd`, then read-only mode. Poll-based reconciliation job backs up both webhook streams.
4. Upgrades/downgrades: immediate tier switch, prorated by the rail; pilot price lock honored via `pricingLockedAt` (₹ and $ price points per PRD §8).

## 10. DevOps & environments

| Layer | Pilot choice | Rationale |
|---|---|---|
| Web | Vercel (Singapore edge) | Zero-config Next.js, fits <2s Indian-mobile dashboard budget with SSR + edge caching |
| API + Worker + Redis | Railway (Singapore) | Long-running Node processes, private networking, cheap at pilot scale |
| Postgres | Neon (Singapore) | Managed, branching for preview envs, encryption at rest |
| CI | GitHub Actions | typecheck → lint → unit tests → AI evals (on prompt changes) → Prisma migrate diff check |
| Observability | Sentry (errors) + PostHog (product metrics §11) + BullMQ dashboard + uptime monitor on `/health` | Weekly internal dashboard per PRD §7.4 |

Environments: `local` (docker-compose: Postgres + Redis, mock adapter default) → `staging` (mock + real sandbox) → `production`. Migrations run as a release step, never at boot. Uptime target 99.5% during each org's local business hours (PRD §7.6) — alerting windows derived from the distribution of org timezones (pilot ≈ IST).

**Web Push:** standard VAPID Web Push from `apps/worker` (notification jobs) via the service worker in `apps/web` (PWA manifest + offline shell). No Firebase dependency required; iOS ≥16.4 and Android supported.

## 11. Scale posture

Pilot: ~50 creators × ≤500 DMs/day ≈ 25k messages/day peak — trivially handled by one API instance, one worker instance, smallest managed Postgres. Everything stateless except Postgres/Redis, so the V1 scale path is "turn up replicas," not re-architecture. Queue depth and Claude spend per org are the two metrics to watch (alerts at PLAN.md-defined thresholds).

---

## 12. Architecture Decision Records

### ADR-1 · TypeScript Turborepo monorepo (web + api + worker)
**Decision:** One language, three deployables, shared packages.
**Alternatives rejected:** (a) Next.js-only full-stack — serverless is hostile to webhook-driven queues and the <60s ingestion SLA; would be re-architected mid-pilot. (b) Python backend for AI — better AI ecosystem but two languages/two toolchains for a tiny team; Claude API needs no Python-only tooling.
**Consequence:** one CI pipeline, shared zod schemas end-to-end; must guard package boundaries (dependency rule §2).

### ADR-2 · Claude API, two-model split (Haiku classify / Sonnet draft)
**Decision:** Anthropic Claude; Haiku for volume classification+valuation in one structured call; Sonnet for drafts and voice extraction; prompt caching on per-creator context.
**Alternatives rejected:** OpenAI (comparable, but Claude's Hinglish handling + caching economics fit better and integration patterns are in-house via `claude-api` skill); provider-agnostic layer from day one (premature abstraction — model-specific prompt tuning matters more than swappability in pilot; revisit at V1).
**Consequence:** single-provider risk — mitigated by versioned prompts and the eval harness making a provider migration measurable.

### ADR-3 · `MessagingProvider` interface with mock-first development
**Decision:** All platform I/O behind one interface; seeded mock adapter is a first-class citizen used by demos, tests, and pre-approval development.
**Alternatives rejected:** building directly against Graph API — blocks the entire team on Meta app review (weeks) and makes E2E tests flaky/rate-limited.
**Consequence:** WhatsApp (V2, PRD §9) becomes "write one adapter"; slight risk the mock diverges from real API behavior — mitigated by contract tests run against both adapters in staging.

### ADR-4 · Dual-rail billing: Razorpay (INR) + Paddle MoR (international)
**Decision:** One `BillingProvider` interface, two rails selected by org currency. Razorpay for INR (UPI Autopay mandates); Paddle as merchant of record for everything else — Paddle owns global sales-tax/VAT/GST compliance so the founding team files nothing internationally. Subscription created only after the 7-day active-use gate on both rails.
**Alternatives rejected:** Stripe direct for international (lower fees but we become liable for tax registration/filing in every jurisdiction we cross thresholds in); Stripe India for INR (weaker UPI mandate support); manual invoicing (doesn't exercise the real billing loop the pilot must validate); single global provider (no one rail serves both UPI mandates and MoR tax handling well).
**Consequence:** two webhook formats normalized to internal events; both backed by a reconciliation poller; Paddle's ~5% take on international revenue accepted as the cost of zero tax ops.

### ADR-5 · Few-shot personalization, no fine-tuning in pilot
**Decision:** Voice = style card + exemplars; corrections = few-shot examples in the classification prompt.
**Alternatives rejected:** per-creator fine-tunes — cost, latency of iteration, and data volume don't justify it at pilot scale; harder to reason about isolation.
**Consequence:** prompt context grows per creator — bounded by capping exemplars and relying on prompt caching.

### ADR-6 · Clerk for identity
**Decision:** Clerk Organizations for auth + seats.
**Alternatives rejected:** Auth.js (weak org/seat model — we'd rebuild Clerk's core feature); custom auth (not the business we're in; security-sensitive product should not have hand-rolled sessions).
**Consequence:** vendor dependency; mitigated by keeping `Seat` authoritative in our DB so migration = swap identity provider only.

### ADR-7 · Application-layer tenancy now, Postgres RLS later
**Decision:** Org-scoped repository layer as the single tenancy chokepoint for pilot.
**Alternatives rejected for now:** RLS from day one — stronger guarantee but slows every migration/query iteration during the fastest-changing phase; planned as V1 hardening once schema stabilizes.
**Consequence:** repository layer is the only allowed DB access path — enforced by lint rule (no `@prisma/client` imports outside `packages/db`).

### ADR-8 · Postgres as the only source of state (no separate vector DB, no CRM objects)
**Decision:** Everything — messages, classifications, ledger — lives in Postgres. No embeddings store in pilot (classification is prompt-based, not retrieval-based). Keeps PRD non-goals (§3.3: no CRM/pipelines) structurally true.
**Consequence:** if V1 needs semantic search over DM history, add `pgvector` — no new infra.

### ADR-9 · One currency per organization, integer minor units
**Decision:** `Organization.currencyCode` set at onboarding; all estimates, ledger entries, and billing follow it. Amounts stored as integer minor units with the currency denormalized onto `LedgerEntry` at write time so history never rewrites.
**Alternatives rejected:** multi-currency ledger with FX conversion — requires rate sourcing, historical-rate storage, and reporting complexity for a case (<5% of pilot creators) that a note field covers; global float amounts (precision bugs).
**Consequence:** internal cross-org aggregates USD-normalize at a fixed monthly rate (analytics-only, never shown to users); org currency is immutable; locale and timezone remain editable.

### ADR-10 · PWA + Web Push instead of native apps
**Decision:** Installable PWA with VAPID Web Push (high-value DM alerts, nudge alerts, weekly summary). Contextual permission ask (after first high-value DM seen, never on load).
**Alternatives rejected:** native iOS/Android apps (PRD §12 out of scope — two more codebases and store-review cycles for a pilot); email-only notifications (too slow for the 24-hour brand reply window that decides deals).
**Consequence:** Unsupported devices use the in-app inbox and review counts. Weekly push and email digests are deferred; push delivery is best-effort, so nothing critical depends on it. Quiet hours suppress rather than delay notifications.

---

*Maintained by: the founding team. Update cadence: every ADR-worthy decision lands here in the same PR that implements it.*
