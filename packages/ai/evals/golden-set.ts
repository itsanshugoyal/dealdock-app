import type { ClassificationLabel, MessageLanguage } from "@dealdock/core";

/**
 * Golden eval set (PLAN.md M2 — the make-or-break quality bar).
 *
 * Rules of this file:
 *  - Hand-written cases, deliberately NOT derived from the heuristic keyword
 *    table — the heuristic SHOULD score mediocre here; the real model must not.
 *  - ≥50% Hinglish/code-switched (PRD risk §10.1.2).
 *  - `hard: true` marks adversarial cases: spam dressed as brand deals, real
 *    deals that sound casual, fans with almost-buying intent, etc.
 *  - Labels here are ground truth decided by a human (us). When pilot data
 *    arrives, anonymized corrected cases get appended with provenance notes.
 *  - Expansion: slot substitution ({niche}/{city}/{amount}) that provably does
 *    not change the label. No mechanical opener-prefixing — that inflates n
 *    without information.
 */

export interface EvalCase {
  text: string;
  handle: string;
  label: ClassificationLabel;
  language: MessageLanguage;
  hard?: boolean;
  /** For commerce cases: which onboarding range the value estimate should overlap. */
  valueAnchor?: "brand" | "coaching" | "course";
}

const NICHES = ["fitness", "skincare", "finance", "food", "travel"];
const CITIES = ["Mumbai", "Bangalore", "Delhi", "Pune", "Jaipur"];
const AMOUNTS = ["50k", "1 lakh", "75000", "2L", "40,000"];

// ── brand_deal (22 unique) ─────────────────────────────────────────────────
const BRAND: EvalCase[] = [
  { text: "Hi! Marketing lead at a D2C {niche} startup here. We have sign-off for creator budgets this quarter and your audience fits. Open to a paid association? Happy to share scope on a quick call.", handle: "arka.brands", label: "brand_deal", language: "en", valueAnchor: "brand" },
  { text: "Namaste! Hum ek {niche} brand hain, {city} based. Aapke saath ek video integration karna chahte hain, budget approved hai. Kis email pe brief bhejein?", handle: "veda.naturals", label: "brand_deal", language: "hinglish", valueAnchor: "brand" },
  { text: "Hey! Loved the honesty in your last video. We'd want exactly that tone for our launch next month — one dedicated video, usage rights for 90 days. What would that cost us?", handle: "arjun.at.klay", label: "brand_deal", language: "en", valueAnchor: "brand" },
  { text: "Sir, main ek agency se hoon. Hamare client (bade {niche} brand, naam call pe bataunga) ko aapke jaisa creator chahiye Diwali ke liye. Commercials discuss kar sakte hain kya?", handle: "mediahouse.rk", label: "brand_deal", language: "hinglish", valueAnchor: "brand" },
  { text: "Following up from the event in {city} — we spoke briefly about doing something together for our summer line. Ready to move on it now, deliverables and fee both negotiable.", handle: "summerline.official", label: "brand_deal", language: "en", valueAnchor: "brand" },
  { text: "Hello! PR team this side. Product seeding ke saath ek paid reel bhi plan kar rahe hain aapke liye. Rate card share karenge?", handle: "glowpr.team", label: "brand_deal", language: "hinglish", valueAnchor: "brand" },
  { text: "We're allocating {amount} per creator for this campaign. Two posts, one story set. If that works, our team will send the agreement today itself.", handle: "nucosmetics", label: "brand_deal", language: "en", hard: true, valueAnchor: "brand" },
  { text: "Bhai ek kaam ka message — mera dost ek {niche} startup chala raha hai, funded hai. Wo aapko officially onboard karna chahta hai as face of the brand. Serious baat hai, batao interest hai?", handle: "rohit.malhotra_", label: "brand_deal", language: "hinglish", hard: true, valueAnchor: "brand" },
  { text: "Good morning. Our brand works with select creators only. No barter — we pay properly and expect professionalism. If interested in a long-term association, reply with your manager's contact.", handle: "houseof.aurel", label: "brand_deal", language: "en", valueAnchor: "brand" },
  { text: "Hi, humne aapko {city} wale expo mein dekha tha. Hamari nayi range aa rahi hai aur uske launch ke liye 3 creators finalize kar rahe hain. Aap free ho next month?", handle: "trueroots.in", label: "brand_deal", language: "hinglish", valueAnchor: "brand" },
  { text: "Quick one — we need a creator for a festive spot, shoot in {city}, fee plus travel covered. Timeline is tight. Yes or no by tomorrow?", handle: "festco.media", label: "brand_deal", language: "en", valueAnchor: "brand" },
  { text: "Team DealBazaar this side. Humein aapke page pe ek dedicated post chahiye apne app ke liye. Paid hai, invoice ke against payment 15 din mein. Details bhejein?", handle: "dealbazaar.app", label: "brand_deal", language: "hinglish", valueAnchor: "brand" },
];

