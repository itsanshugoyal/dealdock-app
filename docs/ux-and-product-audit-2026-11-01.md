# Authenticated product audit — 1 November 2026

Scope: the rebuilt product at `00588e2` / `e04e830`, followed by local fixes. The public website and outbound acquisition were excluded. No commit, push, deployment, purchase, or external account creation was performed. Existing `design/workspace/` files were preserved.

The v3 visual direction is worth keeping. The biggest problems were incomplete queues, ambiguous creator context, misleading feedback, and missing agency reporting. More navigation items would not have solved those problems.

## Evidence and limits

- Independent UI/UX and functionality agents used the running application. Coverage included Today, inbox and conversation, Review, Revenue and sale editing/undo, Voice and creator switching, Offers and pausing, Roster, Settings, Activity, and the onboarding connection step. The UI review included a 390 × 844 phone viewport.
- The Product Value agent was restarted but had no browser surface. At the owner's request, the main session handled that review using its earlier dashboard, inbox, conversation, light/dark and phone observations, then consolidated the independent findings. Do not describe the unavailable agent as a completed hands-on audit.
- Automated browser checks exercise the real React application with expressly fictional demo data. Separate integration tests exercise Fastify, PostgreSQL and Redis with mock messaging and version-stamped heuristic AI. Neither proves Meta delivery, Claude quality, speech quality, or billing authorization.
- The demo is now visibly labelled on phones, desktops, and onboarding. It is development-only and sends no external messages.
- Disk exhaustion interrupted two test edits. Both previously clean files were restored byte-for-byte from Git before work resumed. Subsequent tests use the restored files plus the reviewed additions. User cleanup restored sufficient space.

## Changes implemented

