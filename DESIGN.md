# DealDock — Design System v3: "Native money messaging"

Status: shipped in `apps/web` on 31 Oct 2026. Replaces v2 (plum hero, highlighter, serif money), which was rejected along with three mockup rounds. The tokens live in `apps/web/src/app/globals.css`; the shared pieces live in `apps/web/src/components/kit.tsx` and `apps/web/src/components/ui/*`.

## 1. What it should feel like

DealDock is a messaging app whose messages are worth money. It should feel like a premium native app on a phone (Messages, Wallet, a bank app) and like a calm, fast desk on a laptop. It must never feel like a generic CRM, a toy, or an AI chatbot.

Principles:

1. **Money is the one colour.** Emerald appears on confirmed money, money actions (record a sale, the biggest reply) and "in your voice" provenance. Nothing else is green.
2. **The platform's grammar, not a dashboard's.** Large titles, grouped inset lists, bottom sheets, a glass tab bar, capsule buttons, swipe-and-slide gestures. Users already know how these work.
3. **The person first.** Every conversation row leads with a face (gradient monogram or photo), the name, then the money. Labels are small dots with words, not badges.
4. **Calm by default, loud only when money is at risk.** The red ring and red copy appear only when a reply window closes within the hour or six hours. No unread dots, no confetti.
5. **Human approval is the brand.** Nothing sends on its own. The send gesture is deliberate (slide on touch, a full-width button with ⌘↵ on desktop), and every send gets an undo window.
6. **The AI is invisible.** No sparkles, no "AI" chips. Drafts say "In your voice · 74% match", with a waveform glyph.

## 2. Tokens

Components use the Tailwind classes generated from the tokens (`bg-canvas`, `text-ink-2`, `bg-brand`, …). No raw hex in components (the dark hero cards have their own tokens, below), and never `dark:` utilities: the tokens switch.

### 2.1 Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `canvas` | `#F3F3F6` | `#09090B` | App background |
| `surface` | `#FFFFFF` | `#141417` | Cards, grouped lists, bubbles in |
| `inset` | `#ECECF0` | `#1F1F25` | Filled inputs, secondary buttons, wells |
| `fill` | `#E4E4EA` | `#2A2A31` | Switch off, meters, progress tracks |
| `ink` / `text-1` | `#0B0B10` | `#F4F4F6` | Primary text, primary buttons, outgoing bubbles |
| `ink-2` | `#4A4A55` | `#ABABB6` | Secondary text |
| `ink-3` | `#64646D` | `#8C8C98` | Captions, metadata (AA on canvas) |
| `brand` | `#077A51` | `#2FD58E` | Money actions, switches on, active tab |
| `recovered` | `#06744D` | `#3BDD98` | Confirmed money text |
| `brand-tint` | `#E3F5EC` | `#0E2A1F` | Money pills and wells |
| `waiting` | `#955900` | `#FFB547` | Waiting, needs reconnecting |
| `review` | `#5B4FD6` | `#A79BFF` | "Check these", uncertain labels |
| `danger` | `#C8232F` | `#FF6B72` | Window closing, destructive |
| `info` | `#1A5FD0` | `#6EA8FF` | Neutral system info, focus ring |

Deal-type accents (dot, icon and tint pill): brand deal blue `#2F5BEA`, coaching teal `#0B8A7E`, course orange `#C25E00`, other sale pink `#C2316D` (lighter equivalents in dark).

**Dark hero cards.** `HeroCard` is a fixed near-black card (`hero`) with an emerald radial glow (`.dd-hero-glow`; `.dd-hero-glow-cool` adds a blue one) that looks the same in both themes: Today's "Money in your DMs right now", Revenue's month total, Voice match, the sign-in panel and All creators' recovered total. Inside it, text is `on-hero` (secondary text at 55–70% opacity), money is `hero-money`, accents are `hero-accent` with `on-hero-accent` text, alerts are `hero-alert` on `hero-alert-tint`, and buttons use the `hero` and `on-hero` variants. The `--dd-hero*` tokens never switch with the theme.

### 2.2 Type