// ── coaching_lead (20 unique) ──────────────────────────────────────────────
const COACHING: EvalCase[] = [
  { text: "I've tried everything on my own for 2 years and nothing sticks. I'm ready to invest in myself properly this time. How does working with you actually work?", handle: "nikhil.tries", label: "coaching_lead", language: "en", valueAnchor: "coaching" },
  { text: "Didi, shaadi hai 5 mahine mein. Mujhe seriously guidance chahiye, khud se nahi ho raha. Aap personally guide karti ho kya? Kharcha jo bhi ho, bata dijiye.", handle: "priya.getsfit", label: "coaching_lead", language: "hinglish", hard: true, valueAnchor: "coaching" },
  { text: "Sir aapne jo client transformation post kiya tha last week, wo mere jaise hi situation ka tha. Main bhi wahi results chahta hoon. Kaise start karein?", handle: "amitk.2802", label: "coaching_lead", language: "hinglish", valueAnchor: "coaching" },
  { text: "What's included if I sign up with you? Diet, workouts, calls? And what if I travel a lot for work — does the plan adjust?", handle: "roadwarrior.vk", label: "coaching_lead", language: "en", valueAnchor: "coaching" },
  { text: "Mujhe aapki guidance chahiye bhaiya. Job lag gayi hai ab paise ki dikkat nahi hai. Bas result chahiye. Slot available hai?", handle: "vivek_newjob", label: "coaching_lead", language: "hinglish", valueAnchor: "coaching" },
  { text: "My doctor said I need to take this seriously now. A friend who works with you recommended I reach out. Can we talk this week?", handle: "sameer.h20", label: "coaching_lead", language: "en", hard: true, valueAnchor: "coaching" },
  { text: "Aapke saath kaam karne ka process kya hai? Pehle call hoti hai ya direct payment? Main is month se hi start karna chahti hoon.", handle: "ritu.decides", label: "coaching_lead", language: "hinglish", valueAnchor: "coaching" },
  { text: "Been following for 8 months, finally ready. One question — do you take people at my level or only advanced? Don't want to waste your time or mine.", handle: "slowandsteady.g", label: "coaching_lead", language: "en", valueAnchor: "coaching" },
  { text: "Bhai ek baat batao, aapka jo personal wala option hai usme kitna time dena padta hai daily? Office 10 ghante ka hai mera. Manage ho jayega toh main ready hoon.", handle: "corporate.jeevan", label: "coaching_lead", language: "hinglish", valueAnchor: "coaching" },
  { text: "Ma'am I saw your story about the new batch. Main pichli baar miss kar gayi thi. Is baar pakka join karna hai — kya karna hoga?", handle: "anj.finallyready", label: "coaching_lead", language: "hinglish", valueAnchor: "coaching" },
];