| Area | Observed problem | Result |
|---|---|---|
| Today | The biggest deal always won, even when another reply window was about to close. | Recommend the earliest actionable closing window, then value. Show the reason. Exclude claimed sends, expired/unknown windows, and accounts without a verified active connection. Nothing is approved automatically. |
| Connection recovery | A disconnected creator could reach a composer that would fail later. | Show a reconnect action on Today and in the affected conversation. Keep the conversation available; block its composer until connection is restored. |
| Money claims | Estimates, edit statistics and a partial-month comparison could imply more certainty than the data supports. | Label estimated value; remove the current-month-versus-complete-previous-month percentage; describe voice statistics as sent-draft edit rates rather than a score for this particular reply. |
| Cross-screen totals | Today did not name the agency scope, and the demo roster added amounts that had no recorded sales. The onboarding list showed upper estimates beside a conservative low-end total. | Name the all-creator scope on Today; derive demo roster figures from the same sales as Today and Revenue; explicitly label onboarding opportunity amounts as upper estimates. |
| Inbox completeness | The API paginated, while the store discarded cursors. Search, counts and creator filters silently covered only the first page. | Follow stable cursors for open, waiting, closed and review lists. Publish complete scans, deduplicate, reject cursor cycles, preserve the previous complete result on failure, and fence account changes. |
| Queue navigation | Opening a conversation lost the originating creator, view and search. Invalid `view` values could crash filtering. | Preserve these URL parameters in conversation and back links; normalize invalid views. |
| Agency identity | Shared queues did not consistently name the creator. Keeping a learned phrase could use a different Voice Studio account. | Label creators in shared rows and show “Replying as” in the thread. Send the conversation's explicit account ID when saving a rule, and update only the matching cached profile. |
| Composer | Seven steering controls competed with the reply; alternatives could overwrite edits. | Keep Shorter and Add my rate prominent. Put other controls in More reply options, guard replacements, show Edited by you, and hide the unusable Send action before a draft exists. |
| Send outcomes | Identical retries could get 404 after a claim; lost responses could return the user to an apparently unsent draft. | Match durable intents before live-draft checks. Preserve approval identity and payload conflicts. Treat unconfirmed transport outcomes conservatively, retain the key and local lock, and never retry automatically. |
| Send feedback | Provider hints, including failed audio disclosure, were not rendered; unknown outcomes used the success treatment. | Display returned hints, use an uncertainty treatment, offer native Instagram inspection, and suppress learning/Move to waiting until delivery is confirmed. |
| Review | Skip appeared not to advance progress and could cycle forever. Failed writes could leave a card hidden. | Show sorted and remaining counts. Skipped cards stay undecided and finish with Left for later; Review skipped restores them. Advance focus, announce progress, retain Undo, and restore failed decisions. |
| Agency reporting | Revenue and CSV exports could only cover the workspace. | Add creator and month URL filters, scoped totals/history and CSV exports, and a Revenue report link on each roster card. Do not compare a creator's sales against the workspace goal. Validate account ownership within the organization before aggregation. |
| Scope transitions | A new creator label could briefly appear over the previous creator's data, including after failure or A → B → A navigation. | Hide the previous scope immediately, clear changed-scope data, invalidate obsolete pending requests, and retain data only for refreshes of the same scope. |
| Revenue recovery | A failed deletion could leave a sale hidden, and the instruction said tapping a sale would edit it while names opened conversations. | Restore failed deletions and explain the error. Point users to the pencil for editing. |
| Roster counts | A new inbound after an earlier reply was not counted. | Count ongoing unreplied commerce conversations using the inbox's semantics; exclude pending review. |
| Offers | New agency offers defaulted to every creator; opening before accounts loaded could bypass scope selection. | Require an explicit creator or shared scope, wait for account readiness, infer the sole connected account only when known, and distinguish an unknown creator from a genuinely shared offer. |
| Mobile | Important filters had 32–36px hit boxes, row metadata clipped deadlines/follow-ups, and Settings required long scrolling. | Provide 44px phone filter targets, wrap creator/status metadata at 320px and 390px, and add a compact settings section jump control. |
| Voice controls | Advanced style controls were always expanded. | Keep learning, source samples and rules discoverable; collapse manual style fine-tuning. |
| Learning privacy | Excluded native samples and sent edits could still influence later distillation. | Filter exclusions from native samples, edit batches and retrieved lessons. Check exclusions under the profile lock, increment the profile version and reject stale learning writes. |
| In-flight drafting | Exclusion or revoke/regrant during model generation could recreate a stale draft. | Capture and require the voice version in API and worker generation; compare under the existing consent lock before discarding or creating drafts. A stale or missing version cannot replace a fresh draft. |
| Onboarding | Voice consent advanced in `finally`, even when saving failed, and scan copy promised every conversation. | Advance only after saving succeeds, disable unresolved/busy consent controls, show errors, explain consent-off behavior, and describe bounded available history. Remove the promise that a draft is always ready. |
| Test infrastructure | The pilot removed an organization from its cleanup list before removing its queued jobs. | Track every fixture owner separately, clean only owned jobs, and verify zero remaining. Keep worker tenancy rejection intact. |

## Microinteractions that serve a purpose

These are state transitions rather than decorative loops: immediate creator-safe loading, field-level scope validation, Edited by you, explicit confirmation before replacing edits, expandable reply controls, review focus/progress/Undo, restoration after failed writes, reconnection guidance, and distinct confirmed-versus-unconfirmed delivery states. Existing reduced-motion support remains in place.

## What stays simple

- Today answers what deserves attention next. Inbox handles work; Revenue records confirmed outcomes. Voice, Offers and account administration remain supporting surfaces.
- Keep settings such as manual style axes behind disclosure. Keep permission, connection, scope, amount and approval information visible at the decision point.
- Do not add kanban, generic contact CRM, ticket SLAs, team chat, public rate-card builders, scheduled sends, bulk outbound, or decorative analytics to make the product look larger.
- Useful automation prepares and prioritizes: classification, drafts, reminders, learning candidates and reconciliation. Every outgoing message still requires an authorized human action through the API send gate.

## Remaining work by launch relevance

### Must fix before the affected feature reaches a design partner

