# DealDock — Design System v3: "Native money messaging"

Status: shipped in `apps/web` on 31 Oct 2026. Replaces v2 (plum hero, highlighter, serif money), which was rejected along with three mockup rounds. The tokens live in `apps/web/src/app/globals.css`; the shared pieces live in `apps/web/src/components/kit.tsx` and `apps/web/src/components/ui/*`.

4 November restoration: a later polish pass had drifted from this system (a warm canvas, a green-tinted dark theme, heroes made plain or dark green, outlined cards, rounded-rectangle buttons, emerald navigation and a plain draft box). Those are back to the tokens and components below; that pass's fixes stay (wrapping titles, consent-off composer guidance, focus in Check these, creator-scoped links, estimate wording). Also new: underline view tabs that fit the desk pane (arrow keys move between them) and a peeking creator chip rail in place of scroll buttons; the Check view starts the one-at-a-time sort; the desk's empty pane opens the biggest conversation in scope; rows show the creator inline so their facts fit one line; desk panes fill the window under any banner; disclosures draw their own chevron; Activity is a compact log with right-aligned times.

1 November refinement: retain this visual language. Today now recommends an actionable closing-window reply before falling back to value, and surfaces reconnection. Shared queues and conversation headers retain creator identity. Detailed reply steering and manual style axes use disclosure. Review shows sorted/remaining progress and a finite skip-for-later flow with focus and Undo. Revenue and CSV share creator/month filters. Changed scopes hide old data immediately; mobile filters have 44px targets. See the [hands-on audit and test evidence](docs/ux-and-product-audit-2026-11-01.md).

## 1. What it should feel like

DealDock is a messaging app whose messages are worth money. It should feel like a premium native app on a phone (Messages, Wallet, a bank app) and like a calm, fast desk on a laptop. It must never feel like a generic CRM, a toy, or an AI chatbot.

Principles:

1. **Money is the one colour.** Emerald appears on confirmed money, money actions (record a deal, the biggest reply) and "in your voice" provenance. Nothing else is green.
2. **The platform's grammar, not a dashboard's.** Large titles, grouped inset lists, bottom sheets, a glass tab bar, capsule buttons, swipe-and-slide gestures. Users already know how these work.
3. **The person first.** Every conversation row leads with a face (gradient monogram or photo), the name, then the money. Labels are small dots with words, not badges.
4. **Calm by default, loud only when money is at risk.** The red ring and red copy appear only when a reply window closes within the hour or six hours. No unread dots, no confetti.
5. **Human approval is the brand.** Nothing sends on its own. The send gesture is deliberate (slide on touch, a full-width button with ⌘↵ on desktop), and every send gets an undo window.
6. **The AI is invisible.** No sparkles or decorative AI chips. Drafts say "In your voice", with a waveform glyph. Historical edit rates are labelled as drafts sent with light edits, rather than a quality score for the current draft. Synthetic audio still needs its explicit disclosure.

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
- `ConversationRow`: avatar (with urgency ring only when a window closes soon), name, value, label dot and state, preview; on agency views the creator's small avatar and handle lead the facts line.
- `ValueStrip`: a horizontal strip whose segments are the waiting conversations sized by value; tapping a segment opens it.
- `VoiceNote`: waveform bubble with play/pause and progress, used for voice notes and recorded takes.
- `ListenButton`: plays a speaking-voice preview of a short text; a second press stops it.
- `SlideToSend`, `VoiceProvenance`, `Stat`, `Tag`, `LabelDot`.

UI (`components/ui/*`): `Button`/`IconButton` (primary, money, secondary, tinted, ghost, danger, danger-ghost for quiet destructive actions, hero and on-hero inside a `HeroCard`; sm 32 / md 44 / lg 52), `Sheet` (native `<dialog>`, bottom sheet on phones, centered or side panel on desks, discard guard when dirty), `ConfirmDialog`, `Menu`, `Popover`, `Segmented` (≤4 options), `Chip`, `TextField`/`TextArea`/`Select` (label above, helper and error linked), `MoneyField` (every amount input: the currency symbol in its label, digits and a dot only, parsed to minor units, one error message), `DealTypeSelect`, `Switch` (iOS, 50×30), `MoneyValue`/`MoneyCounter`, `Avatar`/`SenderCard`, charts (`Sparkline`, `AreaChart`, `Bars`, `StackedBar`, `ProgressRing`), `Skeleton`, `EmptyState`, `ErrorState`, `OfflineBanner`, `Toaster`.

Shared sheets: the deal sheets in `components/deals.tsx` record a deal from a conversation (paid now, or tracked until paid: due date, deliverables, collapsed terms, "Fill from conversation"), ask for payment and mark it paid (with TDS for INR); the invoice sheets in `components/invoices.tsx` create an invoice from a deal (full, advance, then balance) with a live tax preview, show an on-screen preview, send it with a cover note and mark it paid; `SaleSheet` (`components/sale-sheet.tsx`) edits a sale in Revenue; the goal editor (`components/goal-editor.tsx`: `GoalSheet` in Revenue, `GoalField` in Settings) sets the monthly goal.

