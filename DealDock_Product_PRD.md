# Product Requirements Document — DealDock

> Implementation amendment (30 October 2026): the organization currency is frozen at creation and cannot be changed in Settings. Nothing auto-sends, including follow-ups; only the authenticated, authorized API send gate may send. The worker has no Graph credentials or messaging capability. These explicit safety requirements supersede any older optional-autonomy or mutable-currency wording below. See [current readiness evidence](docs/private-pilot-readiness.md) for external exit gates; a live public website is not proof of authenticated-product readiness.

**Working name:** DealDock (final name TBD)
**Product type:** B2B SaaS — revenue recovery system for Instagram-first commerce creators
**Document version:** v1.1 — pilot scope, globalized
**Status:** Active, pre-launch
**Audience:** Founding team, design, eng, ops, GTM

> **v1.1 changelog (supersedes v1.0):**
> 1. **Global-ready product, India-first pilot.** The product works in any currency/locale from day one; the capped pilot cohort remains India-weighted where we have distribution. Global self-serve opens at V1.
> 2. **Currency model:** one currency per organization, chosen at onboarding. Amounts stored as integer minor units.
> 3. **Billing:** dual-rail — Razorpay (INR, UPI Autopay) + Paddle as merchant of record for international (Paddle owns global sales-tax/VAT compliance).
> 4. **New pilot features:** Leak Scan at onboarding, "Waiting on them" thread state with follow-up nudges, PWA + push notifications.
> 5. **Repositioning:** Instagram now natively offers request-folder sorting/filters and Meta AI reply suggestions. Our differentiation is **value estimation + the creator's voice + proof of recovery** — not sorting.
> 6. Message-requests folder ingestion made an explicit requirement; audio-DM handling defined; V1/V2 phasing updated (email integration joins WhatsApp).

---

## 1. Product overview

DealDock is a revenue recovery system for Instagram-first commerce creators — creators, coaches, and course sellers who sell through their DMs. It connects to a creator's Instagram inbox, identifies high-intent messages — brand briefs, coaching leads, course inquiries — sorts them by estimated monetary value, drafts replies in the creator's voice, and tracks the revenue it recovers each month.

Most inbox tools optimise for time saved or messages handled. DealDock optimises for one number: **money recovered.** Every product decision flows from that.

The pilot launches with an India-weighted cohort (₹ economy, Hinglish inboxes) but the product is built global-ready: any org can run in USD, GBP, EUR, AED, or INR. The pilot ships with Instagram only. WhatsApp Business (India) and email integration (global) are the first post-pilot platforms.

---

## 2. Problem statement

Commerce creators earning ₹4L–₹40L/month (India) or $5K–$50K/month (global) receive significant commerce inbound directly in their DMs — brand collaboration briefs, paid coaching enquiries, course questions from warm leads. These messages get buried under fan replies, spam collab pitches, and the hidden message-requests folder. The high-value messages that get missed are, by definition, invisible — the creator never sees the size of the leak.

The problem is global and time-sensitive: brands filter creators by responsiveness, and the large majority expect a reply within 24 hours. A missed day is a lost deal — in any market.

Instagram has recently added native request-folder sorting (by brand account, follower count) and Meta AI reply suggestions. These make *finding* messages easier and *generic replies* free — but there is still no tool that:

- Estimates the **monetary value** of each message and prioritises by it.
- Understands **commerce-specific message types** (brand brief vs. coaching enquiry vs. fan).
- Drafts replies in the **creator's own voice** rather than a generic assistant tone.
- Builds a **revenue attribution ledger** so the creator can see, over time, how much money the tool has recovered.
- Treats **human review as the default** for uncertain classifications, rather than auto-sending.

DealDock is the tool that does all five. Sorting is table stakes; **valuation, voice, and proof** are the product.

---

## 3. Goals and non-goals

### 3.1 Pilot goals (first 90 days post-launch)

1. Onboard a capped pilot cohort and ship the full core loop end-to-end (connect → leak scan → classify → draft → close-out → ledger).
2. Establish a credible **average recovered revenue per creator per month** number, derived from real attributed deals.
3. Achieve a **classification accuracy** high enough that creators trust the Revenue Inbox without re-checking the unsorted folder. Target benchmark to be set after week 2 of pilot data.
4. Achieve **voice fidelity** strong enough that >70% of drafted replies are sent with no edits or only minor edits.
5. Validate the Revenue Ledger as a retention mechanism — i.e. measure whether close-out frequency correlates with subscription renewal intent.
6. Validate global readiness technically: at least one non-INR org runs the full loop during the pilot (founding-team or friendly tester), proving currency/locale/billing rails.