1. **Multi-creator business facts.** Business summary and onboarding price ranges are still organization-wide. Account-scoped offers and voices do not make that shared summary creator-specific. Add per-account business context and verify prompts with two genuinely different creators before promising independent agency knowledge.
2. **Account-specific consent ownership.** An organization role is not proof of which person owns a particular creator's writing or speaking voice. Define and enforce the creator-to-account consent relationship before multi-creator voice enrollment.
3. **Spoken-voice deletion and approval.** Replacement can lose the vendor identifier if deletion fails. Persist deletion work durably; bind approval to the exact previewed clip/text/voice revision, and prevent duplicate synthesis before enabling customer audio sends. Keep this beta disabled until those controls and live provider checks are complete.
4. **Prior influence after exclusion.** Forward filtering and stale-result rejection are fixed. They do not erase influence already distilled into a style card or rule. Provide a deliberate rebuild/reset with reliable provenance; do not label exclusion as retrospective erasure.

These limitations are not a reason to put fake controls into the UI. Keep the affected agency/audio promises gated. Full voice-consent withdrawal remains a separate operation from excluding one sample.

### Can improve during a private pilot

- Replace complete-list cursor following with server-filtered incremental lists plus exact scoped aggregates as real inbox sizes grow. Current correctness is improved, but latency and memory costs of loading all pages are not measured at production scale.
- Test time to first useful draft and first confirmed sale with creators on real phones and ordinary networks. Observe whether users understand estimated value, closed windows, source samples and shared offers without explanation.
- Validate notification delivery and quiet-hour expectations. Quiet hours currently suppress rather than defer; there is no weekly digest scheduler.
- Evaluate native-author ambiguity in historical Instagram messages, writing-style refresh quality and creator acceptance of learned rules. A native outbound message is not proof of the individual who typed it.
- Improve audio-only review navigation/transcript fallbacks and verify inaccessible/expired media recovery with the real provider before treating incoming audio as complete.

### Post-validation

Expand channels, semantic search, deeper agency analytics, and database RLS only when demand and data justify them. Add reporting based on observed facts, not predictive recovery or unmeasured “AI accuracy.” Preserve the narrow recovery loop.

### External or account-dependent — owner actions

| Gate | Evidence needed | Owner |
|---|---|---|
| Claude quality | Real configured models: ≥85% top-level classification and ≤3 percentage-point Hinglish parity gap. | Anshu |
| Draft quality | Generate 50 real-model drafts and independently blind-score ≥70% A/B. | Both founders |
| Meta | Business verification/app review; actual history/Requests coverage; connection, incoming DM, human-approved reply/receipt and reconnect drill. Validate extended-window and audio behavior separately. | Anshu/account owner |
| Clerk | Real organization/invite/role flows and deployed callback/origin configuration. | Anshu |
| Billing | Razorpay test plans, Paddle sandbox prices, charge/failure/cancel/reconciliation evidence and the agreed first-week billing terms. | Anshu |
| Push | VAPID configuration and installed iOS/Android delivery evidence. | Anshu |
| Spoken voice | Provider access/rights, processor terms, deletion evidence, listening tests in the relevant languages, and Meta rendering/delivery proof. No paid plan was purchased here. | Anshu/creator owner |
| Deployment | Separate approval, secrets isolation, migrations, backups/restore, readiness and monitoring. Leave deployed auth bypass unset. | Anshu |

## Verification record

