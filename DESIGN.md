# DealDock — Product Design System & Screen Specifications

**Status:** Living document · v1.1 · Pilot scope, global-ready
**Source of truth for requirements:** `DealDock_Product_PRD.md` (v1.1 — in this repo)
**Companions:** `ARCHITECTURE.md` (entities/APIs referenced here) · `PLAN.md` (build order)

> **v1.1:** currency/locale-aware money everywhere (`MoneyValue`), Leak Scan onboarding climax, `waiting` state + nudge UI, PWA install + contextual push permission, region settings.

This is the **product** design doc — the app a creator uses daily. It inherits the brand language shipped on the marketing site (`C:\code\DealDock`), but the app is a working tool: **denser, calmer, faster**. The marketing site sells the leak; the app stops it.

---

## 1. Design principles

1. **Money first, always.** The money figure — in the org's own currency — is the most visually dominant element in any row, card, or screen. Sort order, hierarchy, color — all serve "which message is worth the most?" (PRD north star §11.1).
2. **Trust is a UI feature.** "Never auto-send" isn't just policy — the interface constantly shows the human is in control: drafts are visibly *drafts*, the send button belongs to the creator, audit trails are inspectable. (PRD §3.3, §7.5)
3. **Triage speed over completeness.** The primary loop (PRD §5.2) happens on a phone between shoots. Every high-frequency action is one tap: approve-send, mark-closed, confirm-classification.
4. **Calm surface, loud signal.** OLED-black canvas, low-chroma grays; color is reserved for classification badges and gold ₹ values. No decoration that competes with signal.
5. **Every locale is first-class; Hinglish is the pilot bar.** All text containers, previews, and drafts render mixed scripts (Devanagari + Latin, and beyond) without truncation bugs. Number and date formats follow the org locale: `₹1,20,000` lakh-grouping and `₹3.2L` compacts for en-IN; `$120,000` and `$4.2K` elsewhere. Never mixed within one org.
6. **Performance is design.** <2s dashboard on Indian mobile (PRD §7.3): skeleton states designed for every screen, optimistic UI on all one-tap actions, list virtualization on the inbox.
7. **Flow rules (non-negotiable).** Every flow has one entry point and one visible success/exit; any core surface (inbox, thread, ledger, review) reachable in ≤3 taps from home; every non-root screen has back navigation; every loading/empty/error state has an explicit recovery action — no dead ends, ever.
8. **Touch-first.** Minimum 44×44px touch targets; primary actions live in the thumb zone (bottom sticky bars, bottom tabs); destructive actions never adjacent to primary ones.
9. **AI you can interrogate.** Every classification is explainable in one line — the model's rationale ("mentions campaign budget; verified brand account") is visible on tap in thread view and always visible on Review cards. Confidence is never hidden. Trust in the classifier is earned through transparency, not asserted.

## 2. Design tokens

Carried from the landing page for brand continuity; app-specific additions marked ●.

### 2.1 Color

