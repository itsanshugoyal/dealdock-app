# 05a — Current web frontend inventory (pre-redesign)

Date: 2026-10-31. Branch: `codex/private-pilot-readiness`. Read-only audit; nothing outside this file was changed.

Scope read in full: `apps/web/src/**` (9 routes, 12 components, 3 lib files, middleware), `apps/web/public/**` (sw.js, manifest, offline.html, icons), `apps/web/test/api-store.test.ts`, `tests/e2e/global-setup.ts`, `tests/e2e/live-product.spec.ts`, `playwright.config.ts`, `scripts/run-browser-gate.mjs`, `apps/web/AGENTS.md`, `apps/web/next.config.ts`, `apps/web/package.json`. Cross-checked against `apps/api/src/routes/*.ts`, `packages/db/src/repos/{inbox,threads,metrics}.ts`, `DESIGN.md` §3–§7.5, the Next.js 16.4.3 docs in `node_modules/next/dist/docs`, and the prototypes `design/studio/index.html` and `design/workspace/index.html`.

Installed versions: next 16.4.3, react 19.3.1, @clerk/nextjs 6.39.8, tailwindcss 4.3.3, vitest 4.

---

## 0. Architecture in one paragraph

Every page is a `"use client"` component. There is no RSC data fetching. All data flows browser → Fastify API, with a Clerk bearer token (`NEXT_PUBLIC_API_URL`) or, in local integration mode only, through the same-origin `/api/dev/*` bridge. One hook, `useDemoData()` (`lib/use-demo.ts`), returns a snapshot from either `demoStore` (an in-browser fixture corpus run through the real `HeuristicPipeline`, persisted to sessionStorage) or `apiStore` (an in-memory API client). Which store you get is fixed at build time by `IS_DEMO_MODE = NODE_ENV !== "production" && NEXT_PUBLIC_DEALDOCK_DEMO_MODE === "true"`. Actions go through `appStore`, a bridge that picks the demo or API implementation. **Four routes (`/thread/[id]`, `/ledger`, `/settings`, `/onboarding`) return early with a separate "Live*" component when not in demo mode.** Production therefore renders a different, much plainer UI from the polished demo UI. This is the biggest structural fact a redesign must deal with.

```
layout.tsx
 ├─ LocalAuthSession (dev + DEALDOCK_DISABLE_AUTH + DEV_ORG_ID + API_URL) → apiStore.setLocalDevelopment(true)
 ├─ else ClerkProvider + AuthSession (if NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) → apiStore.authenticate(`${userId}:${orgId}`, getToken)
 │      └─ signed in with no org → full-screen <OrganizationList hidePersonal → /onboarding>
 └─ else bare (keyless dev/CI prerender)
     ServiceWorkerRegistrar + Shell(children)
```

---

## 1. Route-by-route inventory

Legend: **D** = demo-mode branch, **L** = live (production) branch. "Store" means the `appStore`/`apiStore` method, and "API" means the HTTP call it makes.

### 1.1 `/` Dashboard (`app/page.tsx`, shared D/L)

| Element | Detail |
|---|---|
| Label | "Revenue Recovered · this month" (a `<p>`; **the page has no `<h1>`**) |
| Hero tile | "Double-bezel" card; `MoneyValue exact className="text-4xl …"` showing the MTD total. **The e2e test selects this as `main .money.text-4xl`.** |
| Sub-stats | Biggest deal · Avg size · Deals (count) |
| Data, D | Computed from `ledger` entries with `closedAt >= first of month`, browser-local timezone |
| Data, L | `snapshot.dashboard` from `GET /dashboard` (`mtdRecoveredMinor`, `biggestMinor`, `avgMinor`, `mtdDealCount`; validated as safe non-negative ints, otherwise the whole snapshot errors) |
| "Needs you" | Top 3 threads where `state==="open" && routedTo==="inbox" && unreplied && estValueMaxMinor`, sorted by max value. Each row is a link to `/thread/{id}` with a Badge, `@handle` and a value range. The "Open inbox →" link goes to `/inbox`. |
| Empty | "Inbox clear. Every high-value thread has a reply." |
| Review nudge | If unreviewed review-queue items exist: an amber link to `/review`, "{n} messages need your judgement · Review →" |
| Loading/error | **None on the page.** While loading, L shows ₹0 and the "Inbox clear" empty state (a false empty). Errors appear only as the Shell banner. |
| Missing vs DESIGN §4.2 | Count-up, delta vs last month, "pending high-value count" tile, and collapsing into an inbox strip on mobile |

### 1.2 `/inbox` Revenue Inbox (`app/inbox/page.tsx`, shared D/L)

- `<h1>Revenue Inbox</h1>` plus a hard-coded "sorted by ₹ value" caption, which is wrong for non-INR orgs.
- Filter chips (`<button>`s, with no `aria-pressed`): All · Brand · Coaching · Course · Waiting · Unreplied. Filter state is local and not persisted. There is no "Commerce" (`other_commerce`) chip and no sort menu.
- List: threads with `routedTo==="inbox"`. "All" excludes closed threads. "Waiting" means `state==="waiting"`. "Unreplied" means `unreplied && state==="open"`. Label chips exclude closed threads. Sort is `estValueMaxMinor` desc, then `lastMessageAt` desc.
- Row = `<Link href="/thread/{id}">` (**the e2e test depends on `a[href^="/thread/"]`**). It shows `@handle`, a relative age (m/h/d), a waiting chip ("waiting {age}") or, when a nudge is due, a "Follow up?" pill, a value range (gold), a Badge, "● draft ready" when `t.draft` exists, a one-line preview (`messages[0].text`), and a 2px gold left edge when unreplied and open.
- Empty: "Nothing here" plus "Inbox clear — money recovered, nothing waiting." or "No threads match this filter." with a "Clear filter" button.
- **Live divergences.** The API `InboxRow` (`packages/db/src/repos/inbox.ts`) has no `waitingSince`, `nudgeDismissedAt`, `draft` or `estValueMinMinor`. In L, the waiting chip renders "waiting " with no age, "Follow up?" never appears, "● draft ready" never appears, and values show as a single number. L loads `GET /inbox` (open, limit 50, no pagination) plus `GET /inbox?state=waiting`. Closed threads are never loaded in L.
- There is no loading skeleton (L shows the "Nothing here" empty state while loading) and no search.

### 1.3 `/thread/[id]`, thread view

The page receives `params: Promise<{id}>` and unwraps it with `use(params)`. **In L it immediately returns `<LiveThread id={id} />`**, so every hook after that line runs only in D.

