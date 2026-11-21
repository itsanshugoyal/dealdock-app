# Go-to-market plan, 7 November 2026

How DealDock should price, offer and launch to its first creators and agencies. This is web research checked on 7 November 2026. Most statistics come from vendors and are marked as such, and none of it is legal advice.

## Summary: what to do, in order

1. **This week, start Meta Business Verification and add a tester agreement to the pilot terms.**
   - Verification raises Meta's tester cap from 50 to 500, and Advanced Access requires it.
   - Meta only lets you add someone as a tester if they are your employee or have signed an agreement to test on your behalf.
2. **Show prices publicly now.**
   - Solo: ₹4,000 + GST. Studio: ₹8,000 + GST. Label both "founding price, locked while you stay subscribed".
   - Roster: "from ₹15,000 + GST, talk to us".
   - Every comparable creator tool shows its creator prices; only agency and enterprise tiers hide them.
3. **Replace "Apply for the pilot" with "Get my free Leak Scan"**, and say "founding members" instead of "pilot". Keep the short form: it still qualifies people.
4. **Public offer:** a free scan, the first bill only after one full week of use, and cancel anytime. Don't take a UPI or card mandate before the first bill; send the subscription link on day 7.
5. **Before Meta approval, run 5–10 tester creators free under the tester agreement.** Get a written commitment from each to subscribe at the founding price once the app is live. Charge everyone who joins after Advanced Access.
6. **First 10 customers, through founder-led outreach in this order:**
   - warm introductions;
   - small talent agencies;
   - creators' business emails and WhatsApp;
   - Instagram DMs last, only after engaging with their content, at no more than 10–20 a day, written by hand and without links.
7. **From 10 to 50:** referrals, consented case studies at day 30, founder content, and webinars with coach communities. Push fitness coaches before January.
8. **Open self-serve signup only when all of these are true:**
   - Meta Advanced Access is granted;
   - Razorpay is live;
   - 30–50 creators are paying;
   - month-2 paid retention is 80% or more;
   - at least 5 case studies with real numbers exist.

## 0. Constraints that shape everything

