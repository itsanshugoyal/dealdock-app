# Pending engineering and launch gates

Recorded 1 November 2026 from the [product audit](docs/ux-and-product-audit-2026-11-01.md). Local tests and demo walkthroughs do not establish live-provider readiness. The remaining work below is not implemented by the audit-hardening PR.

## Engineering — before enabling the affected feature

- [x] **Creator-specific business facts:** store and retrieve business summaries and price context per Instagram account. Test two creators with different offers so agency prompts cannot mix their facts. Built 5 November ("What you sell" per creator).
- [ ] **Consent ownership:** map the person authorized to grant writing/speaking consent to the particular creator account. An organization role alone is insufficient.
- [ ] **Speaking-voice deletion:** retain vendor voice identifiers until deletion succeeds; use durable retryable deletion work when replacing or withdrawing a voice.
- [ ] **Audio approval:** bind approval to the exact previewed clip, text and voice revision, and prevent duplicate synthesis. Keep customer audio sending disabled until these controls and provider validation pass.
- [ ] **Synthetic-audio disclosure (built 5 November; legal review still needed):** India’s IT Rules have required a “prominently prefixed audio disclosure” on synthetic audio since 20 February 2026. Today the disclosure is a separate, best-effort text message. Add a spoken prefix to the clip itself, treat a missing disclosure as a failed send, and get legal review before any Indian creator uses speaking voice. See [the workflow review](docs/workflow-and-functionality-review-2026-11-04.md).
- [ ] **Invoices flag (`FEATURE_INVOICES_ENABLED`):** set it to `"false"` in production until a chartered accountant signs off on the GST/VAT invoices. Once they're approved and live, remove the flag from the registry, the routes and the web (see AGENTS.md "Feature flags").
- [ ] **Previously learned influence:** offer an explicit provenance-aware reset/rebuild after sample exclusion. Forward filtering and stale-result rejection are implemented; exclusion does not retrospectively erase existing rules or style-card influence.

## Owner/account-dependent gates

| Action | Owner | Acceptance evidence |
|---|---|---|
| Production AI is configured as OpenAI `gpt-6-luna` at high effort, with Groq as the fallback. Run the blind 50-draft review on it | Owner and co-founder | 7 Nov: the 258-case classification gate passes with the `2.4.0-course` prompt: 97.7% exact, spam 100%, course enquiry 96.4%, coaching 90.0%, uncertain-to-review 100%. Details in [the provider guide](docs/groq-provider.md). |
| Regenerate 50 real-model drafts and blind-score them independently | Both founders | At least 70% A/B ratings, with recorded scores. |
| Complete Meta Business verification and app review. Also request `instagram_business_manage_comments` (comment leads) and `instagram_business_manage_insights` (results for proof of results), each with Advanced Access, in this submission or a second one | Anshu/account owner | Approved permissions, confirmed callback/origins, real incoming message, approved reply and delivery receipt, disconnect/reconnect. Verify available history and Requests coverage. Until approval, only accounts with a role on the app work. |
| Verify Clerk organizations, invitations and roles | Anshu | Real account flows and correct deployed callback/origin configuration; deployed auth bypass remains unset. |
| Razorpay: test plans (Solo, Studio, Roster) and the webhook `https://api.dealdock.io/webhooks/razorpay`, then the same in live mode after approval. Paddle: apply now (policy pages live; submit `dealdock.io` and `app.dealdock.io`; describe DealDock as a deal inbox with replies you approve, never as automation). Then, per environment, create an API key, put it in `.env` as `PADDLE_API_KEY` and run `node --env-file=.env scripts/paddle-setup.mjs --env sandbox` (later `--env live` with the live key); it creates the product, the three USD prices, the webhook, the `/pay` payment link and the client token, and prints the Doppler values. Live: re-run after `app.dealdock.io` is approved so the payment link is set | Anshu | Charge, failure, cancellation and reconciliation checks; agreed pilot billing terms before charging. |
| Configure VAPID and verify installed-device notifications | Anshu | Delivery evidence on intended iOS/Android devices and understood quiet-hour behavior. |
| Validate optional speech provider and rights | Anshu/creator owner | Account-specific consent/rights, processor terms, deletion proof, language listening tests and actual Meta audio/disclosure delivery. No purchase is required by this task. |
| Approve deployment separately | Anshu | Secrets separation, migrations, backup/restore, readiness and monitoring checks for Vercel, Railway, Railway Postgres and Railway Redis (7 November: Railway Postgres replaces Neon). No deployment has been performed here. |
| Inspect automatic Vercel preview failure on PR #2 | Vercel project owner | Open deployment `dpl_9HT6idAgNUQAKjKKX5ZfUzjVyJaw` logs in the `infinitys-projects-ec52fa2b` project scope. The installed CLI's account cannot access those logs; no build cause has been established and no retry/deployment was requested. |
| Create the Google OAuth app for Gmail and set its publishing status to In production (unverified): up to 100 users, who see a warning screen. Avoid Testing mode, where access expires every 7 days. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI on the API | Anshu | A real inbox connects, the first 30-day sync lands, a reply sends as a threaded Gmail reply after approval, and a disconnect stops syncing. |
| Start Google verification for the restricted Gmail scopes now: brand verification, Search Console, a demo video and the annual CASA assessment from an approved lab (about $500–900 a year; 4–8 weeks in total) | Anshu | Verified consent screen; assessment letter on file. |
| Optional near-real-time Gmail: a Pub/Sub topic with Gmail push permission; set GMAIL_PUBSUB_TOPIC and GMAIL_PUBSUB_VERIFICATION_TOKEN | Anshu | New mail appears within a minute; with push off, the 2-minute poll still syncs. |
| Send an invoice PDF as an Instagram file message on a real account (needs PUBLIC_API_URL on https) | Anshu | The brand receives the PDF; a refusal returns the hint and the PDF downloads. |
| Run the deals and invoice integration suites on a real Postgres (row locks and races; the local run used single-session embedded Postgres) | Engineering | Deals, invoices and off-platform suites pass on Postgres with concurrency. |

