# Meta App Review — Preparation Checklist

> Status (30 October 2026): no external checkboxes were completed by the local remediation. Use dealdock.io as the current public domain and configure the actual API callback origin in META/hosting settings; the API origin must be confirmed rather than inferred from the public domain. The review recording must demonstrate a real incoming message, classification/review, explicit human approval, one delivered reply and its receipt, and disconnect/reconnect. Local mock-provider tests do not satisfy app review.

**Why this exists now:** Meta Tech Provider registration + `instagram_business_manage_messages` approval is the longest lead-time item in the project (weeks). PLAN.md M0 starts this track so M3 (real Instagram) is never blocked. Owner: founding team. Status: ☐ = not started.

## 1. Prerequisites

- ☐ Meta Business Manager account (business.facebook.com) verified — legal entity name, address, website (dealdock.io).
- ☐ **Business Verification** completed (required for Advanced Access) — documents: incorporation cert / GST registration, utility bill.
- ☐ Meta developer account for the founding team (developers.facebook.com).
- ☐ Decide app owner entity: the DealDock business, not a personal account.

## 2. App setup

- ☐ Create Meta App → type **Business**.
- ☐ Add products: **Instagram** (Instagram API with Instagram Login / Messaging).
- ☐ Configure Instagram webhooks: callback `<approved API origin>/webhooks/instagram`, verify token from env (`META_WEBHOOK_VERIFY_TOKEN`), subscribe to `messages` field.
- ☐ App domains, privacy policy URL, data deletion callback URL (Settings → Basic). Privacy policy must explicitly cover DM processing (PRD §7.1 FAQ doubles as source).

## 3. Permissions to request (Advanced Access)

| Permission | Why we need it (review justification) |
|---|---|
| `instagram_business_basic` | Account identity: handle, account type detection (Business/Creator vs Personal — PRD §6.1) |
| `instagram_business_manage_messages` | Read DMs for classification + send creator-approved replies. **Core product.** |

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
- Data deletion callback implemented (maps to our §6.11 deletion flow).

## 8. Timeline & fallback

- Submit as soon as the M3 adapter passes staging contract tests — do NOT wait for M3 completion to *prepare* materials.
- Typical review: 5–15 business days; rejections usually cite unclear screencasts — budget one resubmission.
- **Fallback if approval lags:** pilot starts on founders' accounts + allowlisted tester accounts (Standard Access works for app-role users), per PLAN.md M3 exit criteria.
