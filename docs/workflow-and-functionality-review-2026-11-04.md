# Workflow and functionality review, 4 November 2026

This review covers four things:

- what confused or repeated itself in the running app, and what was changed;
- what the free Groq key can and cannot tell us about model quality;
- how creators, coaches and agencies actually run deals with brands, from the first DM to payment and the next deal;
- what DealDock should build next.

**How the plan was made:** it follows real creator problems, not the older PRD's scope limits. The owner confirmed on 4 November that the PRD is out of date. Two rules still hold for everything below:

- every outbound message is a draft that a person approves;
- money is stored in integer minor units.

**How it was checked:**

- I used the fictional demo app on `127.0.0.1:3100` at desktop and phone widths.
- Model tests used the free Groq key with synthetic messages only.
- The workflow research is web research. Its key figures were spot-checked against the original articles, and the sources are linked inline. Figures from vendors selling a fix for the problem they describe are marked as vendor figures.

## Decisions for you

1. **Build order.** I recommend Phase 1 first: carry a deal from the "yes" to the money. Getting paid is the best-evidenced creator pain, and DealDock currently stops at the yes.
2. **Track money or move it.** I recommend that DealDock tracks payments and puts the creator's own UPI ID or payment link on invoices, without holding funds. Collecting payments would make DealDock a payment intermediary, with the licensing, KYC and fee questions that brings.
3. **Invoices: India first?** GST invoices, TDS and export-under-LUT rules are specific to India. I recommend India-format invoices first and a plain invoice everywhere else, with a chartered accountant reviewing the India fields before launch.
4. **The same queue on two screens.** On agency plans, Today's "Needs you" and All creators' "Biggest first, across every creator" show the same list. DESIGN.md specifies both, so neither was removed. My recommendation is to keep the queue on Today and make All creators about each creator's status.
5. **Cloned-voice replies in India.** Since 20 February 2026, India's IT Rules require a "prominently prefixed audio disclosure" on synthetic audio ([MeitY FAQ](https://www.meity.gov.in/static/uploads/2025/10/065b6deb585441b5ccdf8be42502a49c.pdf), [Khaitan & Co](https://www.khaitanco.com/thought-leadership/MeitY-notifies-the-IT-Amendment-Rules-2026)). DealDock currently discloses in a separate, best-effort text message, which is probably not enough. Keep audio sends gated, add a spoken prefix to the clip, and get legal review before any Indian creator uses it.

## Build status

The plan is built in full, one phase at a time, and each phase is checked before the next starts. On 4 November the owner paused phases 2 to 4 until the "Start now" items and phase 1 are finished. On screen, each feature shows one clear next step and keeps details behind disclosures. Agency features appear only on Roster plans.

| Phase | Item | What gets built | Status |
| --- | --- | --- | --- |
| Start now | Scam check | Rules for fee requests, outside logins, locked files, and outside links or apps together. A flagged message gets a warning, no money estimate and no auto-draft, and goes to Check. A policy-model check follows on the paid provider. | Built |
| Start now | Voice disclosure | The disclosure is spoken at the start of the clip, and a missing disclosure fails the send. | Built |
| Start now | What you sell per creator | Each creator has their own profile and prices for estimates and drafts. Roster plans pick a creator; solo creators see no change. | Built |
| Start now | Paid model | Both quality gates run on the paid provider. | OpenAI `gpt-6-luna` configured. The 258-case classification gate passes (97.7% exact, course enquiries 96.4%). The blind draft review is still to run. |
| 1 | Yes to paid | Record a deal (paid now or later), fill it from the chat, terms recap, deliverables, ask for payment, reminders, mark paid with TDS. | Built |
| 1 | Invoices | PDF invoices from a deal: GST, LUT for foreign brands, the creator's tax IDs and UPI or bank details. Sent in the DM, by email, or shared. | Built |
| 1 | Advance requests | An advance invoice, and a reminder not to start before it lands. | Built |
| 1 | Deals outside Instagram | Record a deal with no conversation. | Built |
| 3 | Email | A Gmail inbox per creator, push sync with a polling fallback, attachments, and threaded replies after approval. WhatsApp and TikTok use the same channel seam later. | Built |
| 2 | Rate-card extras | Add-on prices for usage, partnership ads, exclusivity, extra revisions and rush, quoted in drafts, plus a private rate-card link. | Built (21 Nov) |
| 2 | Usage and exclusivity | Expiry reminders, and a warning when a competing brand pitches during an exclusivity window. | Built (21 Nov) |
| 2 | Proof of results | Post insights about seven days after posting, plus a disclosure checklist, attached when asking for payment. Insights need a Meta permission, so links come first. | Built (21 Nov) |
| 3 | Renewals | A prompt to pitch past clients again, drafted for approval. | Built (21 Nov) |
| 3 | Coach pipeline | Lead, qualified, booked and paid stages, with booking and payment links reporting back. | Built (21 Nov) |
| 3 | Comment leads | Keyword commenters with drafted private replies, each approved separately. Needs a Meta permission. | Built (21 Nov) |
| 3 | WhatsApp, TikTok | The same channel seam as email. | Later: after phase 1 is finished |
| 4 | Agency money | Commission per deal, payouts to creators and creator statements, on Roster plans only. | Later: after phase 1 is finished |
| 4 | Tax records (India) | Financial-year turnover against the GST threshold, a barter log, and a TDS reconciliation CSV. | Later: after phase 1 is finished |

