# DealDock — Execution Plan

**Status:** Living document · v1.1 · Pilot scope, global-ready
**Source of truth for requirements:** `DealDock_Product_PRD.md` (v1.1 — in this repo)
**Companions:** `ARCHITECTURE.md` (how) · `DESIGN.md` (what it looks like)

> **v1.1:** global-ready build (org currency/locale/timezone, dual-rail billing with Paddle), Leak Scan, waiting-state nudges, and PWA push folded into milestones. Pilot cohort stays India-first; ≥1 non-INR validation org added as an M6 exit criterion.

One number matters: **recovered ₹ per active creator per month.** Every milestone below exists to get a real creator to a real close-out faster, or to make that number trustworthy.

---

## 0. Operating rules

1. **The PRD's out-of-scope list (§12) is law.** No public API, no native apps, no scheduled send, no bulk outbound, no team chat, no Chrome extension, no autonomous replies. If a task looks like one of these, it dies in review.
2. **Never-auto-send is structural** (ARCHITECTURE.md §6.2), and it is tested in CI — a test asserts the worker has no send path.
3. **Mock-first:** every milestone up to M3 demos end-to-end on `MockInstagramAdapter`. Meta approval never blocks product progress.
4. Docs stay live: any PR that changes an architectural decision, screen, or milestone updates the corresponding doc in the same PR.
5. Weekly internal metrics review from M1 onward (PRD §7.4: real numbers tracked from week 1).

## 1. Milestones

Sequence, scope, exit criteria. "Hat" = which team role owns quality for the milestone.

### M0 — Foundation *(hats: Architect, DevOps, DBA)*

**Scope**
- Turborepo scaffold: `apps/web` (Next.js 15), `apps/api` (Fastify), `apps/worker` (BullMQ), `packages/core|db|messaging|ai` per ARCHITECTURE.md §2. ✅ *(done pre-M0)*
- Prisma schema for the full data model (ARCHITECTURE.md §3) + first migration — including org `currencyCode`/`locale`/`timezone`, minor-unit money columns, `waiting` thread state, and `PushSubscription`; repository layer with org-scoping + lint rule banning Prisma imports outside `packages/db`.
- `MoneyValue`/`MoneyCounter` formatting utilities in `packages/core` (Intl-based, en-IN lakh/crore + standard grouping) — money formatting is foundation, not polish.
- Clerk integration (orgs, seats, roles) with tier-limit middleware.
- `docker-compose` local env (Postgres + Redis); CI: typecheck, lint, unit tests, migration diff.
- `MessagingProvider` interface + `MockInstagramAdapter` + Hinglish fixture corpus v1 (≥200 labelled messages across all 8 classes, weighted per PRD anti-persona/persona shapes).
- **Start Meta app review track now** (Tech Provider registration, app creation, permission request draft) — longest lead time in the project.

**Exit criteria**
- `npm install && npm run build` green at root; CI green.
- Seeded local env shows fixture DMs flowing: webhook-sim → queue → DB rows.
- Meta app review submission checklist drafted with screencast requirements.

### M1 — Core loop on mock data *(hats: Backend, Frontend, AI)*

**Scope**
- AI pipeline v1 (ARCHITECTURE.md §5): single Haiku classify+value call (value in org currency), confidence gate, Sonnet drafting for high-intent classes; prompt caching; model/prompt version stamping.
- API surface (ARCHITECTURE.md §6.1): inbox, thread, draft, send (mock), close, review, ledger, thread-state transitions (`open ↔ waiting ↔ closed` — nudge *drafting* lands in M2).
- Screens (DESIGN.md §4): Revenue Inbox (incl. waiting chips + audio-DM flagged rows), Thread view + draft composer + close-deal modal + "Move to Waiting?" toast, Review Queue, Ledger v1, Dashboard tile.
- Audit log on every send.

**Exit criteria**
- **The demo:** connect mock account → DM "arrives" → classified row in inbox in <60s → open thread → draft present → edit → Approve & Send → Mark closed ₹50,000 → dashboard tile updates. All on video, no cuts.
- Voice-fidelity + accuracy metrics computing from day-one data (even if numbers are rough).
- Zero paths from worker to send (CI test).

### M2 — AI quality *(hats: AI, QA · this is the make-or-break milestone)*