// ── course_inquiry (18 unique) ─────────────────────────────────────────────
const COURSE: EvalCase[] = [
  { text: "Is there a syllabus I can see before paying? I've bought online programs before that were all fluff. Yours looks different but I want to be sure.", handle: "burnt.before", label: "course_inquiry", language: "en", hard: true, valueAnchor: "course" },
  { text: "Bhaiya, student hoon final year ka. Aapka program afford karne ke liye do mahine save karne padenge. Kya tab tak price same rahega?", handle: "hopeful.grad", label: "course_inquiry", language: "hinglish", valueAnchor: "course" },
  { text: "Do you offer the recordings if I can't attend live? Time zone issue — I'm in Dubai. Also is the certificate recognized anywhere?", handle: "dxb.hustler", label: "course_inquiry", language: "en", valueAnchor: "course" },
  { text: "Didi aapke batch mein Hindi medium walon ke liye bhi theek rahega na? Main English samajh leta hoon par bolne mein dikkat hai.", handle: "vinay.sikhega", label: "course_inquiry", language: "hinglish", valueAnchor: "course" },
  { text: "My company has an L&D budget — can you share an invoice format they can process? If yes I'm enrolling today.", handle: "corp.learner", label: "course_inquiry", language: "en", valueAnchor: "course" },
  { text: "Kitne log hote hain ek batch mein? Personal attention milta hai ya bas recorded lectures hain? Pichhla experience kharab tha kahin aur ka.", handle: "once.bitten", label: "course_inquiry", language: "hinglish", valueAnchor: "course" },
  { text: "Group discount hota hai kya? Hum 3 dost saath enroll karna chahte hain.", handle: "teen.yaar", label: "course_inquiry", language: "hinglish", valueAnchor: "course" },
  { text: "Saw the results your last cohort posted. What happens after the course ends — is there an alumni group or ongoing support?", handle: "thinks.longterm", label: "course_inquiry", language: "en", valueAnchor: "course" },
  { text: "Aapka course lena hai lekin main abhi {city} se bahar hoon travel pe. Next batch kab hai? Seat reserve ho sakti hai kya advance dekar?", handle: "traveller.paji", label: "course_inquiry", language: "hinglish", valueAnchor: "course" },
];

// ── other_commerce (16 unique) ─────────────────────────────────────────────
const OTHER: EvalCase[] = [
  { text: "We run a corporate wellness program for a tech company in {city} — 400 employees. Would you do a monthly session for our team? We have vendor onboarding and pay 30-day terms.", handle: "peoplefirst.hr", label: "other_commerce", language: "en" },
  { text: "Namaste, hum ek college fest organize kar rahe hain {city} mein. Aapko guest judge ke liye bulana chahte hain. Honorarium milega, travel bhi cover hai. Aayenge?", handle: "fest.committee", label: "other_commerce", language: "hinglish", hard: true },
  { text: "Sir hum ek YouTube channel chalate hain, 2M subs. Aapko as expert interview karna chahte hain — hum pay karte hain guests ko session ke liye. Interested?", handle: "bigpod.hindi", label: "other_commerce", language: "hinglish" },
  { text: "Would you review our app before launch? Not asking for a post — we want a paid consult on the content strategy inside the app. 2-3 hours of your time.", handle: "stealth.founder", label: "other_commerce", language: "en" },
  { text: "Hamari society ka annual event hai, 500 families. Aap aake ek workshop le sakte hain kya? Committee ne budget rakha hai iske liye.", handle: "rwa.gurgaon", label: "other_commerce", language: "hinglish" },
  { text: "I edit a magazine — we'd like to license three of your posts as columns, with credit and payment per piece. Standard rates apply. Interested?", handle: "print.editor", label: "other_commerce", language: "en" },
];

// ── fan (16 unique) ────────────────────────────────────────────────────────
const FAN: EvalCase[] = [
  { text: "Bhai aapki wajah se maine apni pehli job crack ki. Bas thank you bolna tha. Kabhi {city} aao toh chai zaroor.", handle: "grateful.amit", label: "fan", language: "hinglish" },
  { text: "One day I'll be able to afford your program! Till then main free wale videos se hi seekh raha hoon 💪", handle: "someday.soon1", label: "fan", language: "hinglish", hard: true },
  { text: "Your content deserves way more reach yaar. Algorithm is unfair. Keep going!", handle: "loyal.viewer22", label: "fan", language: "hinglish" },
  { text: "Didi aap bilkul meri badi behen jaisi lagti ho. Aapki har post save karti hoon.", handle: "chhoti.si.fan", label: "fan", language: "hinglish" },
  { text: "That last post hit hard man. Needed to hear it today. Respect.", handle: "quiet.follower", label: "fan", language: "en" },
  { text: "Sir aapke prices kya hain sab log poochte rehte hain comments mein, main toh bas free mein aapko dekh ke khush hoon 😂", handle: "budget.bhakt", label: "fan", language: "hinglish", hard: true },
  { text: "Shared your video with my whole family group. Papa finally listened because YOU said it, not me 😅", handle: "family.ambassador", label: "fan", language: "en" },
  { text: "Aapse motivation lekar maine apna weight loss start kiya, 6kg down! Ye aapki jeet bhi hai 🙏", handle: "sixkg.down", label: "fan", language: "hinglish" },
];