## Go-live checklist (updated 22 November)

Order, DNS values and vendor details are in [the go-live guide](docs/go-live-2026-11-07.md). Launch is the private pilot: Instagram only, text replies, creators onboarded personally and added as Instagram testers until Meta approves.

### 1. Start now: the long waits, and how each is kept off the critical path

| Item | Typical wait | Mitigation |
|---|---|---|
| Meta Business Verification | up to 14 business days | Pilot creators are Instagram testers (50 max, 500 once verified). `META_*` flags stay off. |
| Meta App Review (messages, comments, insights) | weeks | Same tester route. Needed only for public signup. |
| Razorpay KYC → live mode (they asked for the IBT/business-model reply) | unknown | Billing starts on day 7. The scheduler skips any rail that isn't configured. |
| Paddle account + domain approval (`dealdock.io`, `app.dealdock.io`) | 5–7 business days, may decline | Non-INR workspaces wait until Paddle's keys are set. Fallback: Dodo Payments. |
| Google verification + CASA | 4–8 weeks, ~$500/yr | Gmail is off while `GOOGLE_*` is unset; launch on the unverified 100-user tier. |
| Chartered accountant review of invoices | days–weeks | `FEATURE_INVOICES_ENABLED=false` in production until sign-off. |
| Legal review of the privacy policy | days–weeks | Publish a careful draft, swap in the reviewed text. Speaking voice stays off. |
| DNS propagation | up to 72 hours | Add records on day 1. |

### 2. Engineering

- [x] **E1** Feature build committed (`73cbceb`, 21 Nov) and pushed.
- [ ] **E2** CI green on the branch: commit today's changes and push. Locally (22 Nov): typecheck, lint, safety, 965 unit tests, `npm audit` (0), migrations + drift check and all 106 DB integration tests pass. The Redis-backed integration gate and the browser tests run only in CI.
- [x] **E3** Billing scheduler: skips unconfigured rails, releases the claim only on a definite rail refusal (ambiguous failures log `NEEDS MANUAL CHECK`), one org's failure no longer stops the tick, unpaid Paddle checkouts cancel via their transaction.
- [x] **E4** Feature-flag registry (`packages/core/src/feature-flags.ts`, see AGENTS.md) with `invoices` behind it.
- [x] Paddle checkout: `/pay` page and `scripts/paddle-setup.mjs`.
- [ ] **E5** Sentry SDK in web, API and worker (should alert on `NEEDS MANUAL CHECK`). *Deferred.*
- [ ] **E6** Nightly database dump stored off the host. *Deferred.*
- [ ] Billing manual check until a stale-claim sweep exists: on `NEEDS MANUAL CHECK`, look the org up in the rail dashboard, then save the subscription or clear `firstInvoiceRequestedAt`. Confirm Paddle honours `Idempotency-Key`.
- [ ] Hosting files for the chosen host (only if a VPS: Dockerfiles, compose, Caddy, backup cron).

### 3. Accounts and hosting (owner)