### 3.2 Long-term product goals (post-pilot)

- **V1: open global self-serve** — qualifying questionnaire gate, USD-first pricing page, Paddle checkout.
- Expand to WhatsApp Business (India wedge) and email integration (global wedge — internationally, deals start in DMs but close over email).
- Build the Revenue Ledger into a defensible, longitudinal asset (the longer a creator uses DealDock, the more valuable their revenue history becomes — and the harder it is to leave).
- Introduce the Roster tier as a real product surface for talent managers and small agencies, not just a pricing line.

### 3.3 Non-goals (explicitly out of scope, even if requested)

- **Fully autonomous reply mode.** No "auto-pilot" that sends messages without creator approval. Ever, in pilot. Possibly later, only for low-stakes message classes, only opt-in.
- **Customer-support ticketing features** (SLAs, ticket queues, agent assignments, CSAT surveys). Not the wedge.
- **Generic creator CRM.** No deal pipelines, contact records, or sales-stage tracking beyond what the Revenue Ledger needs. (The `open / waiting / closed` thread state is triage, not a pipeline.)
- **Contracts, invoicing, and media-kit builders.** Every all-in-one competitor bundles these; none owns "money recovered from your inbox." We stay narrow.
- **Content scheduling, post analytics, or audience analytics.** Not in scope. Plenty of tools do this already.
- **Bulk outbound / cold DM tools.** Strict no — both wedge-incorrect and a reputation risk.
- **AI bots that pretend to be the creator in real-time chat.** Drafts only. The creator approves and sends.
- **Multi-currency ledgers within one org.** One currency per organization in pilot; conversion is a V1 consideration.

---

## 4. Target users

### 4.1 Primary persona — Solo Commerce Creator (India, pilot wedge)

- **Who:** Indian creator running their own brand. Typical examples: a fitness coach selling a 12-week program, a consultant running a paid newsletter and 1:1 calls, a course creator selling cohort-based courses.
- **Revenue band:** ₹4L–₹40L/month.
- **Inbox shape:** 50–500 incoming DMs/day. Mix of fan messages, brand briefs (1–10/week), coaching enquiries (5–30/week), course questions, spam collab pitches — heavily Hinglish/code-switched.
- **Pain:** misses real opportunities under message volume; replies late to high-value messages; can't tell which deals they've lost.
- **Decision driver:** money recovered, not time saved.

### 4.2 Primary persona (V1 expansion) — Global Solo Commerce Creator

- **Who:** US/UK/SEA/Gulf creator with the same commerce shape — coaching, courses, consulting, brand deals closed through DMs.
- **Revenue band:** $5K–$50K/month (or local equivalent).
- **Inbox shape:** same classes; English-dominant, other languages by market; brand conversations frequently migrate to email to close (drives V2 email integration).
- **Decision driver:** identical — recovered revenue, responsiveness advantage.

### 4.3 Secondary persona — Talent Manager / Small Agency

- **Who:** Manager handling 2–10 creator accounts. Either an in-house "manager" working for one creator's expanding business, or a small agency.
- **Inbox shape:** triaging multiple creators' inboxes simultaneously. Volume scales with roster size.
- **Pain:** can't be present in every inbox; brand briefs land on creator phones and never reach the manager; revenue attribution across the roster is invisible.
- **Decision driver:** roster-wide visibility and per-creator revenue reporting.

### 4.4 Anti-personas (explicit non-fit, do not design for these)

- **Entertainment-only creators with no commerce.** Their DMs are mostly fans; there's no revenue to recover.
- **E-commerce/D2C brands using IG as a storefront for thousands of order queries.** Different problem shape — high-volume support, not commerce sorting.
- **Enterprise marketing teams.** Wrong scale, wrong buying motion.
- **Creators below ~₹3L/month (~$3.5K/month).** The product can't pay for itself yet at that scale, and we'd rather wait than mis-sell.

---

## 5. Key user journeys

### 5.1 First-time onboarding (pilot member)

