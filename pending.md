# Pending engineering and launch gates

Recorded 1 November 2026 from the [product audit](docs/ux-and-product-audit-2026-11-01.md). Local tests and demo walkthroughs do not establish live-provider readiness. The remaining work below is not implemented by the audit-hardening PR.

## Engineering — before enabling the affected feature

- [x] **Creator-specific business facts:** store and retrieve business summaries and price context per Instagram account. Test two creators with different offers so agency prompts cannot mix their facts. Built 5 November ("What you sell" per creator).
- [ ] **Consent ownership:** map the person authorized to grant writing/speaking consent to the particular creator account. An organization role alone is insufficient.
- [ ] **Speaking-voice deletion:** retain vendor voice identifiers until deletion succeeds; use durable retryable deletion work when replacing or withdrawing a voice.
- [ ] **Audio approval:** bind approval to the exact previewed clip, text and voice revision, and prevent duplicate synthesis. Keep customer audio sending disabled until these controls and provider validation pass.
- [ ] **Synthetic-audio disclosure (built 5 November; legal review still needed):** India’s IT Rules have required a “prominently prefixed audio disclosure” on synthetic audio since 20 February 2026. Today the disclosure is a separate, best-effort text message. Add a spoken prefix to the clip itself, treat a missing disclosure as a failed send, and get legal review before any Indian creator uses speaking voice. See [the workflow review](docs/workflow-and-functionality-review-2026-11-04.md).
- [ ] **Previously learned influence:** offer an explicit provenance-aware reset/rebuild after sample exclusion. Forward filtering and stale-result rejection are implemented; exclusion does not retrospectively erase existing rules or style-card influence.

## Owner/account-dependent gates

| Action | Owner | Acceptance evidence |
|---|---|---|
| Production AI is configured as OpenAI `gpt-6-luna` at high effort, with Groq as the fallback. Run the blind 50-draft review on it | Owner and co-founder | 7 Nov: the 258-case classification gate passes with the `2.4.0-course` prompt: 97.7% exact, spam 100%, course enquiry 96.4%, coaching 90.0%, uncertain-to-review 100%. Details in [the provider guide](docs/groq-provider.md). |
| Regenerate 50 real-model drafts and blind-score them independently | Both founders | At least 70% A/B ratings, with recorded scores. |
| Complete Meta Business verification and app review. Also request `instagram_business_manage_comments` (comment leads) and `instagram_business_manage_insights` (results for proof of results), each with Advanced Access, in this submission or a second one | Anshu/account owner | Approved permissions, confirmed callback/origins, real incoming message, approved reply and delivery receipt, disconnect/reconnect. Verify available history and Requests coverage. Until approval, only accounts with a role on the app work. |
| Verify Clerk organizations, invitations and roles | Anshu | Real account flows and correct deployed callback/origin configuration; deployed auth bypass remains unset. |
| Razorpay: test plans (Solo, Studio, Roster) and the webhook `https://api.dealdock.io/webhooks/razorpay`, then the same in live mode after approval. Paddle: apply now (policy pages live; submit `dealdock.io` and `app.dealdock.io`; describe DealDock as a deal inbox with replies you approve, never as automation), then sandbox prices | Anshu | Charge, failure, cancellation and reconciliation checks; agreed pilot billing terms before charging. |
| Configure VAPID and verify installed-device notifications | Anshu | Delivery evidence on intended iOS/Android devices and understood quiet-hour behavior. |
| Validate optional speech provider and rights | Anshu/creator owner | Account-specific consent/rights, processor terms, deletion proof, language listening tests and actual Meta audio/disclosure delivery. No purchase is required by this task. |
| Approve deployment separately | Anshu | Secrets separation, migrations, backup/restore, readiness and monitoring checks for Vercel, Railway, Railway Postgres and Railway Redis (7 November: Railway Postgres replaces Neon). No deployment has been performed here. |
| Inspect automatic Vercel preview failure on PR #2 | Vercel project owner | Open deployment `dpl_9HT6idAgNUQAKjKKX5ZfUzjVyJaw` logs in the `infinitys-projects-ec52fa2b` project scope. The installed CLI's account cannot access those logs; no build cause has been established and no retry/deployment was requested. |
| Create the Google OAuth app for Gmail and set its publishing status to In production (unverified): up to 100 users, who see a warning screen. Avoid Testing mode, where access expires every 7 days. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI on the API | Anshu | A real inbox connects, the first 30-day sync lands, a reply sends as a threaded Gmail reply after approval, and a disconnect stops syncing. |
| Start Google verification for the restricted Gmail scopes now: brand verification, Search Console, a demo video and the annual CASA assessment from an approved lab (about $500–900 a year; 4–8 weeks in total) | Anshu | Verified consent screen; assessment letter on file. |
| Optional near-real-time Gmail: a Pub/Sub topic with Gmail push permission; set GMAIL_PUBSUB_TOPIC and GMAIL_PUBSUB_VERIFICATION_TOKEN | Anshu | New mail appears within a minute; with push off, the 2-minute poll still syncs. |
| Send an invoice PDF as an Instagram file message on a real account (needs PUBLIC_API_URL on https) | Anshu | The brand receives the PDF; a refusal returns the hint and the PDF downloads. |
| Run the deals and invoice integration suites on a real Postgres (row locks and races; the local run used single-session embedded Postgres) | Engineering | Deals, invoices and off-platform suites pass on Postgres with concurrency. |