Geist for every word and number (Noto Sans Devanagari as the Hindi fallback; Geist Mono only for keyboard hints). Money uses tabular figures and tight tracking, never a serif.

| Role | Phone | Desktop (≥1024) | Weight |
|---|---|---|---|
| `display-xl` (large title) | 34/40 | 30/36 | 700 |
| `display` | 28/34 | 26/32 | 700 |
| `title` | 22/28 | 20/26 | 650 |
| `heading` (group titles) | 17/22 | 15/20 | 600 |
| `body` | 16/22 | 14/20 | 400 |
| `message` (bubbles) | 16/22 | 15/21 | 400 |
| `label` / `button` | 15–16 | 14 | 500 / 600 |
| `caption` | 13/18 | 12/16 | 400 |
| `money-hero` | 44/48 | 52/56 | 600 |

Body text is 16px on phones (no iOS zoom on focus) and 14px on desks, where density matters.

### 2.3 Shape, elevation, spacing

- Radii: 8 (chips inside cards), 12 (inputs), 16 (wells), 20–22 (grouped lists, cards), 26–28 (heroes, sheets). Buttons, chips, tags and the tab bar are capsules.
- Elevation: `shadow-card` for grouped lists and cards, `shadow-raised` for heroes, sheets and the send knob. Hairlines (`hairline`) divide rows inside a card; cards never have visible borders.
- Gutters: 16px phone, 32px desktop. Page widths: 640 (focus screens), 720 (settings content), 860 (activity), 1180–1240 (dashboards).

### 2.4 Motion

Durations: press 140ms, row 220ms, send 260ms, sheet 340ms, stamp 520ms, money count-up 800ms. Easing: `--ease-dd-out` for entrances, `--ease-dd-spring` for the switch thumb, the send knob and the "sent" stamp. Everything respects `prefers-reduced-motion` (counters show the final value, slides snap, shimmer stops).

Signature moments:

- **Slide to send** (touch): the knob drags the emerald fill across the track; at 86% it commits, vibrates 12ms and turns into "Sending…". Keyboard and screen readers activate it as a button.
- **Undo drain**: the sending bar drains over the undo window (5/10/20s, set in Settings).
- **Sent stamp**: a check pops in (`dd-stamp`) next to "Reply sent to @handle".
- **Money count-up**: hero totals count up once per session.
- **Leak scan**: a dark scanning screen with live counters, then the reveal total.

## 3. Components

Kit (`components/kit.tsx`):

- `Logo`, `Wordmark`: the emerald rounded square with a speech bubble carrying an upward line.
- `LargeTitle`: eyebrow, large title, accessory on the right, subtitle under both.
- `Group`, `GroupLink`: the inset grouped list with a heading, an optional description and an optional action; `bare` keeps the heading without the card, and its `id` is a link anchor (`/settings#goal`).
- `HeroCard`: the dark hero card (above), with `flat` for a band or panel without corners and shadow.
- `ConversationRow`: avatar (with urgency ring only when a window closes soon), name, value, label dot and state, preview; optional creator chip on agency views.
- `ValueStrip`: a horizontal strip whose segments are the waiting conversations sized by value; tapping a segment opens it.
- `VoiceNote`: waveform bubble with play/pause and progress, used for voice notes and recorded takes.
- `ListenButton`: plays a speaking-voice preview of a short text; a second press stops it.
- `SlideToSend`, `VoiceProvenance`, `Stat`, `Tag`, `LabelDot`.

UI (`components/ui/*`): `Button`/`IconButton` (primary, money, secondary, tinted, ghost, danger, danger-ghost for quiet destructive actions, hero and on-hero inside a `HeroCard`; sm 32 / md 44 / lg 52), `Sheet` (native `<dialog>`, bottom sheet on phones, centered or side panel on desks, discard guard when dirty), `ConfirmDialog`, `Menu`, `Popover`, `Segmented` (≤4 options), `Chip`, `TextField`/`TextArea`/`Select` (label above, helper and error linked), `MoneyField` (every amount input: the currency symbol in its label, digits and a dot only, parsed to minor units, one error message), `DealTypeSelect`, `Switch` (iOS, 50×30), `MoneyValue`/`MoneyCounter`, `Avatar`/`SenderCard`, charts (`Sparkline`, `AreaChart`, `Bars`, `StackedBar`, `ProgressRing`), `Skeleton`, `EmptyState`, `ErrorState`, `OfflineBanner`, `Toaster`.

