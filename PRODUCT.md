# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Three audiences, all first-class in this redesign (confirmed 31 Oct 2026):

- **Solo commerce creators** (primary scene: their phone). Instagram-first creators who sell through their DMs: fitness and life coaches with paid programs, course and cohort sellers, creators who get brand deals. India-first pilot (₹4L–₹40L/month revenue, inboxes heavy in Hinglish and some Devanagari), global-ready (US/UK/Gulf/SEA creators at $5K–$50K/month). 50–500 DMs a day. Job: never miss money hiding in the DMs, reply fast in their own voice, and see what they recovered.
- **Creator + assistant** (Studio tier). An assistant replies on the creator's behalf with the creator's voice; both see who sent what.
- **Talent managers and small agencies** (Roster tier; primary scene: a desk and a laptop). They triage several creators' inboxes, send on their behalf, and report recovered revenue per creator.

## Product Purpose

DealDock is a revenue recovery system for Instagram DMs. It reads the inbox through Meta's official API, sorts every message by what it is (brand deal, coaching lead, course question, other sale, fan, spam, personal, unsure) and by its estimated value in the creator's own currency, drafts each reply in the creator's own texting voice, and lets a human approve every send. It nudges follow-ups when a deal goes quiet and keeps a ledger of sales the creator confirms. Success is one number: money recovered per creator per month, not time saved.

## Positioning

Sorting is free inside Instagram and auto-reply bots are cheap; DealDock owns three things they do not: an estimated money value on every conversation, drafts that learn the creator's real texting style from their own replies and edits (visible, editable rules, never a generic AI voice), and a ledger that proves recovered revenue over time. A human approves every message; that restraint is the trust advantage over autonomous "AI agent" competitors.

## Operating Context

- Creators open it on their phone between shoots and calls, often from a push notification about a high-value DM; sessions are short and money-ranked.
- Agencies and managers work at a laptop across several creators, in longer sessions.
- Instagram allows a reply within 24 hours of the other person's last message (up to 7 days for human-approved replies once Meta grants the Human Agent tag); brands expect replies within a day.
- First run includes a Leak Scan of the last 30 days that shows how much commerce went unanswered.
- Voice notes arrive in DMs; the creator may optionally reply with an AI voice note in their own consented, cloned voice.

## Capabilities and Constraints

- Official Meta Graph API only; never scraping or browser automation.
- Nothing ever auto-sends, including follow-ups. Every send passes the human approval gate; the worker cannot send.
- Per-creator data isolation; one currency per workspace, frozen at creation (INR, USD, GBP, EUR, AED), amounts in integer minor units, lakh/crore formatting for en-IN.
- Installable PWA (responsive web); push notifications; no native app in the pilot.
- Pricing: Solo ₹4,000/$49, Studio ₹8,000/$99, Roster ₹15,000/$179 per month.
- Non-goals: a generic CRM (pipelines, kanban, contact records, tags), bulk outbound, comment-to-DM automation, contracts, invoicing, media kits, content scheduling, scheduled send.

## Brand Commitments

- The name **DealDock** stays.
- The visual identity is open: the dealdock.io marketing site's paper/ink/yellow look is not binding for the app (the site can follow the app later).
- Rejected and not to be revisited: the v1 OLED-black/gold app, the Reply desk and Studio prototypes, and the three 31 Oct mockups (Paper & Highlighter, Afterhours, Marigold Studio). The owner's verdict on the last three: they read as documents or web pages, not as an app, with weak UI and UX.

## Evidence on Hand

- No real customer testimonials, results, logos or metrics yet (private pilot). Never fabricate any.
- A fictional fixture corpus of 226 DMs (`packages/messaging/src/mock/corpus.ts`) and demo data in the web demo store; any mock must label sample data as such.
- Product requirements: `DealDock_Product_PRD.md`; research: `docs/research/`.

## Product Principles

1. Money first: every surface answers "which conversation is worth the most right now?"
2. Estimates and confirmed money must never look alike.
3. The human is always in control; trust is shown, not claimed.
4. The creator's voice is the product: drafts must sound like them, and what DealDock learned is always visible and editable.
5. Fast on a phone, deep on a desk: one product that serves a creator between shoots and an agency at a desk.

## Accessibility & Inclusion

WCAG 2.2 AA; mixed Latin and Devanagari text must render without clipping; 44×44 px touch targets on phones; reduced-motion respected; never color-only status.