**Scope**
- Golden eval set: **≥250 hand-labelled DMs (114 unique hand-written cases + label-preserving slot expansion), ≥50% Hinglish/code-switched** (PRD risk §10.1.2 is the P0 quality bar), including adversarial hard cases (spam dressed as brand deals, deals that sound casual, fans with near-buying intent). *Sizing amended from "≥500": quality per case beats mechanical inflation — the set grows toward 500+ with anonymized, human-corrected pilot data, which is higher-signal than synthetic padding.* Eval framework supports per-market language slices for V1. `npm run eval` in CI on prompt changes.
- Value-estimation calibration against onboarding context ranges (currency-aware).
- Review Queue feedback loop → per-creator few-shot corrections (nightly job).
- Voice modeling v1: consented sent-DM sampling → style card → draft prompts; edit-distance tracking wired to the weekly dashboard.
- **Nudge drafting** (PRD §6.5): follow-up draft type (short, warm, non-pushy) + the nudge scheduler job + NudgeBanner UI.
- Onboarding wizard (DESIGN.md §4.1) including region step, the 10-question business context, **and the Leak Scan** — 30-day backfill classification (incl. message-requests folder) with the reveal moment. Leak Scan reuses the M1 pipeline in batch mode; this is where activation is won.

**Exit criteria (gates M3)**
- Classification ≥85% top-level on eval set (path to ≥90% by pilot end, PRD §7.4).
- 100% of <0.80-confidence messages route to Review Queue, never inbox (invariant test).
- Draft quality: founding team blind-review of 50 drafts — ≥70% "would send with ≤ minor edits."

### M3 — Real Instagram *(hats: Backend, Security)*

**Scope**
- `InstagramGraphAdapter`: OAuth connect (Business/Creator detection + Personal-account guidance), webhook subscription + signature verification, send within 24h window, per-account rate-limit budget (ARCHITECTURE.md §4.2).
- Ingestion self-healing: checkpoints + 15-min backfill + token-health job + reconnect banner.
- Contract tests run against both adapters; staging env with a real test IG account.