Shared sheets: `SaleSheet` (`components/sale-sheet.tsx`) records a sale from a conversation or edits one in Revenue with the same form; the goal editor (`components/goal-editor.tsx`: `GoalSheet` in Revenue, `GoalField` in Settings) sets the monthly goal.

Avatars: no photo means a monogram on one of ten gradients picked by a hash of the handle, so the same person always looks the same. A verified badge shows when Instagram says so.

## 4. Screens

Navigation: phone tab bar (Today, Inbox, Revenue, You); desktop sidebar (Today, Inbox, Revenue · Studio: Your voice, Offers · Creators: All creators and one link per creator with waiting counts · Settings). Conversations and Check these hide the tab bar.

| Screen | Route | Job |
|---|---|---|
| Today | `/` | Greeting, the dark "Money in your DMs right now" hero (at-least total, value strip, reply to the biggest), Needs you, Looks closed (record it), Follow-ups due, Recovered this month with goal ring, This week |
| Inbox | `/inbox` | Search, creator chips, views (Needs reply, Follow-ups, Waiting, Check, Closed), Big ones first; j/k and "/" on desks |
| Conversation | `/thread/:id` | Sender header and profile, day-grouped history with voice notes and transcripts, deal-signal and nudge banners, the draft in your voice, chips, alternatives, "Why this draft", voice-note toggle, slide to send with undo, learned-from-your-edit hints, record a sale |
| Check these | `/review` | One uncertain message at a time: confirm (Y), relabel (1–7), skip (N) |
| Revenue | `/ledger` | Month total hero with goal, trend bars, by type, sales list with edit and undoable delete, CSV export |
| Your voice | `/voice` | Voice match trend, edits to confirm, rules (pin, edit, turn off), how you write (measured + adjustable style), try it, speaking voice (record three takes, listen, AI label), replies it learns from, pause or stop learning |
| Offers | `/offers` | The private rate card drafts quote from: price ranges, links, availability, pause |
| All creators | `/roster` | Agency desk: totals, a card per creator, one biggest-first queue across creators |
| Settings | `/settings` | Profile, studio links (phone), Instagram accounts, notifications, follow-ups and region, monthly goal, people to skip, team, plan, appearance and sending, your data |
| Activity | `/activity` | Who sent what (with draft vs sent), sales, sorting and settings changes, by day, filterable by kind and person |
| Onboarding | `/onboarding` | Welcome, region, connect Instagram, what you sell, voice consent, the leak scan, the reveal |
| Sign in | `/sign-in` | Dark brand panel (desktop) and Clerk's form in the house style |

## 5. Accessibility

- Contrast: every text token passes WCAG AA (4.5:1) at small sizes on white, canvas, inset and its own tint in both themes; the app has a clean axe (wcag2a/aa) scan in demo mode. White text on the dark hero stays at or above 55% opacity for captions only.
- Every icon-only control has an accessible name; the slide-to-send knob is a real button named "Approve & send" with a description of who it sends to.
- Sheets are native dialogs (focus trap, Escape, focus return). Menus support arrows, Home/End and type-ahead.
- Touch targets are at least 44px (`dd-hit` extends small controls).
- Money is never colour-only: confirmed amounts are labelled and estimates read "est." or "at least".
- Hindi and Hinglish text gets `lang="hi"` when it contains Devanagari.

## 6. Copy

Write from the creator's side: "Money in your DMs", "Record a sale", "People to skip", "Check these". Say exactly what happens ("Reply sent to @handle", "Approval recorded. Instagram hasn't confirmed it yet; DealDock won't send it again."). Errors say what went wrong and what to do. Never: "AI", "leverage", "seamless", sparkles, exclamation-heavy celebration.