1. Creator submits pilot application form.
2. Founding team reviews; if accepted, schedules a 20-minute onboarding call.
3. On the call, creator connects their Instagram Business/Creator account via official OAuth.
4. Creator confirms **currency, locale, and timezone** (smart defaults from their region; one currency per org).
5. Creator answers ~10 quick questions about their business: what they sell, typical brand deal size range (in their currency), typical coaching package sizes, who their audience is, any handles to ignore (close family, regular collaborators).
6. **Leak Scan:** DealDock ingests and classifies the **last 30 days** of DM history (including the message-requests folder) and presents the headline: *"You had ₹3.4L in unanswered commerce DMs last month."* This is the activation moment — the invisible leak made visible — and it seeds value-estimation calibration.
7. Live ingestion begins; first classified messages appear within minutes. Voice-modeling sample replies are surfaced over the next 5–7 days.
8. Creator is prompted (contextually, after seeing their first high-value DM — not cold) to install the PWA and enable push notifications for high-value messages.
9. By day 7, voice fidelity should be high enough that drafted replies are usable with light edits.

**Onboarding success criteria:** creator closes their first deal logged in the Revenue Ledger within the first 14 days.

### 5.2 Daily triage (the main loop)

1. Creator opens DealDock — installable PWA / responsive web (no native app in pilot). Push notification on new high-estimated-value DMs is the primary re-entry point.
2. Top of screen: month-to-date "Revenue Recovered" card (org currency).
3. Below: Revenue Inbox, sorted by estimated value descending. Each row shows: classification badge (Brand / Coaching / Course / Other), estimated value range, sender handle, first-line preview, age of message, thread state.
4. Creator taps into a thread → sees full DM history + DealDock-drafted reply.
5. Creator approves, edits, or rewrites the draft → sends. Send happens via IG API; the message appears in IG as if sent normally.
6. After replying, creator can one-tap the thread into **Waiting on them** — it leaves the active queue without being forgotten.
7. Creator continues down the inbox until satisfied, or flips to Review Queue for uncertain classifications.

### 5.3 Following up (recovering deals from silence)

1. A thread marked **Waiting on them** that stays silent for N days (default 3, configurable) surfaces a nudge: *"@brand hasn't replied in 3 days — send a follow-up?"* with a voice-matched follow-up draft ready.
2. Creator approves/edits/sends, or dismisses (thread stays waiting), or closes the thread as dead.
3. Nudges appear in the inbox as a distinct row treatment and in the push digest — never auto-sent, like everything else.

### 5.4 Closing a deal

1. A thread that has progressed to "deal confirmed" gets a one-tap **Mark closed for [amount]** button at the top of the thread view.
2. Creator types or taps a number (org currency), optionally tags the deal type (brand / coaching / course / other), confirms.
3. Revenue Ledger updates immediately. Month-to-date Recovered Revenue tile reflects the new value.
4. The deal appears in the ledger with: date, sender, deal type, amount, and a link back to the thread.

### 5.5 Handling the review queue

1. Messages the classifier is uncertain about land in a separate Review Queue, never in the main Revenue Inbox.
2. Creator periodically clears the queue: a row shows the message, the system's best guess, and confidence level.
3. One tap to confirm the classification, one tap to override. The system learns from each correction.
4. Nothing in the Review Queue is auto-replied to, ever.

### 5.6 Roster manager journey (Studio / Roster tier)

1. Manager logs in and sees a roster overview: each creator on a row, with month-to-date recovered revenue, unread high-priority count, and review-queue size.
2. Tapping into a creator opens that creator's Revenue Inbox.
3. Manager can draft and send replies on the creator's behalf, with the creator's voice profile applied.
4. Per-creator monthly revenue reports are available as exports.
5. Audit trail logs which user (creator or manager) sent which reply, for accountability. Creators can see their own account's audit trail (trust posture).

### 5.7 Cancellation and data export

1. Creator goes to Settings → Subscription → Cancel.
2. No friction, no retention popups, no "are you sure" loops beyond a single confirmation.
3. On cancellation: subscription ends at end of current billing cycle. Revenue Ledger remains accessible read-only for 30 days.
4. Creator can export their full Revenue Ledger as CSV at any time, including post-cancellation.
5. After 30 days, all data is permanently deleted from our systems.

---

## 6. Functional requirements

Listed by feature area. Each item is something the product must do for the pilot to ship.

### 6.1 Account, region & Instagram connection