- [ ] **A1** Policy pages on dealdock.io, linked in the footer: Terms, Privacy, Data deletion, Refunds, Delivery, Contact, Pricing, Features. Prompt: [docs/policy-pages-prompt.md](docs/policy-pages-prompt.md). Fill its placeholders (legal name, address, phone, grievance officer, hosting providers).
- [x] **Hosting decided (22 Nov):** web on the marketing site's Vercel account (free now, Pro before the first creator pays), API/worker/Postgres/Redis on Railway Hobby in Singapore. Step-by-step: [docs/deploy-railway-vercel.md](docs/deploy-railway-vercel.md). Production secrets generated in `.env.production.secrets.local` (gitignored).
- [ ] Disconnect or delete the old Vercel project (`dealdock-app-web` in `infinitys-projects`); it posts a failing check on every PR.
- [ ] **A2** DNS: `app` and `api` to the chosen host (Railway also needs its TXT record), Clerk's `clerk`, `accounts`, `clkmail` and DKIM records ("DNS only" on Cloudflare), Search Console TXT, `_dmarc`. Keep Zoho's records and exactly one SPF record.
- [ ] **A3/A4** Hosting up: web at `app.dealdock.io`, API at `api.dealdock.io`, worker, Postgres (point-in-time restore or the E6 dump) and Redis (AOF on), all in Singapore or India.
- [ ] **A5** Doppler syncing `prd_web`, `prd_api` and `prd_worker` with every value in section 4.
- [ ] **A6** Clerk production: domain `dealdock.io`, allowed subdomain `app.dealdock.io`, Google sign-in with its own OAuth client.
- [ ] **A7** Meta app: callback `https://api.dealdock.io/ig/callback`, webhook URL and verify token, each pilot creator added as an Instagram tester.
- [ ] **A8** Razorpay test mode: Solo, Studio and Roster plans, webhook `https://api.dealdock.io/webhooks/razorpay`, then subscribe → renew → fail → cancel. Repeat in live mode after approval.
- [ ] **A8b** Paddle (22 Nov: sandbox fully set up, values in `.env`; live set up except the payment link, values in `.env.live.local`, waiting on `app.dealdock.io` domain approval, then re-run `--env live`): sandbox account → API key → `node --env-file=.env scripts/paddle-setup.mjs --env sandbox` → values into Doppler dev/stg. Live account → verification and domain approval → the same with `--env live` → values into prd; re-run after `app.dealdock.io` is approved so the payment link is set.
- [ ] **A9** Monitoring: Sentry projects (with E5), UptimeRobot on `app.dealdock.io` and `api.dealdock.io/ready`, two-factor login on every vendor and the registrar, domain auto-renew.
- [ ] **A10** VAPID keys, generated once (`npx web-push generate-vapid-keys`).

### 4. Production settings, per service

- [ ] **Web (`prd_web`):** `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_API_URL=https://api.dealdock.io`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `NEXT_PUBLIC_DEALDOCK_DEMO_MODE=false`, `NEXT_PUBLIC_PADDLE_ENV`, `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` (both inlined at build time: rebuild after changing).
- [ ] **API (`prd_api`):** `DATABASE_URL`, `REDIS_URL`, `CLERK_SECRET_KEY`, `WEB_APP_URL=https://app.dealdock.io`, `PUBLIC_API_URL=https://api.dealdock.io`, `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `IG_OAUTH_REDIRECT_URI=https://api.dealdock.io/ig/callback`, `TOKEN_ENCRYPTION_KEY` and `MEDIA_SIGNING_KEY` (API only; never rotate the encryption key casually), `AI_PROVIDER=openai`, `AI_FALLBACK_PROVIDER=groq`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `OPENAI_REASONING_EFFORT=high`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLAN_SOLO/STUDIO/ROSTER`, `PADDLE_ENV`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_SOLO/STUDIO/ROSTER`, `FEATURE_INVOICES_ENABLED=false`. Later: `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`, `GMAIL_PUBSUB_*`, Sentry DSN.
- [ ] **Worker (`prd_worker`):** `DATABASE_URL`, `REDIS_URL`, the API's AI settings, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, the Razorpay keys and plan ids, `PADDLE_ENV`, `PADDLE_API_KEY`, `PADDLE_PRICE_*` (the billing scheduler runs here). **Never** Meta, Google or encryption keys: the worker refuses to start with them.
- [ ] **Off or unset in production:** `META_COMMENTS_ENABLED`, `META_INSIGHTS_ENABLED`, `META_HUMAN_AGENT_ENABLED` (until Meta approves), `SPEECH_PROVIDER` (voice off). **Never set** `DEALDOCK_DISABLE_AUTH`, `DEALDOCK_DEV_ORG_ID`, `MOCK_WEBHOOK_SECRET`, `DEALDOCK_AI_MODE`, `DEALDOCK_API_URL`.