Avatars: no photo means a monogram on one of ten gradients picked by a hash of the handle, so the same person always looks the same. A verified badge shows when Instagram says so.

## 4. Screens

Navigation: phone tab bar (Today, Inbox, Revenue, You); desktop sidebar (Today, Inbox, Revenue · Studio: Your voice, Offers · Creators: All creators and one link per creator with waiting counts · Settings). Conversations and Check these hide the tab bar.

| Screen | Route | Job |
|---|---|---|
| Today | `/` | Greeting, the dark "Money in your DMs right now" hero (at-least total, value strip, reply to the biggest), Needs you, Deals in progress (owed and overdue, one plain next step per deal), Looks closed (record it), Follow-ups due, Recovered this month with goal ring, This week |
| Inbox | `/inbox` | Search, creator chips, underline view tabs in action order (Needs you, Follow-ups, Check, Comments where keywords are set (§4.3), Waiting, Closed; each conversation sits in exactly one, so a due follow-up leaves Waiting), Big ones first; the Check view starts the one-at-a-time sort; j/k and "/" on desks; the empty desk pane opens the biggest conversation in scope |
| Conversation | `/thread/:id` | Sender header and profile, day-grouped history with voice notes and transcripts, deal-signal, nudge and possible-scam banners, deal cards (stage, next deliverable, one primary next step: terms recap, ask for payment, remind or mark paid), the draft in your voice, chips, alternatives, "Why this draft", voice-note toggle, slide to send with undo, learned-from-your-edit hints, record a deal. Email threads show the subject and attachments and reply as email |
| Check these | `/review` | One uncertain message at a time: confirm (Y), relabel (1–7), skip (N) |
| Revenue | `/ledger` | Month total hero with goal, trend bars, by type, Owed to you (open deals, due and overdue, mark paid, remind; owed counts unpaid invoices with their tax), Add a deal (for deals agreed outside DealDock), sales list with edit and undoable delete, CSV export |
| Your voice | `/voice` | Voice match trend, edits to confirm, rules (pin, edit, turn off), how you write (measured + adjustable style), try it, speaking voice (record three takes, listen, AI label), replies it learns from, pause or stop learning |
| Offers | `/offers` | The rate card drafts quote from: price ranges, links, availability, add-on prices (brand offers), pause, and the private rate-card link |
| Rate card | `/rates/:token` | Public and read-only, for brands with the link: the creator, their active offers and add-on prices; "not available" once the link is off |
| All creators | `/roster` | Agency desk: totals, a card per creator, one biggest-first queue across creators |
| Settings | `/settings` | Profile, studio links (phone), Instagram accounts, Email (a Gmail inbox per creator), What you sell (per creator on Roster), Billing details (tax registration, how brands pay, invoice numbers; per creator on Roster), notifications, follow-ups and region, monthly goal, people to skip, team, plan, appearance and sending, your data |
| Activity | `/activity` | Who sent what (with draft vs sent), sales, sorting and settings changes, by day, filterable by kind and person |
| Onboarding | `/onboarding` | Welcome, region, connect Instagram, what you sell, voice consent, the leak scan, the reveal |
| Sign in | `/sign-in` | Dark brand panel (desktop) and Clerk's form in the house style |

### 4.1 Renewals and the coach pipeline (7 November)

No new screen or navigation item: both live where the work already is, and nothing sends on its own.