// ── spam (16 unique) ───────────────────────────────────────────────────────
const SPAM: EvalCase[] = [
  { text: "Hello dear, we are official partner brand ambassador program. You are selected! Kindly share WhatsApp for onboarding formality.", handle: "brand.official.2026x", label: "spam", language: "en", hard: true },
  { text: "Sir we saw your profile, our client wants to work with you. First please complete verification of {amount} refundable deposit. 100% genuine.", handle: "agency.verified.in", label: "spam", language: "en", hard: true },
  { text: "Aapke page ki reach down ho gayi hai. Hum organic boost karte hain, results guaranteed. Pehle 100 followers FREE demo.", handle: "reach.doctor", label: "spam", language: "hinglish" },
  { text: "Collab collab collab!!! Follow back and DM us. Big network of creators. Don't miss!!!", handle: "creator.network.99", label: "spam", language: "en" },
  { text: "Hum aapko monetization tips sikhayenge sirf ₹499 mein. Aaj hi 50% off. Screenshot bhejo payment ka aur PDF turant milega.", handle: "paisa.guru.tips", label: "spam", language: "hinglish" },
  { text: "Dear creator, your account is eligible for our influencer marketplace. Click link in our bio to claim your brand deals now (limited slots).", handle: "marketplace.claim", label: "spam", language: "en", hard: true },
  { text: "Bhai aapka account hack ho sakta hai, humne dekha vulnerability. Security service dete hain hum, abhi DM karo warna problem hogi.", handle: "cyber.rakshak", label: "spam", language: "hinglish" },
];

// ── personal (12 unique) ───────────────────────────────────────────────────
const PERSONAL: EvalCase[] = [
  { text: "Arre insta pe hi milna padega ab toh 😂 phone kyu nahi uthata? Mausi ka function hai Sunday ko, aana hai pakka.", handle: "cousin.neha", label: "personal", language: "hinglish" },
  { text: "Bhai {amount} udhaar chahiye tha agle hafte tak, salary aate hi wapas. Bata dena jab dekhe.", handle: "school.wala.dost", label: "personal", language: "hinglish", hard: true },
  { text: "Saw mom's report today. Doctor said it's nothing serious, don't stress. Call when you're free.", handle: "bhai.rohan", label: "personal", language: "en" },
  { text: "Yaar tera wala photographer ka number de na, didi ki engagement ke liye chahiye.", handle: "mausi.beti", label: "personal", language: "hinglish" },
  { text: "Landlord messaged again about the lease renewal. Need your half of the deposit by Friday. Also we're out of gas.", handle: "flatmate.arya", label: "personal", language: "en", hard: true },
  { text: "Papa ne pooch raha tha diwali pe aa raha hai ki nahi is saal. Tickets abhi sasti hain, dekh le.", handle: "ghar.se.chhotu", label: "personal", language: "hinglish" },
];

// ── uncertain (12 unique) ──────────────────────────────────────────────────
const UNCERTAIN: EvalCase[] = [
  { text: "Hi, we should connect. I think there's mutual benefit here.", handle: "vague.ventures", label: "uncertain", language: "en" },
  { text: "Aapse kuch discuss karna tha. Kab free ho?", handle: "unknown.uncle", label: "uncertain", language: "hinglish" },
  { text: "Sent you something on email, did you check? It's regarding the thing.", handle: "which.thing", label: "uncertain", language: "en" },
  { text: "Bhai ek opportunity hai tere liye. Interested?", handle: "mystery.bro", label: "uncertain", language: "hinglish" },
  { text: "Hello ji. Aap hi ho na wo wale creator? Baat karni thi.", handle: "confused.aunty", label: "uncertain", language: "hinglish" },
  { text: "Can I ask you something about what you do? It's a bit specific.", handle: "curious.maybe", label: "uncertain", language: "en" },
];