## 1. Functional review: what changed

These changes are on `codex/ui-polish-local`, uncommitted. The full browser gate and targeted reruns are recorded in [the polish review](ui-polish-review-2026-11-01.md#verification-4-november).

| Where | What confused or repeated | Change |
| --- | --- | --- |
| Inbox tabs | Follow-ups were also counted under Waiting, so "Follow-ups 2 · Waiting 4" described four conversations, not six. | Each conversation is now in exactly one tab. Waiting means "their move, follow-up not due"; when a conversation goes quiet it moves to Follow-ups. The empty Waiting view says so. |
| Inbox tabs | The order mixed your-move and their-move views. A separate "Check N" pill sat in the header. | Order is now Needs you, Follow-ups, Check, Waiting, Closed. The Check view has one "Sort them one at a time" banner that keeps the creator filter. |
| Settings | What you sell and usual prices could only be set during onboarding. | New "What you sell" section and editor. It explains that these prices drive estimates, while drafts quote the exact prices in Offers (linked). |
| Command palette | "Pause learning" and "Resume learning" were both always listed and did not say which creator they applied to. Names differed from the sidebar. | One "Pause or resume learning…" item opens the Voice switch for the current creator. "Roster" became "All creators". "Export revenue CSV" became "Export all revenue (CSV)", to tell it apart from Revenue's filtered export. |
| Voice | Writing-style fine-tuning sat above the evidence of what was learned. Links to a section did not scroll. | Fine-tuning is a closing disclosure. `/voice#learning` and other anchors scroll once the page loads. |
| Today | The voice statistic repeated a row. | One link to Voice. |
| Demo | Pausing learning paused every creator, unlike the API. The demo profile's offerings did not match the onboarding choices. | The pause is per creator. The profile uses onboarding's choices. |

**Reviewed and kept, because each one does a different job:**

- **Offers and What you sell.** Offers holds exact prices that drafts quote. What you sell holds the usual prices that classification and estimates use.
- **Three exports.** Revenue's export follows the filters on screen. The palette's export covers all revenue. Settings' data export covers the whole account, for privacy requests. The labels now say which is which.
- **The Check view and the Review screen.** Check is a list; Review sorts the same items one at a time. Check links to Review.

**Still open:**

- Decision 4 above.
- Voice is the longest screen, with seven sections. Moving the speaking-voice setup to its own screen would shorten it; that can wait until speaking voice is enabled.

## 2. Model check with the free Groq key

The free key is a stand-in for testing; a paid model replaces it later. Switching is configuration: `AI_PROVIDER`, plus the model variables in [the provider guide](groq-provider.md). Before the pilot, the paid model must pass two gates: the 258-case classification gate and the blind 50-draft review. Nothing in the product was tuned to free-plan limits.

| Model on this key | Classification, 16 synthetic cases | Drafts, 5 probes | Use |
| --- | --- | --- | --- |
| `openai/gpt-oss-120b` | 13/16 | 2 completed, both with exact prices in the right voice; the rest hit the 8,000 tokens-per-minute limit | Default for testing. Production-listed. |
| `openai/gpt-oss-20b` | 14/16, but labelled an English spam message a brand deal | All rate-limited | Not better than 120B. |
| `qwen/qwen3.8-27b` | 13/14 completed | 5/5: exact prices, no invented price, ignored an instruction planted in the message, flagged unknown terms | Useful for local draft testing. Groq lists it as preview, for evaluation only. |
| `openai/gpt-oss-safeguard-20b` with a written scam policy | 34/35 spam versus brand-deal cases | n/a | Strong candidate for the scam check. The main classifier scored 70% on spam in the earlier 258-case run. |

The key also offers Whisper (transcription) and Prompt Guard (injection screening). DealDock already transcribes voice notes when a speech provider is configured, so Whisper would only be a cheaper test adapter. Details are in the [4 November evidence](groq-provider.md#local-evidence-4-november-2026).

## 3. How brand deals actually run

| Stage | What goes wrong (evidence) | DealDock today |
| --- | --- | --- |
| First contact: DM, email, marketplace, Instagram's Partnership messages folder | Brand messages get buried, and Instagram built a priority folder for that reason ([TechCrunch](https://techcrunch.com/2021/10/22/instagram-rolls-out-new-tools-for-creators-to-collaborate-and-partner-with-brands/)). Fake sponsors use deal offers to phish creators ([ESET via Help Net Security](https://www.helpnetsecurity.com/2026/10/08/scams-targeting-youtube-creators-sponsorship/), [Bitdefender](https://www.bitdefender.com/en-us/blog/hotforsecurity/fake-job-collab-instagram)). | Classifies, estimates, ingests Requests and puts the biggest first. Scams get no special handling. |
| Negotiation | 37% of creators guessed their first rates ([Adweek](https://www.adweek.com/media/pricing-for-the-creator-economy-is-all-over-the-map/)). 45% of brand marketers say they have mispriced creator fees ([Billion Dollar Boy via Net Influencer](https://www.netinfluencer.com/nearly-half-of-brands-have-mispriced-creator-deals-survey-finds/)). Usage rights, partnership ads and exclusivity are priced separately. | Offers give drafts exact prices. No add-on prices. |
| Terms and brief | Indian creators report "no standard contracts or payment norms" ([The Nod](https://thenodmag.com/content/indian-content-creator-influencer-economy-struggles)). Disputes start from terms nobody wrote down. | Nothing after the reply. |
| Drafts and revisions | Unlimited revision rounds; a two-round cap is common practice. Drafts are due about five business days before posting. | Nothing. |
| Posting, disclosure, reporting | ASCI disclosure rules make both brand and creator liable. Reports "land weeks later after a scramble through screenshots", and brands often want them before they pay. | Nothing. |
| Invoicing and payment | 41% of creators call payment delays their biggest pain with brands ([eMarketer](https://www.emarketer.com/content/marketers-face-challenges-compensating-creators), citing Influencer × Crowd DNA, March 2025). In India the official 90-day cycle starts only after an audit, and creators now ask for 25–50% advances ([Storyboard18](https://www.storyboard18.com/brand-makers/payment-delays-plague-influencer-marketing-agencies-as-major-brands-lag-behind-77033.htm)). | Revenue records confirmed money only, and only from a DM thread. |
| Repeat deals | 63% of brand–creator relationships are one-off ([TIMF/Modash](https://theinfluencermarketingfactory.com/brand-deals-analysis/)). | Nothing prompts a second deal. |

**Coaches and course sellers.** The usual path:

1. A post or story brings a DM.
2. They ask two or three qualifying questions.
3. They send a booking or payment link.
4. They follow up from memory or a spreadsheet.

Most of the evidence here comes from vendors. DealDock covers the reply, the price, the link (Offers has a link field) and the nudge. It does not cover the steps after the link.

**Talent managers and small agencies.**

- They price each creator separately and take a 15–25% commission.
- They watch exclusivity across the roster and still run much of this in spreadsheets.
- DealDock gives each creator a separate voice and offers, but one shared business profile.

**Instagram constraints that shape the plan:**

- **Reply windows.** Brands must message first. The standard reply window is 24 hours. The 7-day Human Agent tag needs App Review. After the window, replies happen in the Instagram app, and DealDock already shows countdowns and that handoff.
- **Payment chasing.** Payment is usually due 30 to 90 days after the last message, so the DM window is almost always closed by then. Invoices and reminders need copy-to-Instagram, sharing and email paths from the start.
- **History.** The API returns only the latest 20 or so messages per conversation, and DealDock's adapter already accounts for this.
- **Attachments.** Instagram Login apps can send PDF attachments, which a DM-delivered invoice depends on. Test this on a real account.
- **Meta's own auto-replies.** Meta Business Agent and Creator AI send automatically. DealDock differs by putting a person in charge of every send and by following the money.

**Competitors.** [Ginger](https://gingerforcreators.com/) drafts deal replies for approval at $29/month. Gmail is live there, and Instagram DMs are "coming soon". Nobody I found carries a deal from an Instagram DM through to payment.

## 4. Plan

Effort: **S** is a few days, **M** is one to two weeks, **L** is longer.

### The core change: a deal that starts in the DM

Today a conversation is open, waiting or closed, and Revenue records confirmed money. Most of what goes wrong for creators happens after the yes. A **deal** record carries one agreement from the DM to the money:

```
Agreed ──► Delivering ──► Invoiced ──► Paid
                              │
                              └──► Overdue (due date passed) ──► Paid
```

A deal holds:

- the brand, the creator account and the conversation (optional, for deals that closed elsewhere);
- the fee and currency;
- deliverables with due dates;
- usage rights and exclusivity, and how many revisions are included;
- payment terms: the advance and the days to pay;
- its invoices and payments.

Revenue then shows money agreed, invoiced, overdue and received. Existing ledger entries become paid deals.

### Start now: small, independent, high impact

1. **Scam check before money estimates.** S–M.
   - **Detect:** messages that ask for a fee, deposit or registration; outside login or "collaboration platform" links; password-protected files; or a move to WhatsApp or Telegram with no named brand, product or deliverable.
   - **Respond:** show "Possible scam: they're asking you to pay", skip the money estimate and never draft an acceptance. Unsure cases go to Check.
   - **How:** start with these rules, then test the policy-plus-small-model check (34/35 above) on the paid provider.
   - **Done when:** spam accuracy reaches 85% with no drop in brand-deal recall.
2. **Synthetic voice disclosure** (decision 5). S, plus legal review.
3. **What you sell for each creator.** M. Agencies price each creator differently, and this is already an engineering gate in [pending work](../pending.md).
4. **Paid model choice.** Configuration, plus evaluation runs.

### Phase 1: from yes to paid

5. **Mark agreed, with a deal memo.** M.
   - When a brand agrees, or DealDock notices the agreement and suggests it, the AI fills a memo from the conversation: deliverables, dates, fee, usage, exclusivity, revisions and payment terms.
   - Anything not agreed is flagged.
   - The creator edits the memo before saving.
6. **Terms recap message.** S, after item 5.
   - A draft in the creator's voice restates the memo.
   - The creator approves and sends it in the DM. The brand's reply is attached to the deal.
   - This is the written record that disputes need.
7. **Deliverables and due dates.** S–M.
   - A checklist per deal, with reminders on Today ("Reel for @brand due Friday").
   - Drafts for "here's the draft for review" and "it's live, here's the link".
   - When the brand asks for more revision rounds than agreed, DealDock drafts the extra-round price.
8. **Invoices.** M.
   - DealDock generates a PDF from the deal. It includes the creator's legal name, PAN, GSTIN when registered, Udyam number when they have one, and UPI or bank details. It also includes the brand's billing details and the due date.
   - GST is charged at 18% when the creator is registered. Foreign brands get an export invoice under LUT.
   - Billing details are set once in Settings.
   - Send the invoice as a PDF in the DM while the reply window is open; otherwise share or email it.
9. **Money owed and reminders.** M.
   - Today and Revenue show what is owed, what is overdue and what has arrived.
   - When a due date passes, DealDock drafts a reminder: polite first, firmer later. It is ready to copy into Instagram or send by email, because the DM window has usually closed.
   - "Mark paid" records what actually arrived, including any TDS deducted, so totals match the bank. Overdue money triggers a push alert.
10. **Advance requests.** S, with item 8. Terms can include a 25–50% advance. DealDock drafts the advance invoice and reminds the creator before work starts.
11. **Deals that closed outside Instagram.** S. Record a deal from email or WhatsApp without a DM conversation. The deletion rules in the schema comments must keep working.

### Phase 2: better prices, protected rights, faster payment

12. **Rate card with add-ons.** S–M.
    - Offers gain optional prices for usage rights (per month), partnership ads, category exclusivity, an extra revision round and rush delivery.
    - Drafts quote them only when they are set; otherwise they are flagged as missing.
    - A private rate-card link lets the creator answer "send your rates" in one tap.
13. **Usage rights and exclusivity.** M.
    - Reminders before usage rights expire ("Brand's ad rights on your reel end 3 March: renew or stop").
    - A warning when a competing brand pitches during an exclusivity window.
14. **Proof pack.** M.
    - About seven days after posting, pull post insights through the Instagram Insights API and add a disclosure checklist.
    - Attach both to the invoice, since many brands want the report before they pay.

### Phase 3: repeat business and more channels

15. **Renewal prompts.**
    - Suggest pitching again N days after payment, or before October–December, when 29–31% of deals happen.
    - Usually the window has closed, so the pitch is copied into Instagram or sent by email.
16. **Email, then WhatsApp.**
    - A forwarding address is the cheap first step for briefs, contracts and invoices sent by email.
    - Full Gmail access needs Google's annual security assessment.
17. **Coach pipeline.**
    - Stages: lead, qualified, booked, paid.
    - Booking links (Calendly, Topmate) and payment links (Razorpay, Stripe, UPI) report back, so DealDock moves the stage and suggests "Record a sale".
18. **Comment leads.**
    - Commenters who use a keyword are listed with drafted private replies: one per commenter, within seven days of the comment.
    - Each reply is approved individually.

### Phase 4: agencies and tax

19. **Agency money.** Commission per deal, payouts to creators and a statement for each creator.
20. **Tax-ready records.**
    - Financial-year turnover against the GST registration threshold, counting gifted products and exports.
    - A barter log that warns when one brand's gifts pass ₹20,000 in a year, the TDS threshold for gifted products.
    - A TDS reconciliation CSV for the creator's accountant.
    - A chartered accountant must review it, because Indian tax sections were renumbered in April 2026.

### What stays out

- **Anything that sends automatically.** This covers keyword auto-DMs that fire instantly and "autopilot" replies.
- Every item above drafts for approval, which is DealDock's difference from ManyChat-style tools and from Meta's own auto-replies.

### How Phase 1 fits the code

- **New tables:** Deal, Deliverable, Invoice and Payment, in `packages/db`. `LedgerEntry` rows migrate to paid deals, and money stays in integer minor units.
- **Drafts:** extend the drafting pipeline with new kinds (terms recap, delivery, invoice cover note, payment reminder) and a terms-extraction step. Unknown facts are flagged, as offer prices are today.
- **Sending:** keep today's approve-and-send path. Attachments, reply-window checks and the Instagram handoff already exist and must also cover invoice PDFs.
- **Demo:** the demo store needs the same deal flow so it stays usable without a database.

## 5. To verify with Meta and advisors

- **Partnership messages folder.** Whether conversations in it reach a creator-side Instagram Login app at all. Test with a real account.
- **Human Agent tag.** Whether replies that a person approves, but AI drafted, qualify for it. Settle this in App Review.
- **PDF attachments.** Whether sending one by API works for creator accounts, and how it appears to the brand.
- **Indian tax and invoice fields.** Section numbers moved into s.393 of the Income-tax Act 2025 from 1 April 2026. A chartered accountant should review invoice fields and TDS handling before they ship.
- **Synthetic audio.** Legal review of the audio disclosure (decision 5).

## 6. What this review did not cover

- Real Instagram, Clerk, billing, push and speech-provider behaviour. These need accounts and are listed in [pending work](../pending.md).
- Real creator messages. All model tests used synthetic text, and the 16-case comparisons are diagnostics, not quality gates.
- Hands-on trials of competitor products. Their positioning comes from their public pages.
- Some research figures. Several come from vendors, and some original reports were paywalled; those are cited through the articles that quote them.

## Phase 1 verification, 5 November

The "Start now" items, phase 1 and email are built. Phases 2 to 4 are paused at the owner's request. Everything below ran on the final code, locally. Everything is uncommitted on `codex/ui-polish-local`.

- **Typecheck:** 15/15 tasks.
- **Lint:** architecture boundaries pass, boundary-rule tests 16/16, runtime safety 6/6.
- **Unit tests:**

  | Package | Passed |
  |---|---|
  | core | 303 |
  | speech | 41 |
  | billing | 10 |
  | web | 122 |
  | db | 35 |
  | messaging | 76 |
  | ai | 165 |
  | api | 13 |
  | worker | 11 |

  Turbo ran 15/15 tasks. The web suite's ledger-route test used to time out at 5 seconds on a cold start, because it loads the whole API route module. It now has a 30-second limit.
- **Database integration:** all 10 suites passed (61 tests) on an embedded Postgres with every migration applied in order. That server runs one session at a time, so locking and race paths still need a real Postgres run (listed in [pending work](../pending.md)).
- **Production build:** 9/9 tasks.
- **Demo UI gate:** 91 passed, 1 skipped (the phone-only check on the desktop project). This covers both themes, desktop and Pixel 7, and WCAG 2 A/AA scans. The new specs cover deals, email and safety, and invoices.
- **Screenshots:** today, conversation, record sheet, email conversation, scam warning, create invoice and invoice preview, at desktop and phone width, light and dark. All reviewed against DESIGN.md.

**Not verified here:**

- Real Instagram, Gmail, Clerk, billing and speech-provider accounts.
- Instagram PDF file messages.
- Real-model quality: the free Groq key is a stand-in.
- Concurrency on a real Postgres.

Chartered-accountant, legal and account gates are listed in [pending work](../pending.md).

## Phase 2 and 3 verification, 21 November

Built: rate-card add-ons and the private rate-card link, usage-rights and exclusivity reminders, proof of results, renewals, the coach pipeline (stages, plus Calendly, Cal.com, Razorpay, Stripe and "other" tools reporting back) and comment leads. WhatsApp and TikTok are not built; their scopes, steps and blockers are in [the go-live checklist](go-live-2026-11-07.md). Everything is uncommitted on `codex/ui-polish-local`.

- **Typecheck, lint and boundary rules:** pass.
- **Unit tests:** core 346, ai 195, web 153, messaging 93, api 55, speech 41, db 37, worker 14, billing 10.
- **Database integration on embedded Postgres, with every migration applied:** 106/106.
- **Browser gate (demo, desktop and phone):** 104 passed on the full run. The 7 failures were three older checks that predated the new features, each on two screen sizes, plus one phone check that timed out while the dev server reloaded. After fixing the checks, targeted reruns of every affected spec pass.
- **Build:** 9/9. **Safety and production sign-in tests:** 6/6.
- **Design change:** with Comments shown, the inbox's six view tabs scroll sideways on the desk, as they already did on phones. Creators without comment keywords see five tabs that fit.
- **Behind switches until Meta approves:** comment leads (`META_COMMENTS_ENABLED`) and fetching post results (`META_INSIGHTS_ENABLED`).
- **Not tested live:** provider webhooks (Calendly, Cal.com, Razorpay, Stripe), Instagram comment webhooks and private replies, and Instagram insights. Each needs a real account.
