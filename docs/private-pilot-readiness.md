# Private pilot readiness — 30 October 2026

This is the current readiness record. M0–M5 implementation does not establish that their external exit gates passed. The live public site at dealdock.io is separate from proof of the authenticated product. No deployment or push was performed during this remediation.

**31 October follow-up:** the [voice/audio audit](voice-and-audio-audit.md) found that live onboarding records style consent but does not initiate extraction. Manual refresh uses the first connected account, sample selection needs text/empty-content filtering, and consent without a saved card can still produce generic drafts. Finish and test that account-specific onboarding loop before promising automatic personalized writing. Business/offer context also needs per-creator scoping before broader Roster use. Audio detection/playback/transcription and spoken-audio replies are incomplete. These are engineering gaps, not account-configuration gates. No production code was changed in this follow-up.

## Must fix before the first design partner

The remediation replaces the browser-only product path with authenticated API reads and actions. Local demo behavior is explicit and cannot become the production fallback. A fixed-tenant localhost bridge exists solely for development integration tests and refuses production requests.

The API owns Graph credentials, history scans, token refresh, and the human send gate. Workers accept normalized work and refuse Meta/encryption secrets. PostgreSQL outbox records recover webhook-to-queue and message-to-classification handoffs. Send approval creates a durable intent before provider I/O; ambiguous outcomes remain locked and cannot be automatically resent. Exact concurrent approvals and conflicting provider receipts have regression coverage.

Money uses safe integer minor units, with immutable organization currency, stored currency on estimates and ledger entries, organization-local month rollups, idempotent close-outs, and CSV escaping. Review items are excluded from the revenue inbox, human corrections survive retries, voice consent defaults off, and consent withdrawal discards unsent drafts. Privacy deletion includes ledger, send intents, outbox, webhook ownership, orphan identities, and billing receipts.

Late audit fixes also prevent an old tenant's export from downloading after an account switch, preserve paise when editing only a sale note, count each Leak Scan conversation once, and reject voice results collected under withdrawn consent even after consent is granted again. Push opt-in is wired to the live product and remains explicit; changing identity unsubscribes the previous browser endpoint before another workspace can enable push. Headline AI accuracy includes abstentions and every golden example; confident-only precision is reported separately.

Authentication fails closed. Clerk identity and the signed organization claim select the tenant; request headers cannot select arbitrary production tenants. Verified organization administrators can provision a workspace; verified invited identities can activate a seat. Real Clerk sign-in/organization setup still needs account-level acceptance testing.

Before onboarding a partner, the final local gate record below must be green and the founder must complete the live Instagram approval/send/reconnect loop. A mock adapter pass is not evidence of Meta approval or live delivery.

## During a private pilot

- Start with one founder-controlled, INR Solo workspace, then at most three personally onboarded design partners. Keep classification review visible and inspect uncertain sends directly on Instagram before another action.
- Measure actual review clearance, model errors, draft editing, successful approved sends and creator-confirmed close-outs. Estimates are not verified revenue or causal attribution.
- Tune onboarding questions, offer ranges, notifications, and empty states from observed use. Check actual device push, accessibility and offline behavior.
- Voice refresh is manual; weekly automatic refresh and push summaries remain unfinished PRD items. The unavailable weekly-summary toggle is removed and cannot be enabled through the API. Quiet-hour notifications are suppressed, not delivered the next morning. These are engineering follow-ups, not account tasks for the founder.
- Run a backup restore, verify service alerts and provider spend limits, and record incidents. Do not infer these from local builds.

## Post-validation work

Broader self-serve launch, manager/roster onboarding, provider-backed tier changes and cohort price-lock changes need their own verified product scope. RLS, multi-market language expansion, digest email, audio transcription and additional channels remain outside this remediation. Existing scaffolding is not a promise that these are launch-ready.

The earlier Reply desk design was rejected. The current standalone proposal is [DealDock Studio](../design/studio/dealdock-studio.html), with separate fictional creator profiles, visible writing samples and a focused reply workspace. It awaits selection before replacing production visuals. It sends nothing and resets on refresh.

## External or account-dependent gates

| Gate | Required evidence | Owner |
|---|---|---|
| Claude classification | Configure key plus explicit model IDs; run the real M2 evaluation with at least 85% top-level accuracy and no more than a 3-point Hinglish parity gap. The harness also reports separate classes, abstentions and value calibration. | Anshu |
| Draft quality | Regenerate 50 Claude-backed drafts, independently blind-score A/B/C; at least 70% A/B. The checked-in heuristic sample is unscored development material. | Both founders |
| Meta | Business verification, app review/permissions, founder account connect, webhook ingestion, approved reply, receipt, token revoke/reconnect and bounded history recovery. | Anshu/account owner |
| Clerk | Production keys, organization support, allowed URLs and verified administrator/invite flows on real accounts. | Anshu |
| Billing | Razorpay test plans and Paddle sandbox prices; prove authorization/charge/failure/cancellation and reconciliation on the relevant rail before charging its currencies. Both rails are required before a broader global launch. Provider contract tests do not prove these. | Anshu |
| Push | VAPID keys plus opt-in/delivery checks on actual iOS/Android devices. | Anshu |
| Hosting | Approve deployment, provision service credentials, apply migrations, validate readiness, secrets separation, backups and monitoring on the selected hosts. | Anshu |