**Exit criteria**
- Founding team's own IG accounts run the full loop live: real DM → inbox <60s → drafted → sent from DealDock → visible in IG app.
- Kill-switch drill: revoke token mid-day → system degrades gracefully → reconnect flow recovers with zero lost messages (backfill proof).
- Meta app review **approved** (or explicit go/no-go call with founding team if still pending — pilot can start on founders' accounts + allowlisted testers).

### M4 — Billing, multi-seat & notifications *(hats: Backend, PM)*

**Scope**
- **Dual-rail billing behind one `BillingProvider` interface** (ARCHITECTURE.md §9, ADR-4): Razorpay (INR orgs — UPI Autopay) + Paddle MoR (all other currencies). Shared flow: active-use gate → 7 days → first invoice; normalized webhooks + reconciliation poller; past-due grace; cancel-at-period-end; pilot price lock (₹ and $ price points).
- Studio: 2 seats, assistant role, per-seat audit. Roster: ≤5 accounts, manager seats, roster overview screen, per-creator exports (DESIGN.md §4.7).
- **PWA + Web Push** (ADR-10): manifest + service worker, VAPID push (high-value DM / nudge due / weekly summary), contextual permission prompt, quiet hours per org timezone, per-type toggles.
- Settings: region (currency/locale/timezone/nudge delay), notifications, data view, export archive, delete (7-day grace), ignore list, voice toggle, cancel flow (DESIGN.md §4.8).

**Exit criteria**
- Test subscriptions complete a full charge lifecycle on **both rails** (Razorpay test mode incl. UPI Autopay mandate; Paddle sandbox in USD) incl. cancellation and post-cancel read-only ledger.
- Seat-limit and role-permission matrix fully covered by API tests.
- Push notification round-trip verified on Android Chrome + iOS ≥16.4 Safari (installed PWA).

### M5 — Hardening *(hats: Security, QA, DevOps)*

**Scope**
- Security pass per ARCHITECTURE.md §8: token encryption audit, log-scrubbing verification, secrets review, dependency audit; external-eyes review of the send gate and tenancy chokepoint.
- Latency: p95 dashboard <2s on throttled 4G profile; ingestion <60s p95; draft <5s p95 (PRD §7.3).
- Load test: 50 creators × 500 DMs/day synthetic.
- Retention/deletion jobs verified end-to-end (export → delete → prove gone).
- Uptime monitoring + IST-aware alerting; runbooks for: Meta outage, queue backlog, Claude degradation, Razorpay webhook loss.

**Exit criteria:** all budgets met on staging under load; deletion drill documented; on-call runbook exists.

### M6 — Pilot launch *(hats: Founder, PM)*

**Scope**
- Onboarding runbook for the 20-min call (script, checklist, voice-consent language, privacy FAQ per PRD §7.1).
- Weekly metrics dashboard (internal): north star + supporting metrics (§2 below).
- Cohort intake: applications from the marketing site funnel → selection criteria (persona fit §4 PRD, Hinglish-heavy inboxes prioritized).
- Feedback loop: weekly creator check-ins for the first 4 weeks.

**Exit criteria:** first cohort creators onboarded; **first real LedgerEntry within 14 days of each onboarding** (PRD §5.1 success criterion); **≥1 non-INR org runs the full loop** (currency/locale/Paddle rails proven — PRD §3.1.6); weekly dashboard reviewed in founding-team ritual.

## 2. Metrics instrumentation (from M1, PostHog + SQL)

| Metric | Definition | PRD |
|---|---|---|
| **Recovered revenue / creator / month** ★ | sum(LedgerEntry.amount) per org per month, org currency (internal aggregate USD-normalized, fixed monthly rate) | §11.1 |
| Activation | % orgs with first LedgerEntry ≤14 days from onboarding | §11.2 |
| Leak Scan impact | % onboardings finding ≥1 actionable commerce thread; headline value found | §11.2 |
| Nudge conversion | % sent follow-up nudges getting a counterparty reply ≤7 days | §11.2 |
| Push opt-in | % seats granting push permission (contextual prompt effectiveness) | §11.2 |
| Voice fidelity | % sent drafts with editDistance <20% chars | §7.4 |
| Classification accuracy | % review items confirmed + eval-set score per prompt version | §7.4 |
| Queue clearance time | avg age of review item at classification | §11.2 |
| Time-to-first-reply (high-value) | median, week over week | §11.2 |
| Engagement | WAU creators, daily inbox-open rate | §11.2 |
| Business | pilot→paid conversion, churn, NRR, cost per onboarded creator | §11.3 |
| Ops (internal) | ingestion p95, draft p95, queue depth, Claude spend/org, Meta rate-limit headroom | §7.3 |

## 3. Risk register

| # | Risk (PRD §10 + new) | Mitigation | Early-warning signal |
|---|---|---|---|
| 1 | Meta policy change / app-review rejection | Official API only; mock adapter keeps dev unblocked; WhatsApp adapter design ready (V2); weekly policy watch | Review feedback tone; policy changelog diffs |
| 2 | Hinglish accuracy below bar | Hinglish-weighted eval set gates every prompt change; pilot cohort weighted to Hinglish inboxes | Eval score dip; review-queue override rate ↑ |
| 3 | Voice cold start → disengagement | Onboarding questionnaire seeds style card day one; expectation-setting copy (DESIGN.md §4.1.5); heavy first-week support | Draft discard rate ↑ in week 1 |
| 4 | Misclassification reputation damage | <0.80 confidence → Review Queue always; nothing auto-sends, structurally | Any confirmed brand-brief-in-fan-folder incident (target: 0) |
| 5 | Attribution under-counting | One-tap close in sticky bar; gentle nudge when thread looks concluded; dashboard prominence | Close-outs per active creator trending ↓ |
| 6 | Meta rate limits throttle ingestion (200/hr reality) | Webhook-first, budgeted fetches, queue-don't-drop | Rate-limit headroom metric <20% |
| 7 | Claude cost blowout at 500 DMs/day | Haiku for volume, one call for classify+value, prompt caching, spend/org alert | Spend per org > ₹X threshold (set in M1) |
| 8 | Single-provider AI risk | Versioned prompts + eval harness make migration measurable (ADR-2) | Provider incident history |
| 9 | Billing webhook loss (either rail) → state drift | Reconciliation poller over both Razorpay and Paddle; state machine tolerant of replays | State-mismatch alerts |
| 10 | Small-team bus factor | Docs-as-law (this trio), runbooks in M5, boring tech choices | Onboarding a helper takes >2 days |
| 11 | Native-platform encroachment (IG sort/filter, Meta AI, creator subscriptions) | Differentiate on value estimation + voice + longitudinal ledger — what platform AI structurally won't build | Quarterly Meta feature review |
| 12 | Currency/locale bugs erode trust (wrong grouping, wrong symbol) | Money formatting centralized in `MoneyValue` utils + snapshot tests per locale; no ad-hoc formatting anywhere | Any formatting bug report (target: 0) |

## 4. Open questions log (PRD §10.2 — each needs an owner + decision milestone)

| Question | Decide by | Leaning |
|---|---|---|
| Reels-DM / Story replies in same inbox? | M2 (classify separately, observe) | Ingest + tag `source`; same inbox, filterable |
| Group DMs? | M3 | Ingest, classify, but default-filter out; brand pitches in groups get surfaced by label |
| ~~"Snooze until reply" state?~~ | **Resolved v1.1** | `waiting` state + nudges are pilot scope (PRD §6.5) |
| Creator visibility into manager sends (Roster)? | **Resolved v1.1** | Yes — audit view visible to creator seat (PRD §5.6.5) |
| Ignore-list defaults aggressiveness? | M2 | Conservative defaults; suggest during onboarding from top-DM'd handles |
| Nudge etiquette per market/type? | M2 → tune in pilot | 3-day default; consider faster for brand briefs, slower for coaching; observe nudge-conversion metric |
| Autonomous mode for trivial fan replies? | **Never in pilot** (PRD §3.3) | Revisit post-pilot, opt-in, low-stakes classes only |

**V1 backlog (agreed v1.1, do not build in pilot):** weekly digest email · rate-card quick-insert in composer · monthly "leak report" · audio-DM transcription + classification · multi-currency conversion consideration · per-market language eval slices · Postgres RLS hardening.

## 4.5 Skills toolkit (applied per milestone)

Skills from `~/.claude/skills` used while building; each milestone's owner loads these before implementation:

| Milestone | Skills |
|---|---|
| M0 Foundation | `prisma-expert`, `postgres-best-practices`, `database-design`, `clerk-auth`, `zod-validation-expert`, `docker-expert`, `github-actions-templates`, `bullmq-specialist`, `tdd-workflow` |
| M1 Core loop | `claude-api`, `llm-app-patterns`, `prompt-engineering-patterns`, `nextjs-best-practices`, `react-best-practices`, `tailwind-design-system`, `api-design-principles`, `ux-flow` (flow rules), `mobile-design` (touch-first), `fixing-accessibility` |
| M2 AI quality + onboarding | `advanced-evaluation` / `llm-evaluation`, `prompt-engineering-patterns`, `onboarding-cro` (Leak Scan → first-send activation), `form-cro`, `ux-copy` |
| M3 Real Instagram | `api-security-best-practices`, `webhook patterns via api-patterns` |
| M4 Billing/seats/notifications | `payment-integration`, `stripe-integration` (Paddle analog), `progressive-web-app` (manifest + offline page + push), `saas-multi-tenant` |
| M5 Hardening | `security-audit`, `api-security-testing`, `wcag-audit-patterns`, `performance-optimizer`, `web-performance-optimization` |
| Cross-cutting UX review | `uxui-principles` (antipattern audit before each milestone ships), `ux-audit`, `design-taste-frontend`, `high-end-visual-design` |

**UX-skill findings already folded into DESIGN.md (v1.1):** flow rules + ≤3-tap reachability (principle 7), 44px touch targets/thumb zone (principle 8), classification rationale transparency (principle 9 + Review cards), onboarding "do-don't-show" first-send activation (§4.1.6), modal focus traps + form-error a11y (§7), honest-offline PWA behavior (§7.5).

## 5. Definition of Done (every PR)

- Typecheck + lint + tests green; eval suite green if prompts touched.
- Org-scoping respected (no raw Prisma outside `packages/db`).
- No DM content in logs.
- Docs updated if a decision changed.
- Screens match DESIGN.md or DESIGN.md updated first.

---

*Owned by PM/founder. Reviewed at each milestone boundary; milestones may re-scope, the north star may not.*
