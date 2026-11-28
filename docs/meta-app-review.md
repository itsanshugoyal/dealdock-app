# Meta App Review — Preparation Checklist

**3 November provider update:** if Groq is selected, include the actual Groq processing, data controls and location in the privacy/subprocessor review before submitting claims to Meta or processing real creator data. See [provider setup](groq-provider.md).

> Status (30 October 2026): no external checkboxes were completed by the local remediation. Use dealdock.io as the current public domain and configure the actual API callback origin in META/hosting settings; the API origin must be confirmed rather than inferred from the public domain. The review recording must demonstrate a real incoming message, classification/review, explicit human approval, one delivered reply and its receipt, and disconnect/reconnect. Local mock-provider tests do not satisfy app review.

**Why this exists now:** Meta Tech Provider registration + `instagram_business_manage_messages` approval is the longest lead-time item in the project (weeks). PLAN.md M0 starts this track so M3 (real Instagram) is never blocked. Owner: founding team. Status: ☐ = not started.

> **22 November: Unified Login.** Meta apps created after ~October 2026 only offer "Instagram API with Unified login" (Facebook Login for Business with a configuration, a system-user token that belongs to the creator's business portfolio, graph.facebook.com). DealDock supports it behind `META_UNIFIED_LOGIN_ENABLED` with `META_LOGIN_CONFIG_ID`. Under it:
> - **Permissions** use the `instagram_*` names: `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `instagram_manage_insights` (not `instagram_business_*`). They are chosen in the login configuration, not sent as scopes. Request Advanced Access for the ones the configuration uses; remove `ads_management`, `ads_read` and `instagram_content_publish` from the default configuration.
> - **App ID/secret** are the Meta app's (App settings → Basic); webhooks are configured on the Meta app's Instagram object and signed with that App secret.
> - **HUMAN_AGENT** is requested as the Human Agent feature in App Review.
> - Creators must enable **Allow access to messages** (Instagram → Message controls → Connected tools), or sends fail with `(#200)`.
> - A creator's business portfolio is required; a Facebook Page is not.
> The Instagram Login steps below still apply to apps created before the change.

## 1. Prerequisites

- ☐ Meta Business Manager account (business.facebook.com) verified — legal entity name, address, website (dealdock.io).
- ☐ **Business Verification** completed (required for Advanced Access) — documents: incorporation cert / GST registration, utility bill.
- ☐ Meta developer account for the founding team (developers.facebook.com).
- ☐ Decide app owner entity: the DealDock business, not a personal account.

## 2. App setup

- ☐ Create Meta App → type **Business**.
- ☐ Add products: **Instagram** (Instagram API with Instagram Login / Messaging).
- ☐ Configure Instagram webhooks: callback `<approved API origin>/webhooks/instagram`, verify token from env (`META_WEBHOOK_VERIFY_TOKEN`), subscribe to `messages` field (and `comments` once comment leads are approved: `META_COMMENTS_ENABLED`).
- ☐ App domains, privacy policy URL, data deletion callback URL (Settings → Basic). Privacy policy must explicitly cover DM processing (PRD §7.1 FAQ doubles as source).
- ☐ Callbacks (built 28 Nov, `apps/api/src/routes/meta-callbacks.ts`). Enter both wherever the app asks: under Instagram Login, the Business login settings; under Unified Login, Facebook Login for Business settings and Settings → Basic.
  - **Deauthorize callback URL:** `https://api.dealdock.io/meta/deauthorize`. Disconnects the matching Instagram accounts and drops their tokens at once.
  - **Data deletion request URL:** `https://api.dealdock.io/meta/data-deletion`. Disconnects, then the worker deletes the account's data (usually within seconds; the daily retention tick is the fallback). It answers Meta with `{ url, confirmation_code }`, and the url is a public status page (`/meta/data-deletion/status?code=…`).
  - Both verify Meta's `signed_request` with `META_APP_SECRET` (the Instagram app secret under Instagram Login). An account matches on `IgAccount.metaUserId` (saved at connect: Instagram Login's app-scoped `id`, or the Unified Login token's `/me` id) or on `igUserId`. Accounts connected before 28 Nov match only on `igUserId` until they reconnect. **Confirm with a real removal** which id Meta sends (pending.md, Unified Login questions).
  - The `/data-deletion` page on dealdock.io should say: removing DealDock in Instagram (Settings → Apps and websites) deletes that account's data, and the deletion finishes within 30 days (usually within a day).

## 3. Permissions to request (Advanced Access)

| Permission | Why we need it (review justification) |
|---|---|
| `instagram_business_basic` | Account identity: handle, account type detection (Business/Creator vs Personal — PRD §6.1) |
| `instagram_business_manage_messages` | Read DMs for classification + send creator-approved replies. **Core product.** |
| `instagram_business_manage_comments` | Comment leads (Phase 3): read comments on the creator's own posts that use the creator's keywords ("PRICE"), and send the one private reply Instagram allows per comment (within 7 days), **each written for and approved by a person** in Inbox → Comments. Behind `META_COMMENTS_ENABLED`; needs Advanced Access, Business Verification, a Live app and the `comments` webhook field. |

Justification framing (from the PRD, use verbatim ideas): human-in-the-loop assistant for creators' OWN inboxes; classification + drafts; **never auto-sends**; official API only; per-creator data isolation; creators connect via OAuth and can disconnect anytime.

## 4. Tech Provider status

- ☐ Apply as **Meta Tech Provider** (we process data on behalf of other businesses — the creators).
- ☐ Data-handling questionnaire: encryption at rest/in transit, retention (delete on account deletion + 30-day post-cancel window — PRD §5.7), subprocessors (Anthropic — API data not used for training; Neon; Railway; Vercel).

## 5. Screencast (the thing reviews fail on)

Required: a video showing the full permission usage on a REAL test account.

- ☐ Test IG Business account with realistic DMs (use founding-team account).
- ☐ Script: OAuth connect flow → DM arrives in IG → appears in DealDock inbox → creator opens thread → edits draft → **explicitly taps Approve & Send** → reply visible in IG thread.
- ☐ Show the disconnect flow (Settings → disconnect stops ingestion).
- ☐ Narrate the never-auto-send invariant on camera.
- ☐ English captions; under 3 minutes; no cuts during the permission-relevant steps.

## 6. Reviewer test access

- ☐ Provide a test creator account (email + password) with the demo org pre-connected.
- ☐ Step-by-step reviewer instructions doc (numbered, screenshot per step).
- ☐ Ensure staging is reachable and stable during the review window.

## 7. Compliance guardrails (already architectural, restate in submission)

- Official Graph API only; no scraping/automation (PRD §7.2).
- Human approval before every send — enforced at API layer (ARCHITECTURE.md §6.2).
- 24-hour messaging window respected; out-of-window sends rejected with user-facing messaging.
- Rate limits respected via per-account budgeter (ARCHITECTURE.md §4.2).
- Deauthorize and data deletion callbacks implemented: removal disconnects at once and drops tokens; a deletion request deletes the Instagram account's messages, threads, drafts, deals, ledger, comment leads, audio and related audit rows, with a public status page (§2).
- Comment leads: a keyword comment gets a *drafted* private reply that a person edits and sends, one per comment, within 7 days; nothing is sent automatically, so it is not an "automated chat experience". **Confirm in App Review** that no automation disclosure is needed for human-approved private replies, and that the comments field and private replies work for an Instagram Login (creator-side) app.

## 8. Timeline & fallback

- Submit as soon as the M3 adapter passes staging contract tests — do NOT wait for M3 completion to *prepare* materials.
- Typical review: 5–15 business days; rejections usually cite unclear screencasts — budget one resubmission.
- **Fallback if approval lags:** pilot starts on founders' accounts + allowlisted tester accounts (Standard Access works for app-role users), per PLAN.md M3 exit criteria.