- Support OAuth connection for Instagram Business and Creator accounts via official Graph API.
- Detect and clearly message the user if they're on a Personal account (and explain how to switch — it takes ~2 minutes, and is free).
- Org-level **currency** (INR, USD, GBP, EUR, AED at minimum), **locale** (number formatting: lakh/crore for en-IN, K/M elsewhere), and **timezone** — set at onboarding, editable in Settings. All monetary displays, month boundaries, and digests respect these.
- Allow disconnect at any time. On disconnect, stop ingestion immediately.
- Support one IG account per user on Solo. Up to two seats (creator + one assistant) on Studio. Up to five connected IG accounts on Roster.

### 6.2 Message ingestion & classification

- Ingest incoming DMs in near-real-time after connection (target: a new DM appears in the Revenue Inbox within 60 seconds of arriving in IG).
- **Ingest the message-requests folder**, not just the primary inbox — that is where unknown-sender brand briefs land and where most of the leak lives (API permitting; any platform limitation is surfaced honestly in the UI).
- **Leak Scan:** at onboarding, backfill-classify the last 30 days of history and present the total estimated unactioned commerce value.
- Classify each incoming message into one of: **Brand Deal**, **Coaching Lead**, **Course Inquiry**, **Other Commerce** (paid services, consulting, etc.), **Fan Message**, **Spam / Low-quality**, **Personal**, **Uncertain**.
- For each classified message, generate an **estimated value range in the org currency** based on signal in the message, sender profile, and creator's historical deal-size context provided during onboarding.
- Anything classified as Uncertain (below confidence threshold) routes to the Review Queue, never to the main Revenue Inbox.
- Support **code-switched and multilingual messages without degrading classification accuracy**. For the India pilot, Hinglish/Hindi/English parity is the non-negotiable P0 bar; the eval framework must support per-market language slices (Spanish, Portuguese next) as we expand.
- **Audio/voice-note DMs (pilot):** detect and surface them in the inbox flagged as *"Voice note — needs your ear"* with sender context — never silently dropped. Transcription + classification of audio is V1.

### 6.3 Revenue Inbox

- Default sort: estimated value, descending.
- Secondary sort options: most recent, oldest unread, highest confidence.
- Filters: classification type, age (today / this week / older), unreplied only, **waiting on them**.
- Each row shows classification badge, estimated value, sender handle (with verified status if applicable), first line of message, message age, draft-ready indicator, thread-state chip (waiting/nudge).
- Tap into row → full thread view with DealDock-drafted reply at the bottom.

### 6.4 Voice modeling & reply drafting

- During onboarding, ingest a sample of the creator's recent sent DMs (with explicit consent) to model their voice.
- For every classified high-intent message, generate a draft reply that matches: typical greeting, sentence length, tone (formal/informal), signoff, and characteristic phrases.
- Drafts must adapt to message type: a brand brief reply is structured differently from a coaching enquiry reply. Follow-up nudge drafts are their own type (short, warm, non-pushy).
- Creator can edit drafts inline before sending.
- Track edit distance over time as a voice-fidelity metric.
- **Never auto-send.** Always requires creator (or authorised seat) approval — including follow-up nudges.

### 6.5 Thread states & follow-up nudges

- Thread states: **Open** (needs creator action) · **Waiting on them** (creator replied, counterparty silent) · **Closed** (deal closed via ledger, or dead).
- One-tap transition to Waiting after sending a reply.
- A Waiting thread silent for N days (default 3, configurable per org) generates a **nudge**: distinct inbox treatment + a drafted voice-matched follow-up. Dismiss, send, or close. Nudges respect the never-auto-send rule.
- Waiting threads are excluded from "unreplied" counts but never hidden — a dedicated filter shows them.

### 6.6 Review queue (human-in-the-loop)

- Separate inbox view for messages below the classification confidence threshold.
- Each row shows: message, system's best-guess classification, confidence level, and a one-tap accept/override.
- Overrides feed back into the classifier as labelled training data for the creator's account specifically.
- Review queue items never appear in the main Revenue Inbox until classified.

### 6.7 Revenue Ledger

- One-tap "Mark closed for [amount]" button on every thread (org currency).
- Closed deals captured with: date, sender, deal type, amount, link to thread.
- Month-to-date Recovered Revenue tile prominently displayed on dashboard.
- Historical view: month-by-month recovered totals, biggest single deal, average deal size, deal-type breakdown.
- Exportable as CSV at any time (amounts in org currency with currency code column).
- Closed deals can be edited or deleted by the creator (in case of mistakes or refunded deals).