**D branch (`app/thread/[id]/page.tsx`)**
- Header: a back link (`aria-label="Back to inbox"`, "←"), `@handle` (a `<p>`, not a heading), a Badge-as-button that toggles the "Why" rationale panel (`aria-expanded`), and a value range.
- State toggle: "Move to waiting" ↔ "Waiting ✓" calls `appStore.setState(id, waiting|open)`, which is `PATCH /threads/:id` in L.
- "Mark closed ₹" opens `CloseDealModal`.
- Rationale panel: "Why {label}: {rationale} · {pct}% confident".
- Message bubbles: inbound on the left, outbound on the right (gold tint). These are not a list and carry no timestamps.
- After send: "Sent ✓ · Move to waiting?" inline link, which calls `setState(waiting)`.
- Nudge banner, when `isNudgeDue && draft.kind==="nudge"`: "@x has been quiet for N days — follow-up drafted below." Its "Dismiss" button calls `appStore.dismissNudge` (`POST /threads/:id/nudge/dismiss`) and its "Close thread" button calls `setState(closed)`. A close without an amount does not create a ledger entry.
- Composer (hidden when closed): "✦ Draft — in your voice" / "✦ Follow-up — in your voice", "↻ Regenerate" (`appStore.regenerateDraft`), a textarea `aria-label="Reply draft"` with the placeholder "Drafting…", the line "Nothing sends without you.", and an "Approve & Send" button (disabled when empty) that calls `appStore.send(id, text)`.
- Auto-draft: an effect calls `appStore.ensureDraft` when the thread has no draft. Demo drafts only for `HIGH_INTENT_LABELS`.
- Closed: "Deal closed ✓ · View in Ledger".
- `CloseDealModal`: `role="dialog" aria-modal aria-label="Mark deal closed"`, a numeric amount input (whole rupees only; `₹` and `en-IN` formatting are hard-coded), deal-type chips Brand/Coaching/Course/Other, inline error `role="alert"` linked with `aria-describedby`, and "Cancel" / "Log the deal" buttons. Focus moves to the input and Escape closes, but there is **no focus trap and no focus return**. It calls `appStore.closeDeal(id, amountMinor, type)`.
- `PushPrompt threadValueMinor={estValueMaxMinor}` (see §3).
- Dead code: the `!IS_DEMO_MODE` `apiStore.getThread` effect in this branch never runs.

**L branch (`components/live-thread.tsx`)**
- Load: `GET /threads/:id` when `state==="ready"`, and it clears when the state is idle or error. The loading screen is `<main>` with a "Back to inbox" link and `role=status` "Loading conversation…" (or `role=alert` with the error).
- Header: a "Back to inbox" link, **`<h1>@{participantHandle}</h1>`** (the e2e test requires a single h1 containing "@"), and the raw state text ("open"/"waiting"/"closed").
- Buttons: "Move to waiting" / "Reopen" (`PATCH /threads/:id {state}`). This button **is still enabled on closed threads**, so a closed thread can be PATCHed to waiting. "Record a sale" (disabled when closed) generates `closeKey = crypto.randomUUID()` and calls `dialog.showModal()`.
- Feedback: an error `<p role="alert">` and a notice `<p role="status">`.
- History: **`<ol aria-label="Conversation history">`**, one `<li>` per message labelled "Your reply"/"Their message" with `toLocaleString()` (browser locale, not org locale/timezone). `whitespace-pre-wrap`.
- `sendInFlight` replaces the composer with `role=status`: "This reply has already been approved. Its delivery is being confirmed. DealDock will not send it again automatically. Check Instagram before taking another action."
- Composer section `<h2>Your reply</h2>`:
  - The "Generate draft" / "Regenerate draft" button confirms with `window.confirm("Replace your edited reply with a new draft?")` when the user has edited the text, then calls `POST /threads/:id/draft` and reloads.
  - Textarea `id="live-reply"` has **`<label>Review and edit before sending</label>`**, maxLength 4000, and is disabled until a draft exists. Placeholder: "Generate a draft to begin. Voice consent is required."
  - "Approve & send" (shows "Working…" while busy) is disabled when busy, the text is empty, or there is no `currentDraft`. It calls `POST /threads/:id/send {draftId, finalText, idempotencyKey}`. The idempotency key is **reused for the same draftId** across retries and regenerated only when the draftId changes. On success the notice reads "Reply sent. Delivery receipt recorded." (`sent`) or "Approval recorded. Delivery is not yet confirmed; no automatic retry will be made."
  - After a send, `load()` runs. `currentDraft` becomes null, which **disables** "Approve & send"; the e2e test asserts this.
  - Generic failure copy: "The action failed. Your reply was not queued for retry."
- Sale dialog: native `<dialog aria-labelledby="sale-title">` with **`<h2 id=sale-title>Record a confirmed sale</h2>`** and the line "This records revenue. It does not collect payment." It contains **`<label for=sale-amount>Amount · {currency}</label>`** (`type=number`, min 0.01, step 0.01, autoFocus, parsed with `parseMoneyInput`), **`<label for=sale-type>Offer type</label>`** (a `<select>` with options brand/coaching/course/other; default "coaching"), "Cancel", and "Confirm sale" ("Recording…" while busy). It calls `POST /threads/:id/close` with header `Idempotency-Key: closeKey` and body `{amountMinor, dealType}`. On success the notice reads **"Sale recorded: {formatMoneyExact}."**
- `PushPrompt` is also rendered here.
- **Fields the API returns but L ignores:** `topLabel`, per-message `classification` (label, confidence, rationale, value range), `estValueMaxMinor` (except for the push prompt), `waitingSince`, `currentDraft.kind` (nudge vs reply), `closedDeals`, and `contentType` (audio/voice notes). **L therefore has no badge, no value, no "why", no nudge banner, no nudge dismiss, no "Move to waiting?" after send, no closed-deal summary, and no voice-note treatment.**

### 1.4 `/review` Review Queue (`app/review/page.tsx`, shared D/L)

- `<h1>Review Queue</h1>`, "{n} waiting", and the copy "Your corrections train your classifier. Nothing here is ever auto-replied to."
- Queue: `routedTo==="review_queue" && !reviewed`, oldest first. L data comes from `GET /review-queue` rows mapped through `toThread(row,"review_queue")`; `classificationId` becomes `messages[0].classification.id`.
- Card: `@handle`, a best-guess Badge, a confidence meter (`role="meter"`, `aria-valuenow/min/max`, `aria-label="Confidence N percent"`) with the percentage, the full message text, and "Why: {rationale}".
- Actions: "Confirm {Label}" calls `appStore.review(classificationId ?? threadId, "confirmed")`. "Change…" opens chips for the 7 non-uncertain labels plus "Cancel", and a chip calls `review(id,"overridden",label)`. In L that is `POST /classifications/:id/review {outcome, overrideLabel}`.
- Empty: "Queue clear ✓ / New uncertain messages will land here for your judgement." **This also shows while L is loading.**
- Errors are swallowed: `void appStore.review(...)` has no catch. `apiStore.mutate` stores `snapshot.error` but leaves `state` at "ready", and the Shell banner only renders when `state==="error"`, so **a failed review is invisible** (and causes an unhandled rejection).
- Missing vs DESIGN §4.5: keyboard shortcuts (Y/N/1–8), swipe, and sender context.

### 1.5 `/ledger` Revenue Ledger

**D (`app/ledger/page.tsx`)**: `<h1>Revenue Ledger</h1>` and "Export CSV", which builds a client-side CSV with the header `date,handle,deal_type,amount_inr` (INR hard-coded). Three tiles (This month, Biggest deal, Avg size), a six-month bar chart (current month gold), and an "All deals" list (date, deal-type pill in raw lowercase, `@handle`, amount, and an "Edit" button with `aria-label="Edit deal for {handle}"`). `LedgerEdit` is a `div role=dialog aria-modal aria-label="Edit ledger entry"` with no focus management and no Escape. It has Amount/Note fields, Cancel, Save, and Delete (which uses `confirm()`). In demo mode, `updateLedger`/`deleteLedger` are no-ops (`Promise.resolve()`), so **demo edits do nothing**. Empty: 'Close your first deal from a thread — one tap on "Mark closed ₹".'