### 5. Launch-day checks

- [ ] `https://api.dealdock.io/ready` answers, the worker runs, migrations applied (`npm run db:migrate -w @dealdock/db`, never `db push` or the demo seed).
- [ ] Clerk sign-in, invite and sign-out on `app.dealdock.io`.
- [ ] One real Instagram account: DM in → sorted → draft → approved → delivered; disconnect and reconnect.
- [ ] Push notification on a real iPhone and a real Android phone.
- [ ] Backup-restore drill; data export and deletion drill.
- [ ] A test error reaches Sentry (after E5); an uptime alert fires.
- [ ] Paddle sandbox: open a `/pay?_ptxn=…` checkout and pay with a test card; the webhook marks the subscription active.
- [ ] Strongly recommended: both founders blind-score 50 real drafts (≥70% A/B).

### 6. After launch (optional)

- [ ] Meta approval → drop the tester step, open signup, turn on `META_COMMENTS_ENABLED` / `META_INSIGHTS_ENABLED`.
- [ ] Paddle live approval → live keys, non-INR billing open.
- [ ] CA sign-off → `FEATURE_INVOICES_ENABLED=true`, one live invoice PDF on Instagram, then remove the flag.
- [ ] Gmail: `GOOGLE_*` keys and one real-inbox test; CASA when nearing 100 users; Pub/Sub for instant mail.
- [ ] Reviewed privacy policy; Sentry (E5) and off-host dump (E6) if not done before launch.
- [ ] Web shows invoice buttons briefly before `/dashboard` answers when the flag is off: hide flagged UI until flags load.
- [ ] Stale first-invoice claim sweep that reconciles by `requestKey`.
- [ ] Later channels: WhatsApp (about 3–5 weeks plus Meta approvals) and TikTok for creators outside India (about 3–4 weeks plus TikTok's reviews). Details in [the go-live guide](docs/go-live-2026-11-07.md#whatsapp-scopes-steps-effort-and-blockers).

## Private-pilot improvements

- [ ] Measure first useful draft and first confirmed sale with creators on actual phones/networks.
- [ ] Measure large-inbox latency/memory; move from complete cursor scans to server-filtered incremental lists with exact scoped aggregates when warranted.
- [ ] Validate quiet-hour expectations. Notifications are currently suppressed rather than deferred; no weekly digest scheduler exists.
- [ ] Evaluate learning quality and historical authorship ambiguity. Native outbound direction does not identify the individual author.
- [ ] Improve and validate audio-only review navigation, transcript fallback, and inaccessible/expired-media recovery before promising complete incoming-audio support.

## After validation

Additional channels, semantic search, deeper agency analytics and database RLS remain demand-led work. Keep the first pilot text-first and personally onboarded; enable agency/audio promises only after their specific gates pass. Nothing auto-sends, and the worker must retain zero message-send capability.

## Before invoices go live (chartered accountant review)

The invoice PDFs follow the rules below. A chartered accountant should confirm or correct each one before any creator issues a real invoice.

- [ ] **Fee excludes tax.** The deal fee excludes GST/VAT, and tax is added on top. Revenue records what was received plus TDS, minus tax, so GST never counts as revenue.
- [ ] **Reverse charge.** Every GST invoice prints "Reverse charge: No". Sponsorship services supplied to companies and partnerships may fall under reverse charge, which is not modelled yet.
- [ ] **Export of services.** Any recipient outside India is treated as an export (zero-rated under a LUT, otherwise IGST). It is not checked whether an INR-priced invoice paid in rupees still qualifies as an export.
- [ ] **Signature.** The PDF says no signature is required. Confirm whether a digital signature is needed on GST invoices.
- [ ] **Declaration wording.** The LUT and IGST export declarations use short wording, not the full statutory text.
- [ ] **Voided invoices.** Voiding has no credit note.
- [ ] **Validation.** PAN holder-type letters and the LUT ARN format are checked loosely.
- [ ] **Invoice numbers.** Each workspace or creator has a prefix of up to 4 characters, then the financial year, then a sequence (`PREFIX-2026-27-001`). Numbers stay within GST's 16 characters.
- [ ] **E-invoicing (IRN)** for turnover above ₹5 crore is not built.
- [ ] **UPI QR.** The QR is shown only for Indian payers on invoices up to ₹1,00,000, the usual UPI limit.
- [ ] **SAC code.** Confirm the default SAC code creators should use for sponsored content and coaching.