**Meta (Instagram)**
- **Testers only before App Review.** The app can serve only accounts that have a role on it, through tester invites the creator accepts in Instagram settings. The cap is 50 testers, or 500 once the business is verified ([Meta app roles](https://developers.facebook.com/documentation/development/build-and-test/app-roles)).
- **Advanced Access** needs App Review, one successful API call and a screencast ([Meta App Review](https://developers.facebook.com/documentation/instagram-platform/app-review)).
- **Risk to test first.** Meta's docs say "Apps with Standard Access can only send messages to people that have a role on the app" ([messaging API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api)).
  - If that holds, testers can read and draft replies, but replies to their real fans and brands must be copied and sent from Instagram itself.
  - Check this on one real tester account before promising anything.
- **Promise follow-up reminders, not replies at any time.**
  - Messages from non-followers land in Requests.
  - Requests idle for more than 30 days are not returned by the API.
  - Replies after 24 hours need the Human Agent tag, which allows 7 days and needs separate approval.
- **Review time.** Third-party reports put each review round at about 10–20 days; plan for one resubmission ([example](https://singhamandeep.com/instagram-messaging-api-approval-getting-instagram_business_manage_messages-2026/)).

**Google (Gmail)**
- `gmail.readonly` and `gmail.send` are restricted scopes.
- **In Testing:** at most 100 listed test users, whose access expires every 7 days.
- **Published without verification:** a lifetime cap of 100 users, plus a warning screen.
- **Full verification** needs a yearly CASA security assessment, reported to take 2–6 months ([Unipile](https://www.unipile.com/google-oauth-100-user-limit/)).
- Either start verification now, or keep Gmail invite-only and leave it out of the launch promise.

**Market size**
- BCG counts 2–2.5 million Indian creators with more than 1,000 followers. Only 8–10% monetise effectively, and many earn under ₹18,000 a month ([PIB/BCG, May 2025](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2126106&reg=48&lang=2)).
- Creators earning ₹4L or more a month are therefore a thin slice. DealDock needs a named list of a few hundred accounts, not broad marketing. That conclusion is ours, drawn from BCG's figures.

## 1. Should prices be public?

Creator-tool pricing, checked on 7 November 2026. "Read directly" means the vendor's own page was read; the others come from third-party reviews because the vendor pages blocked access.

| Tool | Price public? | Pricing | Main call to action |
|---|---|---|---|
| Topmate (read directly) | Yes | 10% of sales through your own link, 20% through Topmate's marketplace, custom pricing above ₹10L a month. Auto DM: ₹399, ₹999, or ₹2,999 a month for its "Agentic" tier | Sign up; "Contact sales" for large creators |
| Exly (read directly) | Yes | Free plus 10%; Pro ₹2,500 a month plus 6%; Premium ₹9,000 a month plus 3%; Enterprise on request | Get started, plus "Schedule a demo" |
| TagMango (read directly) | Yes | Free plus 10%; Pro ₹5,000 plus 5.5%; Advanced ₹15,000 plus 3.5%; Ultimate ₹35,000 a month (+GST); setup ₹24,999 a year | "Book a call" on every plan |
| SuperProfile (read directly) | Yes, except Pro | Free; Creator ₹99 for the first month, then ₹499; Pro via "Book a call" | Sign up |
| Kajabi (read directly) | Yes | $179, $249 or $499 a month; 14-day trial plus a 30-day money-back guarantee | Start trial |
| Stan (reviews) | Yes | $29 or $99 a month; 14-day trial | Trial |
| Beacons (reviews) | Yes | $0, $10, $30 or $90 a month; 9% fee on lower tiers | Sign up |
| ManyChat (reviews) | Yes | Tiers revised 2 March 2026, $0–$139 a month billed yearly; 14-day trial on Essential and Pro | Sign up |
| Inrō (read directly) | Yes | Free; Pro from €12.99; Managed from €299 via "Talk to us" | Trial |
| Passionfroot (vendor page and reviews) | Free for creators | About 15% on deals it brings you | "Start for free" |
| Ginger, the closest competitor (read directly) | Creators: "$29/mo early-access" in its FAQ; agencies: per seat, amount not listed | — | Download, a waitlist that locks in early pricing, and "Book a demo" for agencies |

**The pattern:** every tool shows its creator prices; only agency, managed and enterprise tiers say "talk to us". TagMango shows prices but routes everyone to a call, which is closest to DealDock's hands-on onboarding.

**Ginger:** its headline is "Stop leaving money in your inbox", and it has a trademarked "Inbox Value™". Don't copy its wording. Stand apart on:
- India and Hinglish;
- coaching and course sales;
- approval before every send;
- GST, UPI and TDS.

**Hidden versus visible prices.** These are B2B findings, not creator data, so treat them as a direction rather than proof.
- **HockeyStack** (vendor; 80 B2B SaaS companies, 31 million visitors, December 2025):
  - Hidden pricing gets more form fills: 4.6% against 2.8%.
  - Visible pricing gets better leads: 17.5% of form fills become sales opportunities, against 10.3%.
  - [Source](https://www.hockeystack.com/lab-blog-posts/state-of-pricing-demo-case-study-pages).
- **TrustRadius** (vendor survey): "transparent pricing" has topped buyers' wish list for four years, at 45% in 2026. In 2023, missing prices were the top reason buyers were less likely to buy (54%). Sources: [2026](https://hginsights.com/news/trustradius-2026-b2b-buying-disconnect-report-reveals-ai-has-changed-how-buyers-research-but-not-what-they-trust/), [2023](https://www.trustradius.com/blog/2023-b2b-disconnect).
- **Gartner:** 61% (June 2025) and 67% (August–September 2025) of B2B buyers prefer to buy without a sales rep ([Gartner](https://www.gartner.com/en/newsroom/press-releases/2026-05-20-gartner-survey-finds-sixty-nine-percent-of-b-two-b-buyers-turn-to-sales-reps-to-validate-ai-generated-insights)).
- **Why it matters for DealDock:** founder time is the bottleneck. A visible ₹4,000 price filters out creators below the target revenue before they take up a call or a tester slot.

**Recommendation**
- Show "Solo ₹4,000/month + 18% GST (₹4,720)", and Studio the same way. Showing GST up front avoids drip pricing (see section 6).
- Roster: "from ₹15,000 + GST, billed by invoice — talk to us".
- Add "Founding price, locked for as long as you stay subscribed".
- Never show a crossed-out "future price" that has never been charged; that counts as a misleading reference price.

## 2. Which offer: a trial, a free month, pay after a week, or a paid pilot?

| Option | Verdict |
|---|---|
| **14-day trial, no card** | **No.** The first moment of value is the day-0 scan, but deal value lands over weeks 1–4. No-card trials convert at 4–15%, against about 30% for card-required trials ([ChartMogul, February 2026](https://chartmogul.com/reports/saas-conversion-report/), 200 products). Each trial also costs a founder call and a Meta tester slot. |
| **Free first month** | **No**, except for 2–3 hand-picked design partners (for example one agency and one well-known creator). In writing, they agree to weekly feedback, case-study rights and converting at the founding price. |
| **Free scan, first bill after one full week of use** | **Yes, and say so publicly.** Send the payment link on day 7, not before. Asking for a mandate to unlock a free period counts as a "subscription trap" under India's dark-pattern guidelines. |
| **Paid upfront pilot** | **Optional, for agencies only.** A prepaid first month, credited against later bills. It's too much to ask without social proof, and it can't start until Razorpay is live. |

**Paid versus free pilots.** There is no rigorous study. Practitioners consistently report that free pilots produce praise rather than contracts ([Stackmatix](https://www.stackmatix.com/blog/enterprise-pilot-to-paid-contract), [Wavect](https://wavect.io/blog/paid-pilot-vs-poc-vs-design-partner/)). Asking for payment on day 7 is a cheap test of commitment.

**Before Meta approval:** don't charge testers. Meta describes testers as acting on your behalf, so charging them is a grey area; that reading is ours. Take a signed commitment, or a refundable deposit.

**Price anchors in India:** SuperProfile ₹499, Exly Pro ₹2,500, Topmate Agentic ₹2,999, TagMango Pro ₹5,000 + GST. Anchor DealDock to the money found, not to the price of DM tools: "one coaching sale covers N months".

**When not to sell:** if the scan finds less than about 5× the monthly fee (around ₹20,000), say so and don't sell.

**UPI Autopay**
- **RBI rules** ([e-mandate framework, 21 April 2026](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=13374)):
  - recurring debits up to ₹15,000 run without extra authentication;
  - setting up the mandate and the first debit always need authentication;
  - customers get a notice 24 hours before each debit.
- **Razorpay** ([FAQ](https://razorpay.com/docs/payments/subscriptions/faqs)):
  - hides UPI when the plan plus any upfront amount is ₹15,000 or more;
  - cards above ₹15,000 need authentication on every debit;
  - PhonePe and BHIM don't support mandates above ₹15,000.
- **What that means for each plan:**
  - Solo (₹4,720 with GST) and Studio (₹9,440) work on UPI Autopay.
  - Roster at ₹17,700 with GST doesn't. Bill it with a GST invoice plus a payment link, e-NACH or quarterly prepayment, or price it under ₹15,000.

## 3. "Apply for the pilot": keep, change or replace?

**Why it's a capped group today**
- Before Advanced Access, Meta only allows invited tester accounts, so open signup can't work.
- Onboarding is done by hand.
- Each creator's revenue needs checking.

**The options**
- **Waitlist:** passive, doesn't qualify anyone, and reads as "not ready".
- **Open self-serve signup:** not possible until Meta approves.
- **Application:** right for now. Superhuman is the reference case: a waitlist, a survey and a 30-minute call with every user, at a premium price, used to screen users and reduce churn ([How They Grow](https://www.howtheygrow.co/p/how-superhuman-grows)). Applying is also normal for high-ticket coaching in India.

**The problem is the word "pilot" (and "design partner"), not "apply".**

**Suggested wording**
- **Button:** "Get my free Leak Scan".
- **Under the button:** "We set up every account personally during early access: a 20-minute call where you see your number live."
- **Section name:** "Founding members".
- **FAQ:** "Why can't I sign up instantly? Instagram connects new apps in stages. During early access our team adds your account and sets it up with you."
- **Never claim** "Meta-approved" before it's true.
- **Form fields:**
  - keep email and Instagram handle;
  - add WhatsApp number and a monthly-revenue band;
  - add "I manage creators" as a choice;
  - say when you'll reply.

**Ideas that need no Meta approval**
- **A free Scam Check:** a creator pastes or screenshots a brand DM and gets a "real or fake" read. Fake brand deals aimed at Indian creators are well reported ([Storyboard18](https://www.storyboard18.com/brand-makers/scams-surge-in-creator-economy-as-fake-brands-fraud-agencies-target-influencers-78864.htm)).
- **A Leak Scan from Instagram's own data export** (the messages JSON). It needs no API, but Instagram can take hours or days to deliver the export ([guide](https://sociality.io/blog/how-to-export-instagram-messages/)).

## 4. Getting the first 10, then 50

**Where to find leads.** Build a sheet of about 300 creators and 40 agencies.
- **Creators who already sell:** search `site:topmate.io`, `superprofile.bio`, `exlyapp.com` and `tagmango` together with "coach" or "program".
- **Creators running "comment X / DM me X" reels:** those reels flood their DMs.
- **Talent and talent-management agencies:** Chtrbox Represent, IPLIX, Confluencr, House of Creators, Mfluencer and smaller agencies. These names come from self-ranked lists ([Kudozz](https://www.kudozz.in/blog/best-influencer-marketing-agencies-in-india)), so check their rosters yourself.

**Channels, ranked**
1. **Warm introductions** through people you know. Aim for about 5 of the first 10 customers from here.
2. **Small talent agencies,** through LinkedIn and email. One yes brings 3–5 creators. Ginger already sells to agencies, so move early. Pitch: "Brands DM your creators directly, and those enquiries often never reach you."
3. **The business email in a creator's bio** (the one they check for brand deals), then WhatsApp.
4. **Instagram DMs:**
   - Instagram publishes no limit. Practitioners advise 5–20 cold DMs a day from a young account, written by hand, without links and never identical ([summary](https://www.usewave.co/blog/instagram-dm-limits/)).
   - A cold DM from a non-follower lands in Requests, the very folder DealDock exists to fix. So reply to 1–2 of their stories first, or use it as a hook: "If this landed in Requests, that's the problem."
   - Never use automation tools.
5. **Referrals,** for customers 10 to 50. Give a free month to both sides, triggered when the referred creator pays their first invoice. In a peer-reviewed study of bank customers, referred customers were worth 16% more ([Schmitt et al., Journal of Marketing 2011](https://cello.so/blog/referral-marketing-for-b2b-saas/)).
6. **Founder content:**
   - reels and carousels about missed DMs and fake brand offers;
   - LinkedIn posts for agency owners;
   - consented case studies from day 30.
7. **Coach communities:** co-host webinars with community owners ([Edarya](https://www.edarya.io/)) and run a live scan demo. Disclose any paid or affiliate tie.
8. **Creator platforms, but not before 50 customers.** Topmate and SuperProfile run auto-DM features that overlap with DealDock. Exly has a partner programme ([Exly](https://exlyapp.com/home/partner/)). Revisit once there are case studies.

**Outreach scripts.** Fill in the {braces}. Never quote a ₹ figure that wasn't measured.

**A. Cold email to a creator.** Subject: "Coaching enquiries stuck in your Requests?"
> Hi {name}, I'm {founder}, building DealDock in {city}. It sorts a creator's Instagram DMs by money (brand deals, coaching enquiries, course questions) and flags fake brand offers. With {N} people commenting "{keyword}" on your reels, I'd guess some enquiries sit unanswered for days.
>
> Offer: a free Leak Scan. On a 20-minute call we connect your account and show how many money messages went unanswered in the last 30 days, with an estimated value. No card. Nothing is sent from your account. We delete the scan if you don't continue.
>
> Worth 20 minutes this week? Reply or WhatsApp {number}.
>
> P.S. If the scan finds under ₹20,000, I'll tell you DealDock isn't worth it for you.

**B. Instagram DM in Hinglish, sent after engaging with their stories, with no link.**
> Hi {name}! Aapka {topic} wala reel solid tha. Quick baat: hum DealDock bana rahe hain, jo DMs ko paise ke hisaab se sort karta hai (brand deals, coaching leads) aur fake brand offers flag karta hai. Is mahine kuch coaches ke liye free "Leak Scan" kar rahe hain: pichhle 30 din mein kitne paise wale DMs ka reply nahi gaya. Interested ho to batao, details WhatsApp pe bhej deta hoon.

**C. Agency, by LinkedIn or email.** Subject: "Deals that land in your creators' DMs, not your inbox"
> Hi {name}, brands still DM your creators directly, and those enquiries often never reach you. DealDock sorts each creator's DMs by money, flags fake brand offers, drafts replies in the creator's own style for approval (nothing sends on its own), and tracks each deal to paid, with GST invoices and TDS.
>
> For founding agencies: free Leak Scans on two of your creators. If they find real money, Roster covers five creators from ₹15,000 + GST a month, billed by invoice after a full week of use. 15 minutes next week?

**D. Closing on the call, after the scan.**
> Last 30 days: {n} money messages unanswered, estimated ₹{x}–₹{y}. The biggest is {thread}. Want to answer it now?

They edit and approve the draft. Then:

> To keep this running, Solo is ₹4,000 + GST. No bill until you've used it a full week, and you can cancel in Settings. I'll send the payment link on day 7.

If it isn't a fit:

> Honestly, ₹{x} doesn't justify ₹4,000. Can I check back in 3 months?

**E. Asking for referrals,** around day 21 or after their first recorded deal.
> You've recorded ₹{x} through DealDock. Who are two creators you'd trust with this? If they subscribe, you both get a month free. If you post about it, tag it #ad or #collab: the free month counts as a paid relationship under ASCI.

**F. Objections**
- **"Do you read my DMs?"** Only to sort them and draft replies for you. They're never sold, and never used to train public models. You can export or delete everything at any time, and personal chats can go on the ignore list.
- **"Will my account get banned?"** DealDock uses Instagram's official API, scrapes nothing, and nothing sends without your tap.
- **"Too expensive."** One coaching sale covers several months. If the scan doesn't find 5× the fee, don't buy.
- **"My assistant handles DMs."** That's what Studio is for.

## 5. Launch sequence

Week 1 is the week starting Monday 9 November 2026.

**Phase A: before Meta approval (weeks 1–4)**
- Start Business Verification and add the tester agreement.
- Update the site: prices with GST, a scan-first button, the FAQ, and analytics events for button clicks, form starts and form submissions.
- Set up a WhatsApp Business number and a founder Instagram account that has some history.
- Build the lead sheet, then make 15–25 personal outreach touches a day across channels.
- Run 15 scans through the tester route, and aim for 8–10 written commitments.
- Publish Scam Check content.
- Submit for App Review once the first successful API call and the screencast are ready.
- **Measure:**
  - reply rate by channel;
  - calls booked that turn into scans;
  - median ₹ found per scan, and the share of scans finding ₹20,000 or more;
  - the commitment rate.

**Phase B: private paid pilot (weeks 5–12), once Advanced Access and live Razorpay are both in place**
- Convert the commitments.
- Onboard 5 creators a week, capped at 25 until onboarding takes under 15 minutes, then raise the cap to 50.
- Weeks 6–8: push fitness coaches with January New Year leads. That timing is a judgement, not data.
- Day 30: publish consented case studies using numbers from the creator's own ledger.
- Turn on referrals once 10 creators are paying.
- **Measure:**
  - first approved send within 24 hours;
  - activation: first recorded deal within 14 days;
  - conversion from week 1 to paid;
  - month-2 paid retention;
  - recovered revenue per creator, counting only deals DealDock surfaced and that were marked paid;
  - payback: recovered revenue ÷ fee;
  - the share of drafts sent without edits;
  - scam-flag precision;
  - the share of users who would be "very disappointed" without DealDock (target 40% or more).

**Phase C: public launch (weeks 13–16, about February 2027)**
- **Only launch when:**
  - 30–50 creators are paying;
  - month-2 retention is 80% or more;
  - median payback is 5× or more;
  - at least 5 case studies exist;
  - onboarding works without a founder;
  - Gmail is verified, or still labelled invite-only.
- **Then:**
  - switch to self-serve signup with qualifying questions;
  - move new signups to post-pilot prices while founding members keep theirs;
  - consider an annual plan.

**Timing:** prices go on the site now. Case studies go up as soon as 1–3 consented ones exist. Until then, a "how the scan works" section with the founder's face and WhatsApp number stands in for proof.

## 6. Legal and compliance that affect the launch

Not legal advice.

- **Money claims** ("found ₹X", "recover ₹X"):
  - ASCI requires every factual claim to be backed up ([ASCI Code](https://www.ascionline.in/the-asci-code/)).
  - Label scan figures "estimated" and explain the method.
  - Base "recovered" only on deals marked paid, and never say "guaranteed".
- **Testimonials** must be genuine, current and used with permission; never AI-made. Under the CCPA's 2022 guidelines on misleading ads, fines reach ₹10 lakh, and ₹50 lakh for repeat offences ([summary](https://www.mondaq.com/india/advertising-marketing-branding/1201534/ccpa-releases-guidelines-for-prevention-of-misleading-advertisements-and-endorsements-for-misleading-advertisements-2022)).
- **"Free"** must mean free.
  - Say what the scan involves: a call and connecting Instagram.
  - Don't call anything a "free trial" if it needs a non-refundable payment.
- **Dark patterns** under the CCPA's 2023 guidelines ([Legal500](https://www.legal500.com/intelligence/india/consumer-protection/ccpas-guidelines-on-dark-patterns-an-overview)):
  - show GST up front, to avoid drip pricing;
  - no "only N spots left" unless it's true;
  - cancelling must be easy and inside the app;
  - never require an autopay mandate to unlock a free period;
  - state the renewal amount and frequency at checkout.
- **RBI e-mandates:** the ₹15,000 limit, a notice 24 hours before each debit, and customers can cancel from their UPI app.
- **Creators promoting DealDock:** a free month counts as a paid relationship under ASCI, so their posts need #ad, #collab or Instagram's Paid Partnership tag. DealDock shares responsibility for that ([ASCI influencer guidelines](https://www.ascionline.in/social/guidelines/)).
- **Meta:**
  - Testers need a written agreement.
  - Meta's Platform Terms still cover aggregated or anonymised data from DMs, so don't publish statistics like "creators lose ₹X" built from scans. Use consented case studies instead ([Platform Terms](https://developers.facebook.com/terms/dfc_platform_terms/)).
- **Privacy (DPDP):** the Rules were notified on 13 November 2025, and most obligations start on 13 May 2027 ([Legal500](https://www.legal500.com/intelligence/india/privacy/dpdp-act-and-rules-2025-the-2026-compliance-milestones-businesses-cant-afford-to-miss)). For now, publish the privacy policy (App Review needs it anyway) and delete scan data for creators who don't continue.

## 7. Decisions for the owner

1. Show prices now, and quote them as "+ GST" or GST-inclusive?
2. Keep Roster at ₹15,000 + GST billed by invoice, or price it under the ₹15,000 UPI cap?
3. Before Meta approval, should testers be free with a written commitment (recommended), or charged?
4. The "not a fit" threshold, for example under ₹20,000 found.
5. Weekly onboarding capacity, the size of the cohort, and who runs the calls.
6. Build the export-based Leak Scan and the Scam Check?
7. How many free design partners (0–3), and who?
8. The referral reward.
9. Start Gmail verification now, or keep Gmail invite-only?

**Not checked:** the Stan, Beacons, ManyChat and Passionfroot pricing pages were blocked or returned 404, so their prices come from reviews dated August–October 2026. Instagram DM limits are unofficial estimates.