### 6.8 Notifications (PWA + push + digest)

- Installable **PWA** (Android + iOS ≥16.4 + desktop). No native app in pilot.
- **Push notifications** — opt-in, requested contextually (after the creator first sees a high-value DM, never on first load): new high-estimated-value DM, nudge due, weekly summary. Quiet hours follow org timezone.
- Notification copy leads with money: *"New brand deal — est. ₹2L+"*.
- All notification types individually toggleable in Settings.

### 6.9 Reporting & analytics

- **Pilot scope:** monthly recovered revenue total, by-classification breakdown, top 10 deals of the month, voice-fidelity metric (% drafts sent without edit), classification accuracy (% review-queue items where the system's best guess was confirmed).
- **Roster tier:** per-creator reports rolled up into a roster-level dashboard.
- Out of scope for pilot: cohort comparisons, predictive forecasting, benchmarking against other DealDock users.

### 6.10 Multi-seat and multi-account (Studio & Roster)

- Studio: one connected IG account, two user seats (creator + assistant). Both can read and reply. Audit trail logs sender.
- Roster: up to five connected IG accounts under one organisation. One or more manager seats. Per-creator voice profiles. Per-creator revenue reports. Org-level view across all creators.

### 6.11 Settings & data controls

- View what data DealDock has stored.
- Export everything (DMs processed, classifications, drafts, ledger entries) as a single archive.
- Delete account → 7-day grace period, then permanent deletion.
- Toggle voice modeling on/off (some creators may want classification only, no drafting).
- Per-handle "ignore list" — accounts whose DMs should never be classified or drafted (close family, regular collaborators, the creator's own alt account).
- Region settings: currency (changing currency requires confirmation; historical ledger entries keep their logged amounts), locale, timezone, nudge-delay preference, notification toggles.

### 6.12 Billing & subscription

- Monthly subscription on all three tiers. No annual lock-in for pilot.
- **Dual-rail billing:** Razorpay (INR orgs — UPI Autopay, cards, netbanking) and **Paddle as merchant of record** (all other currencies — Paddle owns global sales tax/VAT/GST compliance). Rail selected automatically by org currency.
- First invoice does not run until the creator has been onboarded and used the product for one full week. (This is a trust mechanism, not a free trial — it's invoiced after the fact.)
- Upgrade/downgrade at any time. Cancel at any time, with no fee.
- Pilot members keep their pilot price as long as they remain subscribed. Post-pilot pricing applies only to new signups.

---

## 7. Non-functional requirements

### 7.1 Privacy and data handling

- DM content is processed for classification and drafting. It is **not** sold, **not** used to train public models, and **not** shared outside the user's account.
- All data encrypted in transit and at rest.
- Per-creator data isolation — no cross-creator data leakage in classification, drafting, or modeling.
- Privacy policy and data-handling FAQ given to every pilot member before onboarding.
- Global readiness: GDPR-shaped rights (access, export, deletion) are already product features (§6.11); DPDP (India) and GDPR (EU/UK) reviewed before V1 global open.

### 7.2 Account safety & API compliance

- Connection is via Meta's official Graph API only. No browser automation, no scraping, no unofficial workarounds.
- Sending replies happens through the same official channel.
- Rate limits and policy boundaries must be respected even if it means slower throughput.
- Zero tolerance for anything that puts a creator's IG account at policy risk.

### 7.3 Latency & responsiveness

- New DM → visible in Revenue Inbox: target under 60 seconds.
- Draft reply generation on-thread: target under 5 seconds.
- Dashboard load: target under 2 seconds on a typical Indian mobile connection (the toughest network profile we serve; global users inherit the benefit).

### 7.4 Accuracy benchmarks

- Classification accuracy: target ≥ 90% on the Brand / Coaching / Course / Fan / Spam top-level distinction by end of pilot, after personalisation.
- Voice fidelity: ≥ 70% of drafts sent with no edit or minor edit (defined as <20% character change).
- Review queue routing: any message below 80% confidence goes to review, not Revenue Inbox.
- Language parity: accuracy on code-switched messages within 3 points of English-only accuracy (Hinglish for pilot; per-market slices post-pilot).

(Benchmarks above are launch targets. Real numbers will be tracked from week 1 and surfaced internally on a weekly dashboard.)

### 7.5 Audit trail

- Every reply sent is logged with: timestamp, sender (creator or assistant), original draft, final sent text, edit distance.
- Exportable on request.

### 7.6 Reliability

- Target uptime in pilot: 99.5% during each org's local business hours (8am–11pm org timezone), 99% overall.
- DM ingestion must self-heal from API outages — no permanently lost messages on the IG side.

---

## 8. Pricing & packaging

| Tier | ₹/month (pilot, INR orgs) | $/month (international) | Connected IG accounts | User seats | Notable extras |
|---|---|---|---|---|---|
| Solo | ₹4,000 | $49 | 1 | 1 (creator) | Full Revenue Inbox, voice drafting, Revenue Ledger, Leak Scan, nudges |
| Studio | ₹8,000 | $99 | 1 | 2 (creator + assistant) | Priority review queue, audit trail by seat |
| Roster | ₹15,000 | $179 | Up to 5 | Multiple manager seats | Per-creator voice profiles, per-creator + roster-level reports, direct line to founding team |

**Pilot terms:** monthly only, cancel anytime, no setup fee, first invoice runs after one full week of active use. Pilot members retain pilot pricing as long as they remain subscribed. International pricing exists in pilot for validation orgs; global GTM opens at V1.

**Post-pilot:** prices increase. Existing pilot members are grandfathered in. Annual billing option may be introduced.

---

## 9. Phasing

### V0 — Pilot (current scope of this PRD)

Capped cohort, India-weighted. Manual onboarding by founding team. Instagram only. All three tiers available but Roster offered selectively. Installable PWA (responsive web + push). No public signup. Product fully global-ready (currency/locale/billing rails proven with ≥1 non-INR org).

### V1 — Open beta (post-pilot)

Self-serve global signup (gated by qualifying questionnaire). Onboarding partly automated, with optional human onboarding call. Pricing moves to post-pilot rates for new signups. **V1 feature backlog:** weekly digest email, rate-card quick-insert in composer, monthly "leak report" (quantified missed value), audio-DM transcription + classification, multi-currency conversion consideration, Postgres RLS hardening.

### V2 — Second platforms

**WhatsApp Business** (India wedge) + **email integration** (global wedge — internationally, deals start in DMs but close over email). Unified Revenue Inbox across platforms. Cross-platform thread linking when the same lead messages on both.

### V3 — Roster as a real product surface

Stronger multi-account UX, agency-billing options, white-label considerations, cross-creator analytics, deal benchmarking ("typical range for creators your size") once data volume supports it.

### Beyond

Other platforms (LinkedIn DMs for B2B coaches, etc.) evaluated based on demand. Autonomous-reply mode considered only for clearly low-stakes message classes, opt-in only.

---

## 10. Risks and open questions

### 10.1 Top risks

1. **Meta API policy changes.** If Meta restricts third-party DM access, the product is materially affected. Mitigation: stay on official APIs, build the WhatsApp/email tracks early, watch policy changes weekly.
2. **Classification accuracy on code-switched messages.** Indian DMs are heavily Hinglish; other markets bring their own mixing. Underperformance here breaks the entire promise. Mitigation: pilot cohort weighted toward creators with Hinglish-heavy inboxes; per-market eval slices; treat this as a P0 quality bar.
3. **Voice-modeling cold start.** Until we have a few weeks of approved drafts, drafts may feel generic and creators may disengage. Mitigation: heavy onboarding-call investment; Leak Scan delivers immediate value before voice matters; explicit messaging that the first 5–7 days are voice-tuning.
4. **Misclassification reputational risk.** A brand brief routed to the fan folder, or a fan auto-flagged as a deal, can damage trust with the creator's audience. Mitigation: review queue is the default for anything uncertain; nothing auto-sends.
5. **Attribution under-counting.** If creators don't log closed deals, recovered-revenue numbers look smaller than reality and the product appears less valuable than it is. Mitigation: make close-out a one-tap action; nudge gently when threads look like they've concluded; surface attribution prominently on the dashboard.
6. **Native-platform encroachment.** Instagram's built-in sorting/Meta AI keeps improving; Meta is testing paid creator subscriptions. Mitigation: differentiate on what platform AI structurally won't do — cross-thread value estimation, personal voice, longitudinal revenue ledger. Watch quarterly.
7. **Meta rate limits.** Messaging API budgets are tight. Mitigation: webhook-first ingestion, budgeted fetches, queue-don't-drop (see ARCHITECTURE.md).

### 10.2 Open questions to resolve before V1

- ~~Is there a "snooze until reply" state?~~ **Resolved v1.1:** yes — "Waiting on them" state with nudges (§6.5).
- Should Reels-DM and Story-reply messages be ingested into the same Revenue Inbox, or kept separate? (Different intent shape.) — leaning: same inbox, tagged `source`, filterable.
- How do we handle group DMs? — leaning: ingest + classify, default-filtered out; commerce-labelled group messages surface.
- For the Roster tier, do creators get visibility into what their manager is sending? — **Resolved v1.1:** yes, creators see their own audit trail (§5.6).
- How aggressive should onboarding "ignore list" defaults be? — leaning: conservative; suggest candidates from top-DM'd handles during onboarding.
- Nudge etiquette by market: is a 3-day default right everywhere, or does it need per-market defaults (e.g., faster for brand briefs, slower for coaching)?
- Do we ever support a "one-step-removed" autonomous mode for clearly unambiguous fan replies? — post-pilot, opt-in, low-stakes only; never in pilot.

---

## 11. Success metrics

### 11.1 North-star metric

**Total monthly Recovered Revenue per active creator**, attributed via Revenue Ledger close-outs. (Reported per-org in org currency; aggregated internally USD-normalized at a fixed monthly rate for cross-cohort comparison.)

### 11.2 Supporting product metrics

- Activation: % of onboarded creators who log their first closed deal within 14 days.
- **Leak Scan impact:** % of onboardings where Leak Scan finds ≥1 actionable commerce thread (target: near 100% for well-qualified cohort — it validates targeting).
- Engagement: weekly active creators, daily inbox-open rate, push opt-in rate.
- Voice fidelity: % of drafts sent with no/minor edits.
- Classification accuracy: % of review-queue items where best guess was confirmed.
- Review-queue clearance time: average age of a queued message before classification.
- Time-to-first-reply on high-value threads: median, week-over-week (the 24-hour window is the market reality everywhere).
- **Nudge conversion:** % of sent follow-up nudges that get a counterparty reply within 7 days.

### 11.3 Business metrics

- Pilot → paid conversion rate (% of pilot members who continue past first paid month).
- Monthly churn rate.
- Net revenue retention (especially as creators move Solo → Studio → Roster).
- Cost per onboarded creator (during pilot's high-touch phase).

---

## 12. Out of scope (do not build, even if asked)

A short list, kept here so it stays in the team's peripheral vision:

- Public API for third-party integrations.
- Mobile native apps (iOS/Android). Installable PWA + responsive web is the pilot surface.
- Team chat / internal commenting on threads.
- Scheduled-send for replies.
- Contracts, e-signing, invoicing, or payment collection.
- Media-kit or rate-card **builders** (a private rate card as draft context is V1; public-facing kits never).
- Integrations with calendar tools for booking calls (the creator can paste their existing booking link into a draft).
- AI-generated content suggestions for IG posts.
- Audience analytics or follower insights.
- Bulk outbound DM tools (firm no — wedge-incorrect and reputation-risky).
- A Chrome extension or a "DealDock floats over Instagram" overlay. Out of scope and adds policy risk.

---

## 13. Glossary

- **Revenue Inbox** — the primary view of high-intent DMs sorted by estimated monetary value.
- **Revenue Ledger** — the running record of closed deals attributed to DealDock-surfaced threads.
- **Recovered Revenue** — the total of closed deals from Revenue-Inbox-surfaced threads in a given period, in org currency.
- **Leak Scan** — the onboarding backfill classification of the last 30 days showing the value of unactioned commerce DMs.
- **Review Queue** — the secondary view for messages below the classification confidence threshold, awaiting human confirmation.
- **Waiting on them** — thread state for conversations awaiting the counterparty; source of follow-up nudges.
- **Nudge** — a drafted, never-auto-sent follow-up suggested when a Waiting thread goes silent.
- **Voice profile** — a per-creator model of writing style used to generate drafts.
- **Org currency** — the single currency an organization operates in; all estimates, ledger entries, and billing follow it.
- **Wedge** — the deliberately narrow primary audience and use case (pilot: Indian Instagram-driven commerce creators; V1: same shape globally).

— end of PRD v1.1 —