- UI gate: 25 passed, one intentional desktop skip for the phone-only touch-target test. Separate full demo onboarding: 2/2 desktop/Pixel 7. Inbox/thread axe checks assert all WCAG 2 A/AA violations, without filtering by impact.
- Real infrastructure gate before the final voice-version fence: 51 PostgreSQL tests, one Redis test, mock-provider API pilot, 226 corpus messages, deletion zero residue. Isolated 2,000-message p95: 28.5s against the unchanged 60s budget.
- A shared-resource run failed at p95 64.7s. It remains recorded; the isolated pass is not evidence for the production latency budget. A prior 33.0s local pass also preceded these final changes.
- The final voice-version fence passed 48 focused PostgreSQL tests (overlapping the earlier suites), an additional missing-version regression, the API/worker build, and the rebuilt mock-provider API pilot. Do not add these overlapping totals or attribute the load result to a later unmeasured revision.
- Final production build, complete fast suites, runtime safety and API-backed browser checks are recorded in the completion addendum below when finished.
- Local PostgreSQL is 18.4; CI uses 16. Hosted CI has not run because nothing was pushed. Real Claude, Meta, speech and billing gates remain unrun.

## Smallest practical pilot path

Finish the current local gates, configure and pass real Claude/draft-quality checks, and prove the founder-controlled Meta loop. After deployment approval, begin with a personally onboarded text-first creator and confirmed sales. Add an assistant with audited permissions, then agency voice and optional audio only after their specific isolation/consent/provider gates pass. Use the existing monthly offer and billing rails; additional screens are not a substitute for a reliable first reply and first recorded sale.

## Completion addendum — final local working tree

| Check | Result |
|---|---|
| Production build | All 9 workspaces passed. |
| Fast suites | 663 passed, including the 7 worker learning regressions now reached by `npm test`. Turbo reused valid unchanged task results. The 53 database tests and one Redis-dependent test are intentionally skipped by the fast command; they have separate infrastructure evidence. |
| Types and boundaries | All workspace type checks passed; architecture lint and all 16 boundary-rule regressions passed. |
| Runtime safety | 6/6 passed: production web fails closed despite local bypass flags, and the worker refuses each API-only credential. |
| PostgreSQL | Final current set: 53/53 across all 7 integration files, zero skipped, including creator-scoped ledger and the voice-version fence. |
| API-backed browser | 8/8 passed on desktop and Pixel 7: real local API, PostgreSQL and Redis with mock messaging. The 28 demo cases were intentionally skipped in this mode and run separately below. |
| Demo UI browser | Default owned-server gate passed 27 cases with one intentional desktop skip for the phone-only test. Includes complete onboarding, creator/month CSV, review/Undo, scope navigation, accessibility and 320/390px metadata bounds. |
| Dependencies and retained artifacts | `npm audit --audit-level=high`: zero vulnerabilities. Existing standalone design-artifact checks passed; that artifact remains an old concept, not the product. |
| Fixture hygiene | Zero organizations remain in the isolated database. Scoped cleanup removed the identified earlier orphan and test backfill jobs/scheduler from dedicated Redis DB 9. No database flush; the user's Redis 6379 was untouched. |

The earlier concurrent fast run timed out in the CSV route test while browser development compilation was running. The sequential full run passed with the original 5-second timeout and unchanged assertions. An intermediate build caught a UI reference to a lower estimate absent from the scan response; the final implementation labels the supplied upper estimate explicitly and the rebuilt product passed. Neither failure is omitted from the verification record.

Actual application screenshots are saved under `.turbo/ui-audit-{desktop,mobile}-{home,roster,ledger,onboarding}.png`. The final ledger captures assert the selected creator before capturing the selected month; the earlier screenshot race was corrected. These are development screenshots, including Next's development indicator, not production screenshots.

CI now includes the demo UI gate and the worker test script, but hosted CI has not run. The local demo at `http://127.0.0.1:3100` uses fictional data and no external sending. All source changes remain uncommitted; no push or deployment was performed. Account-dependent and feature-specific blockers above remain open.

Preview note: another session started the working-tree Next dev server on port 3000 during the usage-limit pause. It was left untouched. To avoid its development lock, port 3100 serves an isolated copy of the final `apps/web` source in `C:\Users\anshu\.cache\dealdock-test-runtime\ui-preview-20261101`, with no copied environment files and explicit demo settings. It is a review snapshot; subsequent working-tree edits will not automatically appear there. The product's Next configuration and deployment scripts were not changed for this temporary preview.