**L (`components/live-ledger.tsx`)**: `<h1>Revenue Ledger</h1>`, an "Export CSV" button (`apiStore.download("/ledger/export.csv")`), and the copy "Confirmed sales reported by you. Opportunity estimates are excluded."
- Data: `GET /ledger[?month=YYYY-MM]` returns `{selectedMonth, timezone, totalMinor, biggestMinor, avgMinor, months[{month,totalMinor,count}], entries[]}`. Months are computed by the server in the org timezone.
- Month `<select aria-label="Ledger month">` labelled "Month · {timezone}".
- Stats: Confirmed revenue · Biggest sale · Average sale (exact).
- `<h2>Sales · {month}</h2>`: each entry has a **link `@{handle}` → `/thread/{threadId}`** (the e2e test does `getByText('@e2e.<project>', {exact:true})`), a date in org locale and timezone, the raw deal type, an optional note, an exact amount, and an **"Edit" button with `aria-label="Edit deal for {handle}"`** (no "@").
- `<details><summary>Monthly totals</summary>`: a list of month buttons ("{month} · {count} sales"). No chart in L.
- Editor: native `<dialog aria-label="Edit ledger entry">` with `<h2>Edit confirmed sale</h2>`, **label "Amount"** (`moneyInputValue`, so 1200.50 shows as "1200.50"), **label "Note"** (max 500), and buttons "Delete" (`window.confirm("Remove this confirmed sale from the revenue record?")`, `DELETE /ledger/:id`), "Cancel", and **"Save"** ("Saving…" while busy) → `PATCH /ledger/:id {amountMinor, note}`. Saving refetches the ledger.
- Empty: "No confirmed sales this month. Record one from a conversation when the buyer confirms." Loading: `role=status` "Loading revenue record…". Errors: `role=alert`.
- Missing vs DESIGN §4.6: by-type breakdown, trend chart in L, soft delete with an undo toast, a read-only post-cancellation mode, and changing the deal type (the API accepts `dealType`, but the UI doesn't offer it).

### 1.6 `/settings`

**D (`app/settings/page.tsx`)**: Region (currency chips INR/USD/GBP/EUR/AED that **change the currency live**, which contradicts L's "currency is permanent"), notification `role="switch"` toggles (high-value / follow-up / weekly), a voice-matched drafting switch (`setVoice` is a no-op in demo), an ignore list using chips and a form (`aria-label="Add handle to ignore list"`, `aria-label="Remove {h}"`) seeded with hard-coded handles, Data & privacy ("Export everything (JSON)" built client-side; "Delete account" → inline confirm "Schedule deletion"/"Keep my account"), and Billing (hard-coded "Solo · ₹4,000/month", "Razorpay · UPI Autopay"/"Paddle · card", and a zero-guilt cancel with inline confirmation "Confirm cancellation"/"Never mind"). The page `<h1>` is "Settings", with `<h2>` section titles.

**L (`components/live-settings.tsx`)**: loads `GET /settings`, `GET /notifications/prefs`, `GET /billing` and `GET /settings/ignore-list` in parallel. **`<h1>Settings</h1>`.** Sections (each an `<h2>`):
1. **Region**: "{currency} · {locale} · {timezone}", "Currency is fixed for this workspace…", a free-text timezone `<input id=settings-timezone>` with no validation or picker, and "Save time zone" → `PUT /settings/region {timezone}`.
2. **Instagram & voice consent**: per account, "@handle · status" and a checkbox "Allow sent-reply sampling for voice matching" → `PUT /settings/voice/consent {igAccountId, consented}`, with the copy "Withdrawing consent disables drafting and removes the stored style sample." Buttons: "Connect / reconnect" (`POST /ig/connect`, then `location.assign(authorizeUrl)`), "Refresh writing style" (`POST /settings/voice/resample`), and "Disconnect" (`window.confirm`, then `POST /ig/disconnect`).
3. **Notifications**: "Quiet hours: 11pm–8am…" plus one of **"Push notifications are not configured or supported on this device."** (exact e2e text), "No device is subscribed.", or "This seat has a registered device." When `canEnablePush`, a button reads "Enable notifications on this device" or "Enable or reconnect this device" and runs `enablePush`. Checkboxes "High-value enquiries" and "Follow-up reminders" call `PUT /notifications/prefs` and are **disabled unless `prefs.subscribed`**. "Weekly summaries are not available yet."
4. **Ignore list** (a `<form>`): a comma-separated `<textarea id=ignore-settings>` and "Save ignore list" → `PUT /settings/ignore-list {handles}`.
5. **Billing**: "{status} · {rail} · period ends …", an optional "Open secure payment authorization" link (`checkoutUrl`, new tab), and "Cancel subscription" (`window.confirm`, then `POST /billing/cancel`), disabled when there is no rail or the status is cancelled.
6. **`<h2>Your data</h2>`** (e2e): "Export everything (JSON)" (`POST /settings/export` as a download), "Export revenue (CSV)", and deletion. When not yet scheduled, "Schedule account deletion" (`window.confirm`, then `DELETE /account`). When scheduled, "Deletion requested …" and "Cancel deletion" (`POST /account/cancel-deletion`).
- Every action goes through `run()`: a busy lock, then reload all four resources, then the `role=status` notice. Errors use `role=alert`.
- **API capabilities with no UI**: `nudgeDelayDays` (1–14) and `locale` on `/settings/region`, `PUT /settings/voice {enabled}` (the global drafting toggle), `GET /settings/data` (the honest "what we store" counts), `DELETE /notifications/subscribe` (turning a device off), `GET/POST /seats`, `/seats/invite`, `/seats/activate`, `GET /roster`, `GET /me` (role), `GET /metrics/weekly`, and plan/tier display and upgrade.

### 1.7 `/onboarding`

The Shell renders this route full-screen with no tabs or rail.

**D (`app/onboarding/page.tsx`)**: a six-step wizard, `welcome → connect → region → business → voice → scan`, with progress dots on a `div aria-label="Step i of 6"` that has no role.
- Welcome: "Welcome to the pilot." and "Let's go".
- Connect: "◫ Continue with Instagram" fakes a connection after 900 ms. The live path (`connectInstagram`, then redirect) is dead code here.
- Region: currency cards with flag emoji, a live preview "your deals will look like ₹3.2L", and `setRegion`.
- Business: "What do you sell?" multi-select chips plus a typical deal size range in ₹. **These are never sent anywhere.**
- Voice: a `role=switch` toggle, "Consent & continue" / "Continue without drafts", `setVoice` and `resampleVoice`.
- Leak Scan: a scripted 1.8 s progress bar, then a reveal ("At least {total} in commerce DMs went unanswered", "{n} real opportunities out of {m} messages", top 3 threads), then the CTA "Recover your biggest one →" (`/thread/{biggest}`) or "Stop the next leak →".
- `ProductionLeakScan`, nested inside the demo branch, is **unreachable**. It would also never finish: the `GET /onboarding/leak-scan` summary returns `{scannedCount, commerceCount, totalMinMinor, topThreads}` with no `completedAt`/`complete`/`pending`, so the ready check never passes and it would poll forever. Under StrictMode it would also double-POST.

**L (`components/live-onboarding.tsx`)**: one long form.
- `GET /onboarding` returns `{currencyCode, locale, timezone, businessContext, igAccounts[], complete}`. A 403 with code `no_seat_in_org` triggers the **bootstrap form**: "Choose your permanent currency", a `<select id=workspace-currency>`, a timezone input, and "Create workspace" → `POST /organizations/bootstrap`. **`organizations` is not in the `/api/dev` allowlist**, so bootstrap cannot work in local integration mode.
- Step 1, "Connect Instagram": lists the handles, then "Connect Instagram"/"Reconnect Instagram" → `POST /ig/connect`, then `location.assign`. The API callback redirects to `/onboarding?connected={handle}`, and the page **ignores that query param**, so there is no success acknowledgement. Callback failures return raw JSON 502/409 on the API origin, which is a dead end for the user.
- Step 2, "Your offers · {currency}": a required `textarea#business-summary` (max 1500), optional numeric prices for partnership/coaching/course (each stored as `{min:max}` of one value), comma-separated ignore handles, and the voice-consent checkbox. "Save setup" (disabled until IG is connected) → `PUT /onboarding`, then `refresh()`.
- Step 3, "Inspect your conversations" (after a save or when complete): "Start history scan" → `POST /onboarding/leak-scan`. Its **success message is written into the error slot (`role=alert`, red styling)**. An "Open inbox" link follows.
- **There is no leak-scan reveal in production.** The product's "aha" moment exists only in demo mode.

### 1.8 `/sign-in/[[...sign-in]]`

A server component. When there is no publishable key it shows "Auth not configured" with setup instructions; otherwise a centred, unbranded `<SignIn />` in inline styles. **The Shell still wraps this route, so the nav rail and bottom tabs show on the sign-in page.** `/sign-up(.*)` is public in middleware, but **no `/sign-up` route exists**. There is no sign-out, `UserButton` or `OrganizationSwitcher` anywhere in the app.

### 1.9 `/api/dev/[...path]` (local integration bridge, `route.ts`)

- Exports `GET, POST, PUT, PATCH, DELETE` aliases of one `proxy()` and awaits `context.params` (Next 16 async params).
- Returns 404 unless `NODE_ENV==="development"`, `DEALDOCK_DISABLE_AUTH==="true"`, `DEALDOCK_DEV_ORG_ID` is set, and `DEALDOCK_API_URL` is set.
- Returns 403 if the `Origin` doesn't match the request origin, or `sec-fetch-site: cross-site`. The e2e test asserts this 403.
- Returns 503 if `DEALDOCK_API_URL` isn't `http:` on a loopback host (localhost, 127.0.0.1, [::1]).
- Returns 404 if any path segment is empty, `.`, `..`, or fails `^[a-zA-Z0-9._-]+$`, or if the first segment isn't in **`onboarding, inbox, review-queue, dashboard, threads, classifications, ledger, settings, notifications, billing, account, me, seats, roster, ig`**. The e2e test asserts `/api/dev/health` returns 404.
- Forwards only `content-type` and `idempotency-key`, plus `x-demo-org: DEALDOCK_DEV_ORG_ID`. Returns only `content-type` and `content-disposition`, plus `Cache-Control: no-store`. 20 s timeout, `redirect: "manual"`, `cache: "no-store"`.

### 1.10 Shell (`components/shell.tsx`)

- Tabs: Home `/` ◆ · Inbox ▤ · Review ? · Ledger ₹ · Settings ⚙ (Unicode glyph icons). Desktop: a 208 px left rail with a "₹ DealDock" logo. Mobile: fixed bottom tabs (`md:hidden`).
- Review tab count badge (`99+` cap). **Each `Link` has `aria-label={label}`, which overrides the visible count, so screen readers never hear it.** There is no `aria-current="page"`.
- Demo extras: "Demo mode · local sample data" and "Replay onboarding demo" → `/onboarding`.
- Skip link "Skip to content" → `#main-content`. **No element has that id, so the skip link is broken.**
- L error banner when `state==="error"`: `role=alert` "{error} Try again" (`apiStore.refresh()`). If the error contains "needs setup", a "Set up your workspace" link to `/onboarding` is added.
- `/onboarding*` bypasses the shell.

### 1.11 Shared components

- `Badge` / `labelText`: 8 labels with colours and text (Brand Deal, Coaching, Course, Commerce, Fan, Spam, Personal, Uncertain). An unknown label falls back to "Other". The text always shows, so colour is never the only signal.
- `MoneyValue`: the only money renderer. Supports range (`formatMoneyRange` when `maxMinor != minor`), exact, or compact display, using the org `money` context or an explicit `ctx`. Always carries the `.money` class (mono, tabular-nums).
- `pwa.tsx`: `ServiceWorkerRegistrar`, `pushConfigured`, `enablePush`, `PushPrompt` (§3).
- `LocalAuthSession`: a `role=status` amber strip, "Local integration mode · fixed test workspace · real local API and database", visible on every page in e2e.

---

## 2. Store layer

### 2.1 Snapshot shape (`useDemoData()` via `useSyncExternalStore`)

```ts
{ threads: DemoThread[]; ledger: DemoLedgerEntry[]; money: {currency, locale};
  dashboard: {mtdRecoveredMinor, biggestMinor, avgMinor, mtdDealCount} | null; // api only
  onboarded: boolean; state: "idle"|"loading"|"ready"|"error"; error: string|null }
DemoThread = { id, handle, state: open|waiting|closed, waitingSince, nudgeDismissedAt, lastMessageAt,
  unreplied, topLabel, estValueMinMinor, estValueMaxMinor, routedTo: inbox|review_queue, reviewed,
  messages: [{id, direction, text, sentAt, classification?: {id?, label, confidence, rationale, valueMinMinor, valueMaxMinor}}],
  draft: {id, body, version, kind: reply|nudge} | null }
DemoLedgerEntry = { id, threadId, handle, dealType: brand|coaching|course|other, amountMinor, closedAt, note? }
```

The server snapshot has empty arrays, INR, `state:"idle"` and `onboarded:true`, but lacks `dashboard`. All money is in **integer minor units**. `isNudgeDue(t)` is true when the thread is waiting, has a `waitingSince`, has not been dismissed, and `now - waitingSince >= 3 days`. **Demo uses a hard-coded 3 days; the org-level `nudgeDelayDays` is ignored on the client.**

### 2.2 `apiStore` (`lib/api-store.ts`)

| Method | HTTP |
|---|---|
| `authenticate(identity, tokenProvider)` | (state) |
| `setLocalDevelopment(bool)` | identity "local-integration", base `/api/dev` |
| `init()` / `refresh()` | 6 parallel GETs: `/dashboard`, `/inbox`, `/review-queue`, `/ledger`, `/inbox?state=waiting`, `/onboarding` |
| `request<T>(path, init)` | generic |
| `getThread(id)` | `GET /threads/:id` (merged into the snapshot) |
| `ensureDraft(id)` / `regenerateDraft(id)` | `POST /threads/:id/draft`, then `getThread` |
| `send(id, text)` | `POST /threads/:id/send {draftId, finalText, idempotencyKey: randomUUID()}`, returning `{…, pending, ambiguous}` |
| `setState(id, s)` | `PATCH /threads/:id {state}` |
| `dismissNudge(id)` | `POST /threads/:id/nudge/dismiss` |
| `closeDeal(id, amt, type)` | `POST /threads/:id/close`, header `Idempotency-Key: close-{id}` |
| `review(classificationId, outcome, label?)` | `POST /classifications/:id/review {outcome, overrideLabel}` |
| `updateLedger` / `deleteLedger` | `PATCH` / `DELETE /ledger/:id` |
| `download(path, name)` | `POST /settings/export` or `GET` (others), returned as a blob download |
| `setRegion` | `PUT /settings/region` |
| `setVoice` | `PUT /settings/voice {enabled}` |
| `setIgnoreList` | `PUT /settings/ignore-list {handles}` |
| `setNotificationPrefs` | `PUT /notifications/prefs` |
| `cancelBilling` | `POST /billing/cancel` |
| `scheduleDeletion` | `DELETE /account` |
| `resampleVoice` | `POST /settings/voice/resample` |
| `connectInstagram` | `POST /ig/connect` returns `{authorizeUrl}` |
| `startLeakScan` / `getLeakScan` | `POST` / `GET /onboarding/leak-scan` |
| `inviteSeat` | `POST /seats/invite` (**unused by any UI**) |
| `subscribePush` | `POST /notifications/subscribe` |
| `preparePush` / `assertPushIdentity` / `confirmPushIdentity` | push identity guards |

Calls made directly from Live* components with `apiStore.request`: `/onboarding` (GET/PUT), `/organizations/bootstrap`, `/settings`, `/billing`, `/settings/ignore-list` GET, `/settings/voice/consent`, `/ig/disconnect`, `/account/cancel-deletion`, `/ledger?month=`, and `/threads/:id` (GET, PATCH, `/draft`, `/send`, `/close`).

`mutate()` performs the request, waits for any in-flight refresh, then runs a fresh `refresh()`. On error it sets `snapshot.error` but **not** `state`, then rethrows.

Error mapping in `request()`:
- 401 → "Your session expired…"
- 403 → `{status:403, code}`, with copy "Your workspace needs setup…" when the code is `no_seat_in_org`, else "read-only or your seat does not have permission"
- 409 → the server detail, or "no longer available"
- 429 → "temporarily rate limited"
- anything else → the hint, message or error from the body, or "could not complete that request (status)"

### 2.3 `demoStore` (`lib/demo-store.ts`)

It seeds `CORPUS` through `HeuristicPipeline.classify` with a hard-coded creator ("Fitness coach…", `styleCard {greeting:"Hey hey!", signoff:"– D"}`). Routing is by `REVIEW_CONFIDENCE_THRESHOLD`. It seeds two waiting brand threads (replied four days ago, so a nudge is due) with nudge drafts, plus four ledger entries. It persists to `sessionStorage["dealdock-demo-v1-{CORPUS.length}"]`, and `restore()` validates the shape and labels, re-seeding if anything is invalid. Methods: `init`, `subscribe`, `getSnapshot` (cached), `setRegion`, `completeOnboarding`, `leakScan()`, `ensureDraft` (high-intent only), `regenerateDraft`, `send` (pushes an outbound message, clears the draft, marks replied, restarts the waiting clock), `dismissNudge`, `setState` (resets `waitingSince`/`nudgeDismissedAt` and drops a nudge draft), `closeDeal` (unshifts a ledger entry), and `review` (sets reviewed, moves the thread to the inbox, applies the label). The comment says "/onboarding resets this", but nothing resets `onboarded`.

### 2.4 `appStore` bridge (`lib/use-demo.ts`)

In demo mode, `setVoice`, `setIgnoreList`, `setNotificationPrefs`, `resampleVoice`, `cancelBilling`, `scheduleDeletion`, `updateLedger`, `deleteLedger` and `download` are **no-ops**. `connectInstagram` returns `{authorizeUrl:""}`, `startLeakScan` returns `{enqueued:0}`, and `getLeakScan` returns `{}`. `send` resolves `{sent:true}`.

### 2.5 Invariants a redesign MUST preserve

1. **Identity switching (tenant isolation).** `authenticate()` with a new identity (`${userId}:${orgId}`, or `null` when there is no org) must, synchronously and before any new render: abort every in-flight `AbortController`, drop the refresh promise, reset the snapshot to EMPTY (`loading` or `idle`), and emit. `request()` captures `requestedFor` and re-checks identity after token retrieval and after JSON parsing ("Account changed…"). `loadSnapshot` and `getThread` discard results if the identity changed. `download()` re-checks after the blob and never creates an object URL or clicks for an old tenant. (Unit tests: "starts a new tenant load immediately and never publishes a late old-tenant response" and "does not download an old tenant export…".)
2. **No request without identity.** With no token and not in local mode, `request()` throws "session is unavailable" before calling `fetch`. (Test: "never requests data without an authenticated identity".)
3. **Single-flight refresh.** Concurrent `refresh()` and `init()` calls collapse into one load of exactly 6 GETs. (Test: "deduplicates simultaneous refreshes".) A redesign that adds endpoints to the snapshot must update this count in the test.
4. **Memory-only data.** The API token and tenant data are never persisted. The only persisted items are the demo snapshot (sessionStorage, demo only) and `localStorage["dealdock.push.owner"]`. Requests use `credentials:"omit"` and `cache:"no-store"`.
5. **Push owner cleanup.** On an identity change, if the stored push owner isn't the new identity, unsubscribe the current push subscription and remove the owner key (chained on `pushCleanup`; failures swallowed). `preparePush()` awaits that cleanup and asserts identity. `enablePush` asserts identity before and after `POST /notifications/subscribe`, then `confirmPushIdentity` stores the owner. On failure it unsubscribes a newly created subscription, or any subscription when the identity changed. (Test: "unsubscribes the previous workspace before allowing explicit push opt-in and rejects stale registration".)
6. **Offline refusal; never queue writes.** `request()` and `download()` throw immediately when `!navigator.onLine` ("You are offline. DealDock does not queue sends or edits…"). The service worker never intercepts non-GET requests. Nothing may add background sync, retry queues, Server-Action auto-retry (see §6), or optimistic sends.
7. **Human approval and idempotency.** Send requires a current `draftId`, the final text as edited by the human, and an idempotency key that is **stable for the same draft across retries** (LiveThread `approval` ref). Sale close uses an `Idempotency-Key` header stable per dialog open (LiveThread) or per thread (`close-{id}` in `apiStore`). The server accepts `[A-Za-z0-9._:-]{16,200}`. `sendInFlight` must block re-approval and show the "will not send it again automatically" copy. Ambiguous or pending results must say delivery is unconfirmed and that no retry will happen. There is no auto-send anywhere.
8. **Regenerate protects edits.** Replacing human-edited text with a new draft requires explicit confirmation.
9. **Currency fixed per org.** All amounts are integer minor units, parsed with `parseMoneyInput` (at most 2 decimals, must be positive) and rendered only through `MoneyValue` / `formatMoney*` with the org `money` context. Ledger months come from the server in the org timezone.
10. **Demo is never a fallback.** `IS_DEMO_MODE` is a build-time constant that is false in production. Demo data must never mix with API data, and the UI must label demo mode.
11. **Review is classification-only.** No draft or send actions in the review queue.
12. **Auth gate fails closed** (see §6): auth can only be disabled when `NODE_ENV !== "production"` and the server-only `DEALDOCK_DISABLE_AUTH === "true"` (never a `NEXT_PUBLIC_` flag). `ClerkProvider` mounts only when the publishable key exists. Local integration requires the development environment plus all three env vars.

---

## 3. PWA, service worker, and push

- **Manifest** (`public/manifest.webmanifest`): name/short_name DealDock, `start_url /`, `scope /`, `display standalone`, `orientation portrait-primary`, background/theme `#050505`, icons 192/512 with `purpose: "any maskable"`. Combining both purposes in one icon is discouraged; they should be separate. There are no `id`, `shortcuts`, `screenshots` or `categories`. `layout.tsx` metadata adds `manifest`, `appleWebApp {capable, black-translucent, title}`, icons, `robots noindex`, and viewport `themeColor #050505`.
- **Registration**: in production, `navigator.serviceWorker.register("/sw.js")` runs on mount and silently ignores failure. **In development it unregisters every service worker**, to avoid stale cache-first chunks breaking hydration.
- **`sw.js` (cache `dealdock-v1`)**:
  - install precaches `/offline.html`, `/manifest.webmanifest` and `/icons/icon-192.png`, then calls `skipWaiting`.
  - activate deletes other caches and calls `clients.claim`.
  - fetch ignores non-GET requests (writes are never intercepted). Navigations go to the network and fall back to `/offline.html`. Same-origin `.png|svg|css|js|woff2?` requests are cache-first, with the network response stored. That cache is unbounded and never pruned.
  - push parses `{title="DealDock", body, url="/"}` (falling back to text) and calls `showNotification` with the icon and badge. Notifications have no `tag`/`renotify`/`actions`.
  - notificationclick closes the notification, `navigate(url)` + `focus()`es the first window client, or else calls `openWindow(url)`. `client.navigate` rejects for uncontrolled clients even though it is called with `includeUncontrolled: true`.
- **Offline page** (`public/offline.html`, standalone, inline CSS): ₹ logo, "You're offline", "Nothing sends or closes without a connection — no queued surprises. Your inbox picks up exactly where it left off.", and "Try again" (`location.reload()`).
- **Not implemented vs DESIGN §7.5**: a cached app shell with the last-loaded dashboard and ledger read-only, an in-app "Offline — reconnecting" banner, and disabling send/close buttons while offline (today they only fail on click), plus silent refresh on reconnect.
- **`pushConfigured()`** is true only when `NODE_ENV==="production"`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is set, and `Notification`, `serviceWorker` and `PushManager` all exist.
- **Contextual push prompt rules (`PushPrompt`)**:
  - Rendered only on thread pages (D and L). It is never shown on page load.
  - Hidden if any of these hold: demo mode, `!pushConfigured()`, no thread value, `threadValueMinor < HIGH_VALUE_MINOR (10_000_000 minor)`, or `Notification.permission === "granted"`.
  - When `permission === "denied"`, it shows the "Notifications are blocked" variant with "Got it".
  - It appears **1200 ms** after mount. The e2e test waits 1500 ms and asserts no "Notify me" button exists, because VAPID is empty in the gate.
  - Copy: "That was a {value} deal. Want to know when the next high-value enquiry arrives?" with "Notify me" (or "Try again" after an error) and "Not now".
  - "Not now" is not persisted, so the prompt **re-appears on every high-value thread view**.
  - **Bug:** the threshold ignores currency. 10,000,000 minor units is ₹1L for INR, but $100,000 for USD, so non-INR orgs effectively never see the prompt. The code comment's "$1.2K-scale" is wrong.
- **Settings path**: the explicit enable button exists only when `canEnablePush`. Toggles stay disabled until a device is subscribed. There is no "turn off on this device" option, even though the API has `DELETE /notifications/subscribe`.

---

## 4. Accessibility, and the e2e selector contract

### 4.1 What exists

- `lang="en"` on `<html>`. A skip link exists, but its target is missing (bug).
- Live screens use native `<dialog>` with `showModal()`, which provides a built-in focus trap, Escape and the top layer. LiveLedger and the sale dialog use `autoFocus`. The demo `CloseDealModal` has focus-in and Escape only. The demo `LedgerEdit` has no focus handling at all.
- `role="alert"` for errors and `role="status"` for loading and notices. Inline field errors use `aria-describedby` in the demo close modal only. Nothing uses `aria-live` beyond these roles.
- `role="meter"` with values and a label for confidence. `role="switch"` with `aria-checked` for demo toggles. `aria-expanded` on the rationale toggle.
- Most labels are explicit `<label htmlFor>` in the Live* components. Icon-only controls use `aria-label` (back arrow, nav tabs, chip removal). Decorative nav icons are `aria-hidden`.
- Touch targets are mostly ≥44 px (`min-h-11`); some are 32–36 px (filter chips `min-h-8`, the nudge banner's buttons).
- `prefers-reduced-motion` sets all animation and transition durations to 0.01 ms.
- **Gaps**:
  - The dashboard has no h1.
  - The demo thread h1 is missing (the handle is a `<p>`).
  - Nav `aria-label` hides the review count, and there is no `aria-current`.
  - Filter chips have no `aria-pressed`.
  - The onboarding progress uses `aria-label` on a role-less div.
  - `window.confirm()` is used for destructive actions in L.
  - Dates use the browser locale.
  - DESIGN §7's keyboard triage (j/k, enter, y, s) is not implemented.
  - There are no per-message `lang` attributes for Hinglish or Devanagari.
  - Most components skip the Tailwind `@theme` tokens and use arbitrary hex values.

### 4.2 Exact selectors the Playwright gate depends on (`tests/e2e/live-product.spec.ts`)

All of these run against **live mode** (`NEXT_PUBLIC_DEALDOCK_DEMO_MODE=false`, local integration bridge, Clerk disabled, VAPID empty). They run in two projects: `chromium` (Desktop Chrome) and `mobile` (Pixel 7). Playwright string `name`/`getByLabel`/`getByText` matching is **case-insensitive substring** unless `exact: true`, and every locator is **strict**: more than one match fails.

| # | Page | Selector | Must remain true |
|---|---|---|---|
| 1 | `/inbox` | `getByRole("heading", { name: "Revenue Inbox" })` | Exactly one heading containing "Revenue Inbox" is visible |
| 2 | `/inbox` | `locator('a[href^="/thread/"]').filter({ hasText: "@e2e.<project>" })` | Thread rows are **`<a href="/thread/{id}">`** whose text includes `@handle`, visible at desktop and Pixel 7 widths. Click navigates. |
| 3 | `/inbox` and `/settings` | `AxeBuilder.withTags(["wcag2a","wcag2aa"])` with **zero violations** | |
| 4 | thread | `getByRole("heading", { level: 1 })` toContainText "@" | **Exactly one h1**, containing the handle |
| 5 | thread | `getByRole("list", { name: "Conversation history" })` | A list element with that accessible name |
| 6 | thread | `getByRole("button", { name: "Notify me" })` has count 0 after 1.5 s | The push prompt must not render when push isn't configured |
| 7 | thread | `getByRole("button", { name: /Generate draft\|Regenerate draft/ })` | Exactly one match; clicking generates a draft |
| 8 | thread | `getByLabel("Review and edit before sending")` | The reply textarea's label; it is enabled once a draft exists |
| 9 | thread | `getByRole("button", { name: "Approve & send" })` | Exactly one; it sends. **It is disabled after a successful send** (no auto-generated next draft). |
| 10 | thread | `getByText(/Reply sent\|Approval recorded/)` | A single visible confirmation element |
| 11 | thread | `getByText(approvedText, { exact: true })` has count 1, before and after reload | The sent text renders once. It must not be duplicated in a toast, preview or textarea-mirroring element. |
| 12 | thread | `getByRole("button", { name: "Record a sale" })` | A unique opener |
| 13 | thread | `getByRole("dialog", { name: "Record a confirmed sale" })` | The dialog's accessible name |
| 14 | thread | `getByLabel(/Amount/)`, filled with "1200.50" | **The only element on the thread page whose label matches /Amount/**, and it accepts decimals |
| 15 | thread | `getByLabel("Offer type").selectOption("brand")` | A `<select>` (or `selectOption`-compatible element) with an option of value or label "brand" |
| 16 | thread | `getByRole("button", { name: "Confirm sale" })` | Unique |
| 17 | thread | `getByText("Sale recorded:")` | One visible element containing that substring |
| 18 | `/` | `locator("main .money.text-4xl")` toHaveText the exact formatted MTD total (`₹` + `Intl.NumberFormat("en-IN")`, with 0 or 2 decimals) | **A CSS-class selector.** One element with both the `money` and `text-4xl` classes inside `<main>`, showing the exact (not compact) total |
| 19 | `/ledger` | `getByRole("heading", { name: "Revenue Ledger" })` | Exactly one heading containing that text |
| 20 | `/ledger` | `getByText("@e2e.<project>", { exact: true })` | **Exactly one** visible element whose full text is `@handle` (beware duplicates in charts, tooltips, or mobile and desktop copies) |
| 21 | `/ledger` | `getByRole("button", { name: "Edit deal for e2e.<project>" })` | The edit button's accessible name (handle without "@") |
| 22 | `/ledger` | `getByRole("dialog", { name: "Edit ledger entry" })` | The editor's accessible name; hidden after save |
| 23 | editor | `editor.getByLabel("Amount")` has value "1200.50" | Exact minor-unit to input formatting (`moneyInputValue`) |
| 24 | editor | `editor.getByLabel("Note")` | |
| 25 | editor | `editor.getByRole("button", { name: "Save" })` | Unique within the dialog (substring: "Save changes" also matches) |
| 26 | `/settings` | `getByRole("heading", { name: "Settings" })` | **Only one heading may contain "Settings"** (for example, no "Notification settings" sub-heading) |
| 27 | `/settings` | `getByRole("heading", { name: "Your data" })` | |
| 28 | `/settings` | `getByText("Push notifications are not configured or supported on this device.")` | Exact copy, visible |
| 29 | `/settings` | `getByRole("button", { name: /Enable notifications on this device\|Enable or reconnect this device/ })` has count 0 | No enable button when push is unconfigured |
| 30 | bridge | `GET /api/dev/health` returns 404; `GET /api/dev/inbox` with `Origin: http://untrusted.invalid` returns 403 | Bridge allowlist and origin check |
| 31 | data | `page.request.get("/api/dev/dashboard")` and `("/api/dev/ledger")` | The bridge must keep proxying these; `/ledger` returns `{entries[{handle, amountMinor, note}]}` |

Other gate coupling (`scripts/run-browser-gate.mjs`):
- It pre-warms `/inbox`, `/thread/readiness-only`, `/ledger`, `/settings`, `/review` and `/onboarding`, and **each must return HTTP 200 under `next dev --webpack` on port 3100**. A server-side `notFound()` for an unknown thread id, or a server redirect to a non-200 page, would break the gate.
- The fixture handle is `e2e.creator` (the IG account). Threads are `e2e.chromium` and `e2e.mobile` (coaching, 0.99 confidence, value 100,000–120,000 INR in major units). Voice consent is on.
- `workers: 1`, `retries: 0`.

---

## 5. UX gaps, bugs, inconsistencies, dead ends

### 5.1 Structural

1. **Two UIs.** Demo mode is the designed product (gold, double-bezel, rationale, nudges, leak-scan reveal). Production renders Live* components that look like generic admin forms (`neutral-900`, `rounded-lg border-white/20`, underlined links, raw lowercase enums, `window.confirm`). Pilot users only ever see the latter. This is the core reason it reads as a "generic CRM/form app".
2. **Conditional hooks.** The `if (!IS_DEMO_MODE) return <Live…/>` early return comes before hooks in 4 pages (and in `LeakScan`). It is stable only because the condition is a build constant, and it violates rules-of-hooks.
3. **No `loading.tsx`, `error.tsx` or `not-found.tsx`.** Loading is indistinguishable from empty on `/`, `/inbox` and `/review`, which show ₹0, "Inbox clear" or "Queue clear ✓" while loading.
4. **Mutation errors are invisible** on `/review`, the demo thread and the demo settings (`void` promises, `snapshot.error` without `state:"error"`).
5. **Unused design tokens.** Tailwind `@theme` tokens exist in `globals.css`, but nearly all styles hard-code hex values. The font is the system font, with no brand typeface; the prototypes use Geist.

### 5.2 Feature gaps (API or spec exists; UI missing)

- No production leak-scan reveal or progress, and the API summary has no completion or progress field.
- The live thread lacks: badge, value, rationale, confidence, nudge banner and dismiss, "Move to waiting?" after send, closed-deal summary, audio/voice-note handling, day separators, and a reply-window-closed (Meta 24 h) state.
- Live inbox rows lack waiting age, nudge-due, draft-ready and min–max range; the API row doesn't carry them. There is no sort menu (the API supports `value|recent|oldest_unread`), no label or `unrepliedOnly` server filters, no search, no pagination beyond 50, and no closed or archived view.
- No Roster view (`GET /roster`), no seats or invites UI (`/seats*`), no role awareness (`/me`), no account or org switcher, and no sign-out.
- Settings has no nudge-delay or locale controls, no global drafting toggle (`PUT /settings/voice`), no "what we store" (`/settings/data`), no device unsubscribe, no plan or tier, price, next invoice, or upgrade, and no weekly summary.
- **No writing-style surface.** There is no view of what the voice model learned, no sample include/exclude, no greeting/length/language/flagged-word controls, and no edit-learning feedback. The only control is "Refresh writing style". (Studio prototype §7 covers this.)
- No offer or pricing facts editor after onboarding: business context is set once in onboarding and has no settings home.
- Onboarding ignores `?connected=`, and IG callback errors land on raw API JSON. The demo onboarding "What do you sell" answers are discarded. The live bootstrap can't run through `/api/dev` (`organizations` is not allowlisted).
- Ledger lacks a deal-type edit, by-type breakdown, live trend chart, undo, and read-only post-cancel mode. The demo ledger's edit and delete are no-ops.

### 5.3 Bugs and inconsistencies

- The skip link points at `#main-content`, which doesn't exist.
- The Review tab count is hidden from screen readers by `aria-label`.
- The Shell (nav) renders on `/sign-in`.
- The push threshold ignores currency, and a dismissal is not remembered.
- LiveThread's waiting toggle is enabled on closed threads (it would PATCH closed→waiting).
- The live onboarding scan success message renders as a red `role=alert` error.
- The `ProductionLeakScan` ready check can never pass (dead code).
- INR is hard-coded in: "sorted by ₹ value", "Mark closed ₹", the demo close modal's `₹`/en-IN formatting, the CSV header `amount_inr`, onboarding deal ranges, and the nav icon and logo "₹". DESIGN §6 says to use the org currency symbol.
- Naming drift between demo and live: "Mark closed ₹/Log the deal" vs "Record a sale/Confirm sale"; "Approve & Send" vs "Approve & send"; "Waiting ✓" vs "Reopen"; "Brand Deal" badge vs raw "brand" in the ledger; "Revenue Recovered" vs "Confirmed revenue".
- Dates in LiveThread and Settings use `toLocaleString()` in the browser locale and timezone, not the org's.
- The demo region step lets you change currency, but production forbids it.
- The demo default sale type is "brand"; live defaults to "coaching".
- The thread page's demo branch has a dead `getThread` effect, and the `appStore.send`/`closeDeal` API paths are unused in live mode.
- The service worker's `client.navigate` on uncontrolled clients can reject.
- The manifest uses `"any maskable"`.

### 5.4 Generic-looking areas

Unicode glyph icons (◆ ▤ ? ₹ ⚙). The system font. Grey forms in all Live* screens. A text-only dashboard with no trend or comparison. An unbranded Clerk sign-in and org picker. A plain offline page. Every list is the same `divide-y` card. Empty states have no illustration or north-star reinforcement in live mode. No motion: no count-up, celebration or view transitions.

---

## 6. Next.js 16 specifics a re-implementer must follow

Sources: `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`, `03-api-reference/03-file-conventions/{middleware,proxy}.md`, `02-guides/progressive-web-apps.md`, `03-api-reference/04-functions/use-offline.md`. `apps/web/AGENTS.md` instructs reading these docs before writing code (its block is re-added by `next dev`).

1. **`middleware.ts` is deprecated; rename it to `src/proxy.ts`** and export a function named `proxy` (a default export works, but the docs recommend the `proxy` name). The codemod is `npx @next/codemod@canary middleware-to-proxy .`. **The proxy runtime is always Node.js, and `runtime` config throws an error.** Flags are renamed (e.g. `skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize`). Clerk 6.39.8 detects the `proxy` filename (`@clerk/nextjs/dist/cjs/server/fs/middleware-location.js`). Keep the same `matcher`, which excludes `.html` (offline.html), `.js` (sw.js), `.webmanifest` and images from auth, and includes `/(api|trpc)(.*)`. Keep the fail-closed `AUTH_DISABLED` logic and the public `/sign-in(.*)` and `/sign-up(.*)` routes.
2. **Async request APIs only.** `params` and `searchParams` are Promises in pages, layouts and route handlers, and synchronous access was removed in 16. Current usage: `use(params)` in the client thread page, and `await context.params` in the route handler. Use the generated `PageProps<'/thread/[id]'>` and `RouteContext` helpers (`npx next typegen`). `cookies()` and `headers()` are also async.
3. **Turbopack is the default** for `next dev` and `next build`. The browser gate deliberately runs `next dev --webpack`. Do not add a custom `webpack` config, because a Turbopack build would fail. Config sits at the top-level `turbopack` key. `next dev` writes to `.next/dev`, and a lockfile blocks a second `next dev`.
4. **Parallel routes need an explicit `default.tsx`** in every slot, or the build fails. This matters if the redesign uses `@thread`/`@modal` slots for a split-pane inbox. Intercepting routes are available for a modal thread on desktop.
5. **Scroll behaviour**: Next no longer overrides `scroll-behavior: smooth` during navigation. Add `data-scroll-behavior="smooth"` on `<html>` if you want the old override.
6. **ESLint flat config.** `next lint` is gone, and the package currently has no lint script.
7. **React 19.2 features ship in the App Router** (installed react is 19.3.1): `<ViewTransition>` for route and list transitions, `useEffectEvent`, and `<Activity>`. `<Activity>` can keep a hidden thread's draft state alive in a split pane, which supports the "protect edited drafts" invariant. The React Compiler is stable but opt-in.
8. **PPR now means opting in with `cacheComponents: true`.** It is not used today. If adopted, client pages are unaffected, but authenticated tenant data must not be cached across users.
9. **The experimental `useOffline` hook** (`next/offline`, behind `experimental.useOffline`) auto-retries blocked navigations, prefetches **and Server Actions**. **Do not route send or close through Server Actions with this enabled.** It would violate the no-queued-send invariant. It is safe for a read-only offline banner.
10. **Metadata conventions**: `metadata` and `viewport` are separate exports (`themeColor` lives in `viewport`). `app/manifest.ts` (`MetadataRoute.Manifest`) can replace `public/manifest.webmanifest`. The PWA guide recommends serving `/sw.js` with `Cache-Control: no-cache, no-store, must-revalidate` and a strict CSP via `next.config` `headers()`; this isn't configured today.
11. **Fonts**: use `next/font/local` (the prototypes embed Geist and Geist Mono under the OFL; license files are in `design/*/FONT-LICENSE.txt`) or `next/font/google`, rather than inline base64.
12. **Platform minimums**: Node 20.9+, TypeScript 5.1+, and Chrome/Edge/Firefox 111+ and Safari 16.4+. iOS web push needs 16.4+ with the app installed as a PWA.
13. **Existing config to keep**: `reactStrictMode: true` (effects double-run in dev, so the leak-scan POST and similar side effects must be idempotent or guarded) and `transpilePackages: ["@dealdock/core","@dealdock/ai","@dealdock/messaging"]`. Tailwind v4 runs through `@tailwindcss/postcss`, with tokens in a CSS `@theme` block.
14. **Root layout constraints**: `ClerkProvider` mounts only when the key is present, so keyless CI builds still prerender. `LocalAuthSession` mounts only in development with the explicit env vars. `robots: noindex`.

---

## 7. Prototype ideas worth keeping

**`design/workspace/index.html`** (light "paper" direction, matching the live marketing site: paper `#f3f4ef`, ink `#191d1b`, signal yellow `#f9d84a`, green `#355e44`, red `#a23529`, Geist and Geist Mono):
- Conversation-first split pane: the queue sits beside the thread, the latest buying question and the editable draft are visible together, and history is expandable. On mobile, a focused thread has a pinned approval bar.
- Tabs "For your attention" / "Waiting on them" (`role=tab`), filter chips with `aria-pressed`, and a sort control.
- **Dirty-draft protection dialog** when switching conversations: "Keep your words?" with "Stay here", "Discard edits" and "Keep draft".
- **Estimate explanation dialog**: "A signal, not a certainty", which separates classification confidence from the chance of a sale. "Why this one?" opens it.
- **Offer-context dialog**: "What your draft knows", which shows the offer facts behind a draft. "Based on your {offer} offer" appears on the draft.
- **Reply window closed state**: "The reply window has closed", with a "Reply in Instagram" handoff instead of a delayed send.
- After approval: "Your words. Your approval." plus "Waiting on them" and "Next conversation →" (an inbox-zero flow).
- A sale dialog with a note field: "A good conversation. A real outcome." and "What was the sale worth?". Zero-value validation focuses the field.
- A search dialog ("Find a conversation"), a "More conversation actions" dialog, and an account dialog.
- Review framed as "Needs a look" / "A little context would help.", where confirming moves the thread to the inbox with the value explicitly unconfirmed.
- The send button is disabled when `!navigator.onLine`. No key combination approves a reply.

**`design/studio/index.html`** (lime-on-paper, multi-creator):
- A **creator switcher** for the Roster tier: the queue, style samples, preferences and revenue all switch per creator.
- **A writing-style studio** in three numbered sections:
  - "01 · Replies to learn from": include or exclude individual sent replies as training samples.
  - "02 · Make the style specific": greeting, reply length, language preference (English/Hinglish), and "Words to flag for review".
  - "03 · Your permission, your choice": a consent checkbox. Revoking it clears that creator's samples and unsent drafts.
  - It ends with a live "Writing style preview". This is the natural home for the "drafts learn from my edits" requirement.
- **"Ground the reply in what you know"**: per-thread facts, such as availability, that update the offer context without overwriting edited drafts. "Rebuild from this style" asks before it replaces edits.
- A two-step approval: "Review reply →" then "Approve". Plus "I replied elsewhere", which marks the thread as waiting without sending.
- **Honest audio handling**: "Listen before deciding." / "How audio will be handled". Voice notes are flagged, not faked.
- Revenue: "Revenue you've confirmed." with an Export CSV option.
- Bottom navigation on mobile, a left rail on desktop, `aria-current="page"` on the active view.

Both prototypes use native `<dialog>`, labelled forms, `aria-current`, `aria-pressed` and `role=tab`, and fully keyboard-dismissable modals. That is a stronger a11y baseline than the current Live* screens and should be adopted.