Do not paste secrets into a commit or this document. Configure them in the relevant service's secret settings. Workers must never receive TOKEN_ENCRYPTION_KEY, META_APP_SECRET, META_APP_ID, META_WEBHOOK_VERIFY_TOKEN or Graph tokens.

## Smallest route to monetization

1. Finish and retain the local verification evidence.
2. Complete Claude and blind draft-quality gates while Meta/account setup proceeds.
3. After deployment approval, run the founder-controlled live loop and privacy/reconnect drill on the deployed product.
4. Onboard the first design partner personally; track their first confirmed sale and reply fidelity rather than acquisition volume.
5. Verify Razorpay test billing for the first INR Solo partner, then obtain creator authorization for the agreed plan. Prove Paddle sandbox before offering non-INR billing. Expand the cohort after the first partner's workflow is reliable.

## Verification record

| Local gate | Verified result |
|---|---|
| Production build | All 8 packages built successfully, including Next.js 16.4.3 |
| Type checks | All 8 workspaces pass; 13 Turbo tasks including package build prerequisites |
| Unit/provider contracts | 134 tests passed across core, AI, messaging, billing, database crypto and browser-store tests |
| Architecture rules | All app/package boundaries pass; 12 guard regression tests pass |
| Worker runtime | 5 startup tests reject API-only credentials before consumers start |
| Production auth | Built Next.js server denies the inbox and local development bridge with missing Clerk keys even when bypass flags are deliberately set |
| Desktop/mobile browser | 8/8 checks pass using the real API/database/Redis and explicit mock messaging; persisted dashboard/ledger amounts and note edits agree, with scoped Axe WCAG 2 A/AA checks on inbox/settings |
| PostgreSQL regressions | 21 real integration tests pass, including consent races, money, tenancy, send receipts, billing events and invalid region preferences |
| Redis budget | Real shared-budget test passes across two budget clients |
| Local pilot flow | Real Fastify/PostgreSQL/Redis, explicit mock messaging: webhook replay, durable reference, human approval, concurrent send, ledger/export/deletion pass |
| Corpus | All 226 fixture messages persisted and classified; this checks ingestion/routing, not classification accuracy |
| 2,000-message storm | Local PostgreSQL/Redis and heuristic classifier: p50 23.5s, p95 33.8s, p99 34.8s against an unchanged 60s budget; real Claude latency remains unverified |
| Deletion drill | Five threads exported; all 17 reported database residue counts zero |
| Migration drift | Four migrations replayed against a separate disposable shadow database: no difference |
| Dependency audit | Zero reported vulnerabilities |
| AI harness | Heuristic routing harness passes; exact-label accuracy is only 38.0% on 258 examples. This does not pass or replace the real-model quality gate |
| HTML proposal | Desktop and phone layouts inspected; approval, review, exact confirmed sale amounts and navigation exercised; no console errors observed |

The first load rerun failed at p95 63.0s. Bounded concurrent publication removed the serial outbox bottleneck; the subsequent full integration gate passed at p95 33.8s. No budget or boundary was relaxed. A first local database used WIN1252 and could not ingest multilingual/emoji fixtures; the successful runs use fresh UTF8 databases, and the integration runner refuses other encodings.

Two subsequent desktop browser runs timed out during development-tool startup/first route loading while mobile checks passed. Traces showed successful API responses arriving after initial code loading. The browser runner now consumes readiness responses and compiles the application routes/assets before starting the unchanged assertions. This is a development-environment functional gate, not proof of production cold-start performance. No test timeout, authorization check, retry policy or load budget was loosened.

The final parallel unit rerun exhausted this Windows machine's available memory and crashed V8 processes. The test command now runs one workspace and one Vitest worker at a time. All 134 unit/provider tests then passed, followed by six runtime-safety tests, 12 boundary regressions, the real local pilot flow and a zero-finding dependency audit. Concurrency was bounded; no test or assertion was removed.

The fast unit command intentionally skips 21 database and one Redis test without integration configuration; those tests were run separately against real services. CI mandates the infrastructure and browser gates rather than accepting those skips. Hosted GitHub CI itself has not run during this local session because no push was authorized. The local PostgreSQL runtime is version 18 and the local Windows Redis runtime is version 8; CI targets PostgreSQL 16 and Redis 7, so the hosted platform/version matrix still needs its first run. GitHub's live main ref was checked again: `0063cb5`; the original local main was `aa34197`, one commit ahead. The remediation is retained in local commits on `codex/private-pilot-readiness`, without pushing.

Warnings: the web auth guard now uses the Next 16 `proxy.ts` convention (migrated from `middleware.ts` on 31 Oct 2026). A transitive SDK emits Node's `punycode` deprecation warning. Neither warning was treated as a failed security gate.

Claude-backed classification, blind draft scoring, real Clerk accounts, Meta delivery/reconnect, billing sandbox lifecycles, VAPID devices, hosted backups/restore and deployed monitoring were not run. They remain open. A live marketing domain does not close these product gates.

The new HTML direction has not replaced the production visual system. The previously generated `design/workspace/` artifacts are preserved locally and are not the current proposal. No marketing files were changed.

Deployment commands, per-service credential ownership and the required hosted acceptance loop are in [deployment preflight](deployment-preflight.md). OAuth now refuses a missing or unsafe callback configuration instead of falling back to the obsolete `.in` address.
