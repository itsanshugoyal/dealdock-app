# Prompt: policy and trust pages for dealdock.io

You're adding the legal and trust pages to the DealDock marketing site at dealdock.io. Inspect the current site and its code first, and match its design, header and footer. Razorpay, Paddle, Google (Gmail verification) and Meta (App Review) will each read these pages before approving DealDock, so they must be complete, specific, and consistent with each other. Write in plain English that a creator can read. Don't invent facts: where a value below is in `[brackets]`, leave a clearly marked placeholder and list every placeholder at the end of your reply.

## Business facts

- **Product:** DealDock, a deal inbox and CRM for creators, with replies you approve. It connects a creator's Instagram professional account (Meta's official API, no passwords or scraping) and, optionally, a Gmail inbox. It sorts incoming messages, estimates their value, drafts replies in the creator's own style, tracks deals and revenue, and drafts invoices and payment reminders. **Nothing is ever sent automatically: a person approves every message.** Never describe DealDock as "automation", "DM automation" or a "bot".
- **Legal entity:** `[Legal company name]`, `[registered address]`, `[CIN/registration number if any]`, `[GSTIN if registered]`.
- **Contact:** `[support email]`, `[phone number]`, `[registered address]`. Grievance officer: `[name]`, `[email]`, responding within `[time, e.g. 72 hours to acknowledge, 30 days to resolve]`.
- **Delivery:** a digital service, delivered online through app.dealdock.io immediately after sign-up. Nothing physical is shipped.
- **Pricing, monthly (pilot):** Solo ₹4,000 / $49 (one creator, one Instagram account); Studio ₹8,000 / $99 (creator plus an assistant); Roster ₹15,000 / $179 (up to five creators plus manager seats). Indian customers pay in INR through Razorpay; customers elsewhere pay in USD through Paddle, which is the merchant of record and handles their sales tax/VAT. Taxes are added where applicable.
- **Billing terms:** monthly, cancel anytime from Settings, no setup fee, no annual lock-in. The first invoice runs after one full week of active use. On cancellation, the subscription ends at the end of the current billing period, and the Revenue ledger stays readable (read-only) for 30 days.

## Pages to create (each linked from the site footer)

1. **Terms of Service** (`/terms`): the legal entity as the contracting party; eligibility (business or professional use, 18+); the account and seat rules; the creator's responsibility for what they approve and send; acceptable use (no spam, no impersonation, no use against Meta's or Google's platform terms); third-party platforms (Instagram, Gmail) and their availability; fees, billing and cancellation (as above, and point to the Refund page); intellectual property and the creator's ownership of their content; AI-drafted content is a suggestion the user reviews; limitation of liability; termination; governing law `[India, courts of city]`; changes to the terms; contact.
2. **Privacy Policy** (`/privacy`). It must cover:
   - **What we collect:** account details; connected Instagram messages, comments and profile data; Gmail messages from connected inboxes; deal, revenue and invoice records; voice samples only if the creator opts in to voice notes; usage and device data; payment status (not card numbers, which stay with Razorpay/Paddle).
   - **Why:** to provide the service (sorting, value estimates, drafts, deal tracking, notifications), billing, security, support, and improving the product. No selling of personal data, no advertising use.
   - **Service providers (sub-processors), each named with its purpose:** OpenAI and Groq (AI drafting and classification), Google (Gmail), Meta (Instagram), Razorpay and Paddle (payments), Clerk (sign-in), `[hosting providers, e.g. Railway and Vercel]` (hosting and database), and `[Sentry, if used]` (error monitoring).
   - **Where data is stored:** Singapore. Say that data may be processed outside India and the user's country, with safeguards.
   - **AI:** messages are sent to the AI providers only to produce drafts and classifications for that user; nothing is sent without a person approving it.
   - **Google user data, with this exact disclosure:** "DealDock's use and transfer of information received from Google APIs to any other app will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements." Also state plainly that Gmail data is never used to train AI models, never sold, and never read by people except with the user's consent, for security, or where the law requires.
   - **Retention:** while the account is active; ledger read-only for 30 days after cancellation, then deleted `[confirm period]`; backups expire within `[period]`.
   - **Rights:** access, correction, export and deletion (all available in Settings or by email), withdrawal of consent, and grievance redressal, under India's Digital Personal Data Protection Act, 2023, and GDPR/UK GDPR for users there. Include the grievance officer details.
   - **Disconnecting:** a user can disconnect Instagram or Gmail at any time in Settings; DealDock then stops syncing.
   - **Cookies:** only what sign-in and security need `[add analytics if the site uses any]`.
   - **Security:** encrypted connections, encrypted stored access tokens, access limited to the workspace.
   - **Children:** not for under-18s. Plus changes to the policy and contact details.
3. **Data deletion instructions** (`/data-deletion`). Meta requires this page. Explain how to delete data: Settings → delete workspace, or remove DealDock from Instagram (Settings → Apps and websites), or email `[support email]`. Give what gets deleted and the timeline `[e.g. within 30 days]`.
4. **Refund and Cancellation Policy** (`/refunds`): cancel anytime, access continues to the end of the paid period, no partial-month refunds except where the law requires or for billing errors (state how to request one and the timeline `[e.g. 5–7 business days]`). For purchases made through Paddle, Paddle's buyer terms apply as merchant of record `[confirm Paddle's required refund window before publishing]`.
5. **Shipping and Delivery Policy** (`/delivery`): "DealDock is a digital service delivered online. Access starts immediately after sign-up at app.dealdock.io. Nothing physical is shipped."
6. **Contact** (`/contact`): legal name, address, email, phone, support hours, the grievance officer, and a contact form if the site has one.
7. **Pricing** (`/pricing`) and **Features** (`/features`), if the site doesn't have them yet. Paddle requires both: the plans and prices above, what each includes, and a clear description of the product. No "coming soon" placeholders on these two pages, and only list features the marketing-site prompt says are live.

## Rules

- Date each legal page ("Last updated: `[date]`") and keep the legal name identical everywhere.
- The footer on every page links to Terms, Privacy, Refunds, Delivery, Data deletion, Contact and Pricing.
- Pages must be server-rendered or static (reviewers' crawlers must see the text), indexable, and work on mobile.
- Don't claim certifications, compliance badges or security audits DealDock doesn't have.
- End your reply with: every placeholder you left, and anything a lawyer should look at (liability cap, governing law, DPDP consent wording).