// ── Batch 2 — more coverage per label, slots where natural ────────────────
const BRAND_2: EvalCase[] = [
  { text: "Hi team! We're a {niche} label from {city} doing our first creator push. Modest budget but real — {amount} per integration. Would you consider us?", handle: "smallbutreal.co", label: "brand_deal", language: "en", valueAnchor: "brand" },
  { text: "Aapki reel dekhi humne {niche} wali. Hamare product ke saath bilkul fit baithegi aisi ek video. Paid collab ke liye kisse baat karein — aap khud dekhte ho ya manager hai?", handle: "nayabrand.in", label: "brand_deal", language: "hinglish", valueAnchor: "brand" },
  { text: "Renewal time! Last year's campaign with you did numbers for us. Same scope, better fee this time. Shall I send the updated terms?", handle: "repeat.client.krd", label: "brand_deal", language: "en", valueAnchor: "brand" },
  { text: "Namaste ji, {city} ki ek jani-mani {niche} company se bol raha hoon. TV ad ke saath-saath social bhi karna hai is baar. Aapka naam list mein sabse upar hai.", handle: "classic.brands", label: "brand_deal", language: "hinglish", valueAnchor: "brand" },
  { text: "We saw your audience is 70% in tier-2 cities — that's exactly our market. Performance-based deal possible? Fixed fee plus commission on codes.", handle: "growth.at.zenly", label: "brand_deal", language: "en", hard: true, valueAnchor: "brand" },
  { text: "Sir hamara {niche} ka showroom khul raha hai {city} mein. Opening pe aapko bulana chahte hain aur ek post bhi. Dono ka alag payment karenge. Sochiye mat, bas haan boliye 😄", handle: "showroom.launch", label: "brand_deal", language: "hinglish", valueAnchor: "brand" },
  { text: "Our agency represents three {niche} brands. Instead of one-off posts we're proposing you a quarterly retainer covering all three. Numbers on call?", handle: "trio.talent", label: "brand_deal", language: "en", valueAnchor: "brand" },
  { text: "Madam, humein aapke saath ek chhota sa kaam karna hai — ek unboxing video, product hum bhejenge aur {amount} bhi. Chalega?", handle: "seedha.saudha", label: "brand_deal", language: "hinglish", valueAnchor: "brand" },
];

const COACHING_2: EvalCase[] = [
  { text: "Meri umar 42 hai, {city} mein rehta hoon. Aap mere jaise logon ke saath bhi kaam karte ho ya sirf young logon ke saath? Agar haan toh main taiyaar hoon shuru karne ko.", handle: "late.starter.42", label: "coaching_lead", language: "hinglish", valueAnchor: "coaching" },
  { text: "You posted that only 3 slots are left this month. Is that real or marketing? Either way I want one — what do I do next?", handle: "calls.bluff", label: "coaching_lead", language: "en", hard: true, valueAnchor: "coaching" },
  { text: "Didi meri behen ne aapke saath kaam kiya tha pichhle saal ({amount} wala plan). Uske results dekhe maine. Mujhe bhi wahi plan chahiye.", handle: "behen.dekh.k.aayi", label: "coaching_lead", language: "hinglish", valueAnchor: "coaching" },
  { text: "I'm relocating to {city} next month and want to start fresh with structure. Does your program work fully online or do you need in-person sessions?", handle: "fresh.start.mover", label: "coaching_lead", language: "en", valueAnchor: "coaching" },
  { text: "Bhaiya main gym trainer hoon khud, par apne clients ke liye aapse programming seekhna chahta hoon 1-on-1. Professional ke liye alag rate hai kya?", handle: "trainer.seeks.guru", label: "coaching_lead", language: "hinglish", hard: true, valueAnchor: "coaching" },
  { text: "No questions, I've done my research. Send me the payment link for the 6-month one.", handle: "zero.friction", label: "coaching_lead", language: "en", valueAnchor: "coaching" },
  { text: "Sir ji, meri company ne bola hai health improve karo warna medical premium badhega 😅 Ab seriously lena padega. Aapka sabse basic plan kya hai?", handle: "premium.bachao", label: "coaching_lead", language: "hinglish", valueAnchor: "coaching" },
  { text: "Husband wife dono join kar sakte hain kya ek saath? Couple ke liye kuch alag package hai?", handle: "hum.dono", label: "coaching_lead", language: "hinglish", valueAnchor: "coaching" },
];