| Token | Value | Use |
|---|---|---|
| `bg-primary` | `#050505` | App canvas |
| `bg-secondary` | `#0A0A0A` | Panels, nav rail |
| `bg-elevated` | `#111111` | Cards, rows, thread bubbles (theirs) |
| ● `bg-input` | `#161616` | Inputs, draft composer |
| `border-subtle` | `rgba(255,255,255,0.06)` | Hairlines, dividers |
| `text-primary` | `#FAFAFA` | Headings, key figures |
| `text-secondary` | `#A3A3A3` | Body |
| `text-muted` | `#737373` / `#525252` | Meta, timestamps |
| `gold-400` | `#FFC107` | **Money values (any currency), primary revenue actions, recovered revenue** — gold = money, only money |
| `gold-500` | `#E5A800` | Hover/pressed gold |
| ● `state-waiting` | `#F59E0B` | "Waiting on them" chips + nudge row accents (amber ≠ gold: waiting is *potential* money) |
| `badge-brand` | `#22C55E` | Brand Deal |
| `badge-coaching` | `#3B82F6` | Coaching Lead |
| `badge-course` | `#A855F7` | Course Inquiry |
| ● `badge-other` | `#F97316` | Other Commerce |
| ● `badge-neutral` | `#525252` | Fan / Personal / Spam (never colorful — they're not the job) |
| ● `confidence-low` | `#EAB308` | Review Queue accents |
| ● `success` / `danger` | `#22C55E` / `#EF4444` | Sent confirmations / destructive actions |

Rule: **gold is never used for non-money UI.** A gold button means "this action touches revenue" (send a deal reply, close a deal).

### 2.2 Typography

- **UI:** Geist Sans. Scale: 24/20/16/14/13/11. App headings are quiet (16–20px semibold) — this is a tool, not a poster.
- **Money:** Geist Mono, tabular numerals, always with the org currency symbol. Sizes: inbox row 15px bold · thread header 20px · dashboard tile 32px.
- **Locale formatting via `Intl.NumberFormat`:** en-IN → `₹3.2L`, `₹1.2Cr` compact and `₹3,20,000` exact; en-US → `$4.2K`, `$1.2M` compact and `$120,000` exact (ledger, exports). One org, one format — never mixed.

### 2.3 Spacing, radius, elevation

- 4px base grid; rows 12px vertical padding; screen gutters 16px mobile / 24px desktop.
- Radius: rows/inputs 12px, cards 16px, modals 24px. Double-Bezel treatment (outer `bg-white/[0.02]` ring + inner card) reserved for **hero surfaces only**: dashboard revenue tile, close-deal modal. Everyday rows are flat — density beats ornament.
- Elevation via borders + subtle shadow, never heavy blur. `backdrop-blur` only on sticky headers/modals.

### 2.4 Motion

Motion (Framer Motion 12) with `useReducedMotion` respected globally.

| Moment | Animation |
|---|---|
| New DM lands in inbox | Row slides in from top + 600ms gold left-edge pulse, then settles |
| ₹ values on dashboard | Count-up once per session (RupeeCounter pattern from landing page) |
| Mark closed | Modal confirm → gold particle tick → ledger tile increments live — closing a deal must *feel* like scoring |
| Approve & send | Button press → draft bubble morphs into sent bubble (right-aligned) |
| Review confirm/override | Row swipes out; next row rises |
| List/screen transitions | 150–200ms fade/slide; springs `{stiffness: 300, damping: 30}` |

## 3. App shell & navigation

Responsive web, mobile-first (PRD §12: no native app in pilot).

**Mobile (<768px):** bottom tab bar — **Inbox · Review · Ledger · Settings**. Revenue Recovered strip pinned above Inbox. Thread view is a full-screen push.
**Desktop (≥1024px):** left nav rail (icons + labels, org switcher at bottom) + split-pane: inbox list (400px) | thread detail. Ledger and Review are full-width pages.
**Roster tier:** an extra top-level "Roster" view; account switcher chip appears in the inbox header.

Review tab shows a count badge (`confidence-low` yellow) when the queue is non-empty — the queue must be impossible to forget (PRD §5.4).

## 4. Screen specifications

Each maps to a PRD journey (§5) and consumes the APIs in ARCHITECTURE.md §6.

### 4.1 Onboarding wizard (PRD §5.1)

Steps (progress dots, one concern per screen):
1. **Welcome** — pilot framing, what happens next, 20-min call context.
2. **Connect Instagram** — OAuth button; on Personal-account detection: friendly interstitial explaining the 2-minute Business/Creator switch with screenshots (PRD §6.1), retry button.
3. **Region** — currency + locale + timezone, smart-defaulted from device/IP; one screen, three fields, "you can change these later." Currency choice visibly reformats the example figures live (₹3.2L ↔ $4.2K) — the user *sees* what they're choosing.
4. **Business context** — the ~10 questions (what you sell, typical brand deal range *in their currency*, coaching package sizes, audience, ignore-handles). Chip-select + ranges over free text wherever possible; this seeds value estimation, so each question shows *why we ask* in one muted line.
5. **Voice consent** — explicit, plain-language consent to sample sent DMs for voice modeling; toggle to opt out (classification-only mode, PRD §6.11). Never dark-patterned.
6. **Leak Scan reveal (the climax, PRD §5.1.6)** — progress state: "Scanning your last 30 days… 412 messages classified." Then the reveal: a Double-Bezel card, count-up to the headline — *"₹3.4L in commerce DMs went unanswered last month."* — with the top 3 missed threads beneath. This is the moment the invisible leak becomes visible; the emotional peak of onboarding.
   **CTA: "Recover your biggest one →" opens the single highest-value still-live thread with a draft already loaded** — the first task is *doing* the core loop (review → edit → send), not touring the inbox. Do, don't show: if the creator sends one real reply inside onboarding, the habit starts at minute one. (Fallback when nothing is still actionable: "Stop the next leak →" into the live inbox.)
7. **Post-first-value push prompt** — NOT during onboarding. The push permission sheet appears contextually, the first time a new high-value DM lands while the app is open: "That was a ₹2L brand deal. Want to know the moment the next one arrives?" (permission grant rates collapse when asked cold — PRD §6.8).

### 4.2 Dashboard / Home (PRD §5.2.2)

- **Revenue Recovered tile** (Double-Bezel, gold figure, count-up): month-to-date total + delta vs last month. The single most important pixel-area in the product (retention mechanism, PRD §3.1.5).
- Secondary tiles: Biggest deal · Avg deal size · Pending high-value count.
- "Needs you" strip: top 3 unreplied threads by ₹ + Review Queue count.
- Mobile: dashboard collapses to the pinned strip above Inbox — triage is the home screen.

### 4.3 Revenue Inbox (PRD §6.3) — the core screen

Row anatomy (one line of hierarchy, scannable in <1s):

```
┌────────────────────────────────────────────────────────────┐
│ [Badge]  @handle ✓            2h    ● draft   ₹2L–₹4L      │
│ Hi! We'd love to collaborate on our Q2 campaign for…       │
└────────────────────────────────────────────────────────────┘
```

- Badge = classification color chip; ✓ = verified sender; age in compact form; gold ● = draft ready; **value range right-aligned, gold, mono — the loudest element** (org currency via `MoneyValue`).
- Default sort: estimated value desc. Sort menu: value · most recent · oldest unread · confidence (PRD §6.3). Filter chips: label, age (today/this week/older), unreplied only, **waiting on them**. Filters persist per user.
- Unread = 2px gold left edge. Row states: default / unread / replied (muted) / **waiting** (amber chip + "3d silent" counter) / **nudge due** (amber left edge + "Follow up?" pill) / closed (checkmark, collapsed to ledger link).
- Audio DMs: row shows a 🎙 "Voice note — needs your ear" treatment instead of a preview line (PRD §6.2) — flagged, never hidden.
- Empty state: "Inbox clear. ₹X.XL recovered this month." — always reinforce the north star.
- Virtualized list; skeleton rows on load; pull-to-refresh on mobile.

### 4.4 Thread view (PRD §5.2.4–5.2.5)

- Header: handle + badge + **value range** + thread-state control (Open ↔ Waiting toggle) + overflow menu (reclassify, ignore handle).
- After a send, a one-tap toast offers: **"Move to Waiting?"** — starts the nudge clock (PRD §5.2.6).
- **Nudge banner** (when due): amber strip above composer — *"@brand has been quiet for 3 days"* — with the follow-up draft pre-loaded in the composer. Actions: send · dismiss (stay waiting) · close thread.
- **Sticky action bar: `Mark closed for [amount]`** (gold outline) — always reachable without scrolling (attribution under-counting is a top-5 PRD risk §10.1.5).
- DM history: their bubbles left (`bg-elevated`), creator's right (dark-gold tint). Day separators. Mixed-script rendering verified.
- **Draft composer** (bottom, distinct `bg-input` surface):
  - Label: `✦ Draft — in your voice` + regenerate icon.
  - Inline-editable textarea, auto-grow.
  - Primary action: **Approve & Send** (gold, full-width on mobile). Secondary: Regenerate · Discard.
  - Visible trust line under button: "Nothing sends without you."
  - If reply window closed (Meta 24h): composer replaced by an info state — "This thread's reply window has closed — reply from Instagram directly." (typed error from ARCHITECTURE.md §4.2)
- **Close-deal modal:** numeric keypad-first amount input (live-formats per org locale — lakh grouping for INR, thousands elsewhere), deal-type chips (Brand/Coaching/Course/Other), confirm → celebration tick → "View in Ledger" toast.

### 4.5 Review Queue (PRD §5.4, §6.5)

- Card per uncertain message: message text (full, not truncated), sender context, **best-guess badge + confidence meter** (horizontal bar, yellow), **the model's one-line rationale** ("mentions rates; unverified account — could be spam or brand"), and two big actions: **Confirm [label]** / **Change…** (opens label sheet). The rationale is what makes a 5-second confirm/override decision possible.
- One decision per card, swipe-friendly; keyboard shortcuts on desktop (Y / N / 1–8 labels).
- Footer copy: "Your corrections train your classifier." (PRD §6.5 feedback loop, made visible.)
- Never shows a send/draft action — review is classification only.

### 4.6 Revenue Ledger (PRD §6.6)

- Month selector · headline total (gold, mono, large) · trend bar chart (6 months, current month gold — same visual language as the landing-page mockup, now real).
- Breakdown row: by-type donut-less bars (color = badge colors) + biggest deal + avg size.
- Deals table: date · sender (links to thread) · type badge · ₹ exact. Row actions: edit / delete (soft, undo toast — refund handling, PRD §6.6).
- **Export CSV** button always visible — including read-only post-cancellation mode (PRD §5.6), where the whole app collapses to Ledger + export.

### 4.7 Roster overview (PRD §5.5 — Studio/Roster)

- Table/cards: creator per row — avatar+handle · MTD recovered (gold) · unread high-priority count · review-queue size · last activity.
- Tap → that creator's Revenue Inbox (identical UI, account chip in header shows context).
- Per-creator report export (monthly PDF/CSV).
- Audit view (per account): who sent what — timestamp, seat, edit distance (PRD §5.5.5, §7.5).

### 4.8 Settings (PRD §6.9, §5.6)

Sections: **Account & seats** (tier, seat list, invite — tier limits messaged inline) · **Region** (currency — confirmed change, history keeps logged amounts; locale; timezone; nudge delay) · **Notifications** (per-type toggles: high-value DM / nudge due / weekly summary; quiet hours) · **Instagram connection** (status, reconnect banner state, disconnect with plain consequence copy) · **Voice & drafting** (toggle, style summary "we noticed you often say…", re-sample) · **Ignore list** (handle chips, add/remove) · **Data & privacy** (what we store, export archive, delete account with 7-day-grace explanation) · **Billing** (plan + rail-appropriate portal — Razorpay for INR orgs, Paddle otherwise; next invoice date; the invoice-after-first-week status for new members; cancel).
**Cancel flow:** one confirmation, zero guilt UI, states clearly: ledger stays read-only 30 days + CSV always (PRD §5.6). Trust is the brand.

## 5. Component inventory

Reusable across screens; built once in `apps/web/components/`:

| Component | Notes |
|---|---|
| `ClassificationBadge` | 8 labels, color map §2.1; compact + full variants |
| `MoneyValue` | mono gold, locale-aware via org `currencyCode` + `locale`; compact (₹3.2L / $4.2K) / exact (₹3,20,000 / $120,000) / range modes; tabular |
| `MoneyCounter` | count-up on view (ported from landing page's RupeeCounter, locale-aware) |
| `WaitingChip` | amber `state-waiting`; shows days-silent counter |
| `NudgeBanner` | amber strip in thread view; send / dismiss / close actions |
| `LeakScanReveal` | onboarding climax card: scan progress → count-up headline → top missed threads |
| `PushPrompt` | contextual permission sheet (post-first-value, never on load) |
| `ConfidenceMeter` | 0–1 bar, yellow, with % label |
| `InboxRow` | states: unread/replied/closed/skeleton |
| `ThreadBubble` | inbound/outbound, mixed-script safe |
| `DraftComposer` | draft state machine: ready → edited → sending → sent/failed |
| `CloseDealModal` | ₹ keypad, type chips, celebration |
| `ReviewCard` | confirm/override, swipe + keyboard |
| `LedgerTile` / `TrendBars` | dashboard + ledger |
| `AuditRow` | actor, action, edit distance |
| `EmptyState` / `ErrorState` / `Skeleton*` | every screen has designed empty, loading, error, and offline states — no blank whites, no spinner-only screens |
| `ReconnectBanner` | token-expired state (ARCHITECTURE.md §4.3) |

## 6. Content & microcopy rules

- Voice: competent friend — warm, direct, no fluff. Light local warmth where natural per market ("Bhai, this one looks big" is too much; "Worth a fast reply" is right). No SaaS slop (elevate/seamless/unleash banned — same rule as marketing site).
- Numbers: always the org currency symbol, always org-locale grouping, never ISO codes ("INR"/"USD") in creator-facing UI.
- Notification copy leads with money: *"New brand deal — est. ₹2L+"* / *"$2.4K coaching lead waiting 3 days"*.
- Never anthropomorphize sending: it's *your* reply, *drafted* by DealDock.
- Errors: say what happened + what to do, one sentence each. No error codes at the surface.

## 7. Accessibility & internationalization

- WCAG 2.1 AA: gold-on-black 10.5:1; badge text always paired with label text (never color-only classification).
- Full keyboard triage on desktop (j/k rows, enter open, y confirm, s send focus).
- Screen-reader labels on all one-tap actions ("Approve and send reply to @handle"); icon-only controls always carry `aria-label`; decorative icons `aria-hidden`.
- **Modals (close-deal, label sheet): focus trapped, Escape closes, focus returns to the trigger.** Non-modal toasts never steal focus.
- **Form errors** (onboarding, close-deal amount, settings): associated to their input via `aria-describedby`, announced via live region, never color-only.
- Reduced motion: all §2.4 animations degrade to opacity fades.
- Script: `lang` attributes per-message where detected; line-height accommodates Devanagari ascenders.

## 7.5 Offline & PWA behavior

- Installable PWA: manifest with maskable icons, standalone display, `#050505` theme — and the **required offline fallback page** (install fails without it).
- Offline state is honest, never fake: cached shell + last-loaded dashboard/ledger render read-only with a quiet "Offline — reconnecting" banner; **send and close actions disable offline** (a queued send that fires later would violate the human-in-control promise). On reconnect, data refreshes silently.
- Push notifications degrade gracefully: iOS <16.4 and permission-denied users rely on badge counts + (V1) weekly digest email.

## 8. Performance budgets (design-owned)

| Surface | Budget | Design mechanism |
|---|---|---|
| Dashboard first paint | <2s on 4G Indian mobile (PRD §7.3) | SSR + skeletons, tile data in one query |
| Inbox scroll | 60fps at 500 rows | virtualization, fixed row heights |
| One-tap actions | perceived instant | optimistic UI + undo toasts instead of confirms where safe |
| Draft appearance | <5s worst case | pre-generated drafts (ARCHITECTURE.md §5.1); composer shows shimmer + "drafting…" only on regenerate |

---

*Every new screen or component PR links to the section here it implements. If a design decision isn't in this file, it isn't decided.*