## Go-live (recorded 7 November)

The full order, DNS values and production settings are in [the go-live checklist](docs/go-live-2026-11-07.md). Meta's App Review can finish later.

| Action | Owner | Acceptance evidence |
|---|---|---|
| Publish the policy pages on dealdock.io, linked from the navigation or footer: Terms (legal company name), Privacy (names OpenAI, Groq, Google, Meta, Razorpay, Paddle, Clerk, Railway and Vercel; data stored in Singapore; Gmail data never trains AI), Refund and cancellation, Shipping or delivery, Contact, Pricing and Features | Anshu | Razorpay live mode, Paddle, Google and Meta all accept the site. |
| Add the DNS records: `app` to Vercel; `api` to Railway (CNAME and TXT); Clerk's `clerk`, `accounts`, `clkmail` and DKIM records; Search Console TXT; DMARC. Keep Zoho's records and exactly one SPF record | Anshu | Every dashboard shows the domain verified. |
| Clerk production: domain `dealdock.io`, allowed subdomain `app.dealdock.io`, Google sign-in with its own OAuth client | Anshu | Sign-in, invite and sign-out work on the real domain. |
| Hosting: Vercel Pro (root `apps/web`, region `sin1`); Railway Pro in Singapore with the API, worker, Postgres (point-in-time restore on) and Redis (AOF on); Doppler syncing `prd_web`, `prd_api` and `prd_worker` | Anshu | `https://api.dealdock.io/ready` answers; the worker runs; a restore test works. |
| Production values in Doppler: origins (`WEB_APP_URL`, `NEXT_PUBLIC_API_URL`, `PUBLIC_API_URL`), callbacks (`IG_OAUTH_REDIRECT_URI`, `GOOGLE_REDIRECT_URI`), AI (`AI_PROVIDER=openai`, `AI_FALLBACK_PROVIDER=groq`, both keys), `TOKEN_ENCRYPTION_KEY`, `MEDIA_SIGNING_KEY`, VAPID keys. Leave `META_COMMENTS_ENABLED`, `META_INSIGHTS_ENABLED` and `META_HUMAN_AGENT_ENABLED` off until Meta approves | Anshu | The API and worker start in production mode with no missing-setting errors. |
| Monitoring and accounts: Sentry projects for web, API and worker; UptimeRobot on the app and `/ready`; two-factor login on the registrar and every vendor; domain auto-renew | Anshu | An uptime alert and a test error arrive. |
| Start Meta Business Verification now (up to 14 business days). Instagram's Advanced Access and WhatsApp both need it | Anshu | Verified business in Meta Business Manager. |
| Legal review of the privacy policy and the spoken AI disclosure | Anshu | Reviewed text published. |

**Engineering before go-live:**

- [ ] **Decision needed:** until Paddle is approved, stop workspaces outside India from subscribing, with a clear message (recommended), or build the Paddle checkout now.
- [ ] Add the Sentry SDK to the web app, API and worker.
- [ ] A nightly database dump stored outside Railway.
- [ ] After the first deploy: a hosted CI run with Postgres and Redis, the real-Postgres concurrency run, a backup-restore drill, an export and deletion drill, and one live Instagram invoice PDF send.
- [x] Production session tokens are bound to the app's origin (Clerk `authorizedParties`), added 7 November.
- [x] Checked 7 November: Gmail push renewal runs daily, CORS allows only the app's origin, and the web app sends session tokens as Bearer tokens.

**Later channels:** WhatsApp (about 3–5 weeks of building, alongside 2–4 weeks of Meta approvals) and TikTok for creators outside India (about 3–4 weeks of building plus TikTok's reviews). Scopes, steps and blockers are in [the go-live checklist](docs/go-live-2026-11-07.md#whatsapp-scopes-steps-effort-and-blockers).

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