const COURSE_2: EvalCase[] = [
  { text: "Honest question before I enroll — main {city} se hoon, yahan internet thoda weak hai. Recordings download hoti hain ya sirf streaming?", handle: "gaon.ka.launda", label: "course_inquiry", language: "hinglish", valueAnchor: "course" },
  { text: "I run a small team and want to put 2 juniors through your course. Do you invoice companies? GST bill needed.", handle: "boss.who.invests", label: "course_inquiry", language: "en", valueAnchor: "course" },
  { text: "Aapke course ka fees {amount} hai na? Ek doubt tha — EMI pe lene se content milta hai pura ya kist ke hisaab se unlock hota hai?", handle: "emi.pe.sab", label: "course_inquiry", language: "hinglish", valueAnchor: "course" },
  { text: "Missed the deadline for this cohort by two days 😭 any chance of a late entry? I'll catch up on the recordings over the weekend, promise.", handle: "always.late.tanvi", label: "course_inquiry", language: "en", valueAnchor: "course" },
  { text: "Mera 16 saal ka beta aapko follow karta hai aur ye course karna chahta hai. Minors le sakte hain? Payment main karungi.", handle: "supportive.mummy", label: "course_inquiry", language: "hinglish", hard: true, valueAnchor: "course" },
  { text: "What's the refund window? Not planning to use it, but I don't buy anything online without one. If it exists, I'm in today.", handle: "careful.buyer.11", label: "course_inquiry", language: "en", valueAnchor: "course" },
  { text: "Bhaiya scholarship ya kuch discount hai students ke liye? Poora toh nahi de paunga abhi, par seekhna bahut hai.", handle: "broke.but.eager", label: "course_inquiry", language: "hinglish", hard: true, valueAnchor: "course" },
];

const OTHER_2: EvalCase[] = [
  { text: "We're publishing an anthology on {niche} and want you to write the foreword. There's a fee, plus royalty share. Publisher is legit, happy to share details.", handle: "book.people", label: "other_commerce", language: "en" },
  { text: "Bhai hamari app pe live session karoge? Ek ghante ka, audience hamari, payment session ke turant baad. Monthly bhi kar sakte hain agar accha laga.", handle: "liveapp.desi", label: "other_commerce", language: "hinglish" },
  { text: "Our hotel chain wants a wellness weekend curated by you in {city} — you design it, we run it, revenue share or flat fee, your pick.", handle: "resorts.premium", label: "other_commerce", language: "en" },
  { text: "Sir ek documentary ban rahi hai {niche} industry pe. Aapka interview chahiye as expert — 2 ghante ka shoot, professional fee denge. Producer bade hain.", handle: "docu.crew.mum", label: "other_commerce", language: "hinglish" },
  { text: "Would you be an advisor to our startup? Small equity plus monthly retainer. We need 2 hours a month and your name on the deck (with permission).", handle: "seed.stage.sid", label: "other_commerce", language: "en", hard: true },
  { text: "Hamare school mein career day hai. Bachhon se baat karne ke liye aapko bulana chahte hain. Chhota sa honorarium hai, bade dil se de rahe hain 🙏", handle: "principal.madam", label: "other_commerce", language: "hinglish", hard: true },
];

const FAN_2: EvalCase[] = [
  { text: "Bhai maine aapka {niche} wala routine copy kiya as it is. Free mein itna value koi nahi deta. Bas yahi bolna tha!", handle: "copycat.fan", label: "fan", language: "hinglish" },
  { text: "My daughter showed me your page. Beta you are doing good work, blessings from {city}.", handle: "uncle.blessings", label: "fan", language: "en" },
  { text: "Agar main kabhi ameer hua toh sabse pehle aapka course lunga 😂 tab tak like share subscribe!", handle: "future.customer.lol", label: "fan", language: "hinglish", hard: true },
  { text: "Just wanted to say your consistency inspired me to start my own page. Not asking anything, just gratitude.", handle: "new.creator.gratitude", label: "fan", language: "en" },
  { text: "Aapki story dekh ke roz gym jaata hoon. Aaj 100 din ho gaye. Streak aapke naam 🔥", handle: "hundred.days", label: "fan", language: "hinglish" },
  { text: "Didi please {city} mein meetup karo na kabhi, hum sab milna chahte hain aapse!", handle: "meetup.please", label: "fan", language: "hinglish" },
];