- **Pitch again (Today).** One quiet row per brand worth pitching again: "Pitch @brand again", what they paid and when, then "Draft a pitch" and "Not now". A brand is due 60 days after it paid (30 from 1 September to 15 October, while festive budgets are set), within a year, with no open deal. "Draft a pitch" opens the conversation with a "Pitch again" draft, usually in the copy-to-Instagram handoff since the reply window has closed; a deal agreed elsewhere gets a sheet with the pitch to copy. Sending or copying it takes the brand off Today. Neutral, never emerald: it is a suggestion, not money.
- **Stages.** Coaching and course conversations go Lead, Qualified, Booked, Paid. Rows show the stage as a small chip after the label dot (neutral; Paid takes the money tint). The conversation has a four-option Stage control under the sender intro; a booking or payment tool that reports back only moves it forward.
- **Coaching and courses (Today).** A compact card with a count per stage for the conversations still open or waiting; each count opens the inbox at that stage, where a chip row switches stage and "All conversations" brings back the view tabs.
- **A reported payment.** In the conversation it is a money banner, "Paid ₹4,999 through Razorpay", with "Record the sale" (the deal sheet, already paid, the amount filled when it is in the org's currency) and "Dismiss". It stands in for "Looks like this closed".
- **Booking and payment links (Settings, owners).** Connected tools with their last activity; payments that matched no conversation, each with "Match to a conversation" and "Dismiss"; and "Connect a booking or payment tool": pick the tool, then short numbered steps for that tool. The address is shown once, with a copy button. Steps quote the tool's own menu names exactly; DealDock's own words stay plain ("address", "access key", "signing secret").

### 4.2 Rate card, rights and results (7 November)

Three things that protect a brand deal after the yes. Each shows one next step; the details sit behind a fold or a sheet.

- **Add-on prices (Offers).** A brand offer's sheet has an "Add-on prices (optional)" fold: usage rights and partnership ads per month, exclusivity per month, an extra revision round, rush delivery, raw footage. Each field carries the usual range as a hint, labelled typical rather than advice, worked out on the offer's starting price ("On ₹60K, that's about ₹9K–₹21K"). Drafts quote an add-on only when a brand asks and the price is set; otherwise the draft says the creator will confirm and "Why this draft" lists it as missing.
- **Rate card link (Offers).** A white card above the offers: "Create link", then the address with Copy, Open and a quiet "Turn off" (confirmed, because the old link dies). Roster adds a Creator picker; a solo creator sees none. The public page at `/rates/:token` is a phone-first single column: the dark hero with the creator's avatar and handle, then one white card per active offer (type dot, name, price or range, availability, details, add-ons in an inset well, "More details" link). No navigation, never indexed, and a calm "This rate card isn't available." once the link is turned off. In a brand conversation the draft row gets an "Add rate card link" chip that puts the link on its own line, with no new draft.
- **Usage and exclusivity dates (deal sheet).** Under "More terms", Usage and Exclusivity each get an end date beside the text. Today's "Rights and results" group shows "@brand's usage rights on 1 reel end 3 Mar" from two weeks before until a week after, with "Draft renewal" (the conversation opens with a "Usage rights" draft, usually in the copy-to-Instagram handoff; a deal agreed elsewhere gets a sheet with the note to copy) and "Done" (with Undo). A running exclusivity shows one calm note on the same creator's other brand conversations: "You agreed to exclusivity with @brand until 3 Mar: ‘No other skincare brands’. Check this brand doesn't compete." Inset, not red: it is a check, not an alarm.
- **Posts and results (deal card, past deals, Today).** Once something is delivered, the deal card shows a "Posts and results" row ("1 of 3 posted"). Its sheet takes one deliverable at a time: Mark posted (link and day), then Add results (views, reach, likes, comments, shares, saves, typed from Instagram's insights), or "Fetch from Instagram" when the API has the permission (never for stories, whose insights last a day). A disclosure checklist after India's ASCI rules sits in a fold; "Copy results" gives plain text for the brand. Today asks "Add results for 1 reel for @brand" a week after posting ("Story results are easiest to grab now" a day after a story). The invoice preview and PDF print a "Proof of delivery" section: each post's link, date and results, and the disclosure ticked.

### 4.3 Comment leads (7 November)

Someone comments a creator's keyword ("PRICE") on a post; DealDock drafts the one private reply Instagram allows, and a person sends it. Never ManyChat-style: nothing goes on its own. Shown only where the API says comment leads are on (`configured`, like Email).

- **Keywords (Settings › Comment leads).** "When someone comments one of these words on your post, DealDock drafts a private reply for you to approve." Chips like People to skip, with Add; up to 10 of 30 characters, any case, a whole word or phrase. Roster picks the creator first ("Keywords for"). A footer note: one private reply per comment, within 7 days, never sent on its own.
- **Comments (Inbox tab).** Between Check and Waiting, only where keywords are set or leads exist; its count is the comments still waiting for a reply. A one-line intro and a "How private replies work" fold (one reply per comment, within 7 days; it lands in their messages or message requests; their answer arrives as a normal conversation). One comment is open at a time, the soonest to close first and the next once it is answered: handle, the quoted comment, time left (red in the last 6 hours, like a closing reply window), "View the post", then the draft in the emerald draft bubble with "In your voice", missing facts in a waiting-tint box, and slide to send / "Send privately" (⌘↵ inside the box) with the usual undo window. "Skip" and "Draft again" sit quietly underneath; Skip leaves at once with Undo. "Sent" is a fold with what went; "Too late to reply privately" is a flat inset well with grey faces and one "Clear". On desks the right pane says to reply in the list.
- **Today.** One neutral row in the right column, "4 people commented PRICE", opening the Comments tab. Info tint, never emerald: a comment is a lead, not money.

## 5. Accessibility

- Contrast: every text token passes WCAG AA (4.5:1) at small sizes on white, canvas, inset and its own tint in both themes; the app has a clean axe (wcag2a/aa) scan in demo mode. White text on the dark hero stays at or above 55% opacity for captions only.
- Every icon-only control has an accessible name; the slide-to-send knob is a real button named "Approve & send" with a description of who it sends to.
- Sheets are native dialogs (focus trap, Escape, focus return). Menus support arrows, Home/End and type-ahead.
- Touch targets are at least 44px (`dd-hit` extends small controls).
- Money is never colour-only: confirmed amounts are labelled and estimates read "est." or "at least".
- Hindi and Hinglish text gets `lang="hi"` when it contains Devanagari.

## 6. Copy

Write from the creator's side: "Money in your DMs", "Record a deal", "People to skip", "Check these". Say exactly what happens ("Reply sent to @handle", "Approval recorded. Instagram hasn't confirmed it yet; DealDock won't send it again."). Errors say what went wrong and what to do. Never: "AI", "leverage", "seamless", sparkles, exclamation-heavy celebration.