const SPAM_2: EvalCase[] = [
  { text: "Congratulations 🎉 Your profile has been shortlisted for PAID BRAND PROMOTIONS. Register with just {amount} activation. Earn 50k monthly from home!", handle: "earn.from.home.co", label: "spam", language: "en", hard: true },
  { text: "Hum {city} ki sabse badi agency hain. 500+ creators hamare saath. Aap bhi judiye — membership sirf ₹999/month. Brands ki line lagegi.", handle: "line.lagao.agency", label: "spam", language: "hinglish", hard: true },
  { text: "Bro your reels deserve millions. Our AI tool guarantees viral. First video free, then subscription. Check bio NOW before offer ends.", handle: "viral.ai.tool", label: "spam", language: "en" },
  { text: "Madam namaste, lottery nahi hai, scheme nahi hai — bas ek chhota investment aur roz ka {amount} pakka. Meri khud ki earning ka screenshot dekhiye.", handle: "roz.ka.paisa", label: "spam", language: "hinglish" },
  { text: "URGENT: Meta is deleting inactive creator accounts. Verify yours through our partner portal today. We are authorized service provider.", handle: "meta.partner.help", label: "spam", language: "en", hard: true },
  { text: "Exchange karo bhai — main aapki 3 reels share karunga apne 200k page pe, aap meri 1. Sabka growth hoga. Deal?", handle: "share4share.raja", label: "spam", language: "hinglish", hard: true },
  { text: "Free mein logo, intro video, thumbnail sab banayenge aapke liye. Bas ek baar hamari service try karo. Portfolio bio mein. Reply fast slots kam hain.", handle: "design.factory.99", label: "spam", language: "hinglish" },
];

const PERSONAL_2: EvalCase[] = [
  { text: "Bhaiya shaadi ka card bheja hai ghar pe, {city} aana hi hai aapko is baar. Bhabhi ko bhi lao 😄", handle: "cousin.shaadi", label: "personal", language: "hinglish" },
  { text: "Hey, it's Ankit from school! Found you here after years. You've done so well man. Reunion is being planned btw.", handle: "ankit.oldfriend", label: "personal", language: "en" },
  { text: "Beta doctor ne mummy ko walking bola hai, tum wahi video wale ho na jo unhe samjha sake? Ghar aake dikha do kabhi.", handle: "padosi.aunty", label: "personal", language: "hinglish", hard: true },
  { text: "Society ke WhatsApp group mein sab tumhari video share kar rahe the aaj. Papa bahut khush ho rahe the sabko bata ke 😊", handle: "mummy.official", label: "personal", language: "hinglish" },
];

const UNCERTAIN_2: EvalCase[] = [
  { text: "Hi, got your contact from a mutual friend. There's something you might want to be part of. When can we speak?", handle: "mutual.friend.ref", label: "uncertain", language: "en" },
  { text: "Aapke field se related ek baat karni thi, DM mein nahi bata sakta. Number mil sakta hai?", handle: "secretive.sanjay", label: "uncertain", language: "hinglish" },
  { text: "Do you remember me from {city}? We met at that event. I have a proposal.", handle: "event.stranger", label: "uncertain", language: "en" },
  { text: "Namaste. Kaam ki baat hai. Reply kijiyega.", handle: "kaam.ki.baat", label: "uncertain", language: "hinglish" },
];

const UNIQUE_CASES: EvalCase[] = [
  ...BRAND,
  ...BRAND_2,
  ...COACHING,
  ...COACHING_2,
  ...COURSE,
  ...COURSE_2,
  ...OTHER,
  ...OTHER_2,
  ...FAN,
  ...FAN_2,
  ...SPAM,
  ...SPAM_2,
  ...PERSONAL,
  ...PERSONAL_2,
  ...UNCERTAIN,
  ...UNCERTAIN_2,
];

/**
 * Label-preserving slot expansion. A case without slots is emitted once per
 * substitution row only when `i === 0` — no duplicate inflation.
 */
export function expandGoldenSet(): EvalCase[] {
  const out: EvalCase[] = [];
  for (const c of UNIQUE_CASES) {
    const hasSlot = /\{niche\}|\{city\}|\{amount\}/.test(c.text);
    const variants = hasSlot ? NICHES.length : 1;
    for (let i = 0; i < variants; i++) {
      out.push({
        ...c,
        text: c.text
          .replace(/\{niche\}/g, NICHES[i % NICHES.length]!)
          .replace(/\{city\}/g, CITIES[i % CITIES.length]!)
          .replace(/\{amount\}/g, AMOUNTS[i % AMOUNTS.length]!),
      });
    }
  }
  return out;
}

export const GOLDEN_SET = expandGoldenSet();
