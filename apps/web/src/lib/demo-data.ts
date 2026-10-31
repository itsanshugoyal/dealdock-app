import {
  dealTypeForLabel,
  encodePcm16Wav,
  formatMoneyExact,
  type ClassificationLabel,
  type DealType,
  type DraftChip,
  type LearnedSignal,
  type MeasuredStyle,
  type MessageOrigin,
  type MessageSource,
  type MoneyContext,
  type OfferDto,
  type StyleCard,
  type VoiceRuleDto,
  type VoiceRuleScope,
  type VoiceSampleDto,
} from "@dealdock/core";
import { bytesToBase64 } from "./wav";

/**
 * Demo-mode fixtures and the small deterministic engines that stand in for the
 * API (drafting, learning signals, style measurement, voice-note audio).
 * Everything here is fictional sample data for local UI verification; the app
 * labels demo builds "Demo · sample data". Pure: no React, no storage.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const inr = (rupees: number) => rupees * 100;

export const DEMO_TIMEZONE = "Asia/Kolkata";
export const DEMO_MONEY: MoneyContext = { currency: "INR", locale: "en-IN" };
export const DEMO_CREATOR = { name: "Diya Mehra", firstName: "Diya", email: "diya@example.com", workspace: "Diya Mehra Studio" };
export const DEMO_ACCOUNTS = [
  { id: "ig-demo-diya", handle: "diya.moves" },
  { id: "ig-demo-rohan", handle: "rohan.cooks" },
  { id: "ig-demo-ira", handle: "ira.wanders" },
];
export const DEMO_ACCOUNT_ID = DEMO_ACCOUNTS[0]!.id;
/** Conversations the demo Leak Scan "reads" (the fixture corpus size). */
export const DEMO_SCANNED = 214;
export const DEMO_SCAN_COMMERCE = 38;

// ── Conversations ────────────────────────────────────────────────────────

export interface SeedMessage {
  inbound: boolean;
  /** Minutes before "now" at seed time. */
  ago: number;
  text: string;
  origin?: MessageOrigin;
  audio?: { durationMs: number; transcript: string; language: string };
}
export interface SeedThread {
  id: string;
  handle: string;
  name: string | null;
  followers: number | null;
  verified: boolean | null;
  followsYou: boolean | null;
  label: ClassificationLabel;
  confidence: number;
  rationale: string;
  min: number | null;
  max: number | null;
  state: "open" | "waiting";
  review?: boolean;
  source: MessageSource | null;
  messages: SeedMessage[];
  /** Minutes since the creator's last reply started the waiting clock. */
  waitingAgo?: number;
  signal?: { phrase: string; amountMinor: number | null; dealType: DealType | null };
  /** Seed a ready draft (reply) or a follow-up draft (nudge). */
  draft?: "reply" | "nudge";
  missingFacts?: string[];
  hinglish?: boolean;
  /** Creator account the conversation belongs to (agency demo); defaults to the first. */
  account?: string;
}

export const SEED_THREADS: SeedThread[] = [
  {
    id: "t-kesar", handle: "kesarandclay", name: "Kesar & Clay", followers: 182_400, verified: true, followsYou: false,
    label: "brand_deal", confidence: 0.93, rationale: "Asks for your rates on a paid campaign with clear deliverables.", min: inr(80_000), max: inr(150_000),
    state: "open", source: "dm", draft: "reply",
    messages: [{ inbound: true, ago: 70, text: "Hi Diya! We're Kesar & Clay, a skincare brand from Jaipur 🌿 Our Diwali campaign needs 2 reels + 3 stories in the first week of November. What are your rates? We'd love to have you on board." }],
  },
  {
    id: "t-monsoon", handle: "monsoonathletica", name: "Monsoon Athletica", followers: 96_400, verified: true, followsYou: false,
    label: "brand_deal", confidence: 0.9, rationale: "Retainer offer from a verified sportswear brand.", min: inr(120_000), max: inr(250_000),
    state: "open", source: "ad", draft: "reply",
    messages: [{ inbound: true, ago: 21 * 60 + 40, text: "Hey Diya, Monsoon Athletica here. We're putting together a 3-month ambassador program for our winter running line — monthly retainer plus a performance bonus. Could we set up a quick call this week?" }],
  },
  {
    id: "t-tiffin", handle: "tiffintheory.co", name: "Tiffin Theory", followers: 12_800, verified: false, followsYou: false,
    label: "other_commerce", confidence: 0.84, rationale: "Paid corporate workshop request with a team size and date.", min: inr(40_000), max: inr(70_000),
    state: "open", source: "link", missingFacts: ["your fee for a 90-minute team workshop"],
    messages: [{ inbound: true, ago: 23 * 60 + 25, text: "Hi! We're a 60-person team in Bengaluru. Could you run a 90-minute desk-fitness workshop for us before the Diwali break? Paid, of course — what would it cost?" }],
  },
  {
    id: "t-brightleaf", handle: "brightleaf.ayur", name: "Brightleaf Ayurveda", followers: 54_100, verified: true, followsYou: true,
    label: "brand_deal", confidence: 0.95, rationale: "Brand confirmed payment for an agreed reel package.", min: inr(60_000), max: inr(90_000),
    state: "open", source: "dm",
    signal: { phrase: "Payment's done from our side", amountMinor: inr(75_000), dealType: "brand" },
    messages: [
      { inbound: true, ago: 6 * 24 * 60, text: "Hi Diya, loved your morning routine reel. We'd like 1 reel + 2 stories for our new chyawanprash launch. Budget is around ₹75,000." },
      { inbound: false, ago: 6 * 24 * 60 - 50, origin: "dealdock", text: "Heyy! Thank you for thinking of me 🙏 That works — sending my deliverables and usage terms now. – D" },
      { inbound: true, ago: 5 * 24 * 60, text: "Perfect. Sharing the brief and the contract today." },
      { inbound: false, ago: 5 * 24 * 60 - 30, origin: "native", text: "Got it, will review tonight. – D" },
      { inbound: true, ago: 40, text: "Payment's done from our side — ₹75,000 sent to your account. Let's lock the reel for the 12th?" },
    ],
  },
  {
    id: "t-rhea", handle: "rhea.runs", name: "Rhea Sharma", followers: 2_140, verified: false, followsYou: true,
    label: "coaching_lead", confidence: 0.88, rationale: "Asks for your coaching fee and a start slot.", min: inr(24_000), max: inr(30_000),
    state: "open", source: "story", draft: "reply", hinglish: true,
    messages: [{ inbound: true, ago: 3 * 60, text: "Hiii! Saw your story about the 12-week program 😍 Abhi open hai? Fees kya hai? I'm serious this time, office ke baad 6am slot chahiye." }],
  },
  {
    id: "t-arjun", handle: "arjun.lifts", name: "Arjun Verma", followers: 860, verified: false, followsYou: true,
    label: "coaching_lead", confidence: 0.86, rationale: "Voice note asking for 1:1 coaching and the price.", min: inr(20_000), max: inr(30_000),
    state: "open", source: "dm", hinglish: true,
    messages: [{
      inbound: true, ago: 5 * 60, text: "",
      audio: { durationMs: 42_000, language: "hinglish", transcript: "Hey Diya, Arjun here. Main teen mahine se aapke workouts follow kar raha hoon. Ab mujhe proper one-on-one coaching chahiye, especially for my back. Kitna lagega aur kab start kar sakte hain?" },
    }],
  },
  {
    id: "t-meera", handle: "meera.codes", name: "Meera Iyer", followers: 5_300, verified: false, followsYou: false,
    label: "course_inquiry", confidence: 0.85, rationale: "Asks about the next cohort and an EMI option.", min: inr(7_999), max: inr(7_999),
    state: "open", source: "reel",
    messages: [{ inbound: true, ago: 2 * 24 * 60, text: "Is the next Strength Basics cohort open? EMI option hai kya? I missed the last batch 😅" }],
  },
  {
    id: "t-priya", handle: "priya.paints", name: "Priya Nair", followers: 1_200, verified: false, followsYou: false,
    label: "course_inquiry", confidence: 0.82, rationale: "Course format and price question.", min: inr(7_999), max: inr(7_999),
    state: "open", source: "dm",
    messages: [{ inbound: true, ago: 9 * 24 * 60, text: "Hey! Your course — is it recorded or live? And price kya hai?" }],
  },
  {
    id: "t-founders", handle: "thefounderscircle.in", name: "The Founders Circle", followers: 22_000, verified: false, followsYou: false,
    label: "other_commerce", confidence: 0.83, rationale: "Paid speaking session for a founders community.", min: inr(40_000), max: inr(55_000),
    state: "open", source: "dm",
    signal: { phrase: "let's lock it for the 14th", amountMinor: null, dealType: "other" },
    messages: [
      { inbound: true, ago: 3 * 24 * 60, text: "Would you do a 45-minute session on founder fitness for our members? It's paid." },
      { inbound: false, ago: 3 * 24 * 60 - 90, origin: "dealdock", text: "Heyy! I'd love that. Sending a couple of dates — what does your schedule look like? – D" },
      { inbound: true, ago: 2 * 60, text: "Sounds good, let's lock it for the 14th. Sending the advance today." },
    ],
  },
  {
    id: "t-karan", handle: "karan.k", name: "Karan Kapoor", followers: 430, verified: false, followsYou: true,
    label: "coaching_lead", confidence: 0.81, rationale: "Asks to book a paid 1:1 call.", min: inr(3_500), max: inr(3_500),
    state: "open", source: "dm",
    messages: [{ inbound: true, ago: 30, text: "Can I book a 1:1 call with you? Need help with my cut plan before the wedding season." }],
  },
  {
    id: "t-urbanloom", handle: "urbanloom.studio", name: "Urban Loom", followers: 38_900, verified: true, followsYou: false,
    label: "brand_deal", confidence: 0.9, rationale: "Activewear launch collab with a rate request.", min: inr(50_000), max: inr(80_000),
    state: "waiting", source: "dm", waitingAgo: 4 * 24 * 60, draft: "nudge",
    messages: [
      { inbound: true, ago: 6 * 24 * 60 + 120, text: "Hi Diya! We're launching activewear in December — interested in a 2-reel collab? What's your rate card?" },
      { inbound: false, ago: 4 * 24 * 60, origin: "native", text: "Heyy! Love Urban Loom. My rate for a reel + 2 stories is ₹60,000–₹90,000. Happy to share past results. – D" },
    ],
  },
  {
    id: "t-peakfuel", handle: "peakfuel.co", name: "PeakFuel", followers: 71_200, verified: true, followsYou: false,
    label: "brand_deal", confidence: 0.91, rationale: "Three-month partnership offer.", min: inr(70_000), max: inr(120_000),
    state: "waiting", source: "ad", waitingAgo: 5 * 24 * 60, draft: "nudge",
    messages: [
      { inbound: true, ago: 8 * 24 * 60, text: "Hey! Protein brand here — would you be up for a 3-month partnership? Monthly deliverables, flexible budget." },
      { inbound: false, ago: 5 * 24 * 60, origin: "dealdock", text: "Heyy! Yes, keen. Can you share the brief with deliverables and timeline? Then I'll send my rate. – D" },
    ],
  },
  {
    id: "t-sana", handle: "sana.moves", name: "Sana Qureshi", followers: 3_400, verified: false, followsYou: true,
    label: "coaching_lead", confidence: 0.87, rationale: "Asks for December coaching slots.", min: inr(24_000), max: inr(30_000),
    state: "waiting", source: "story", waitingAgo: 24 * 60,
    messages: [
      { inbound: true, ago: 2 * 24 * 60, text: "Do you have slots in December for coaching? I want to start before the new year." },
      { inbound: false, ago: 24 * 60, origin: "dealdock", text: "Heyy Sana! Yes — two slots left for December. Sending the details now. – D" },
    ],
  },
  {
    id: "t-campus", handle: "campus.fit.club", name: "Campus Fit Club", followers: 6_100, verified: false, followsYou: false,
    label: "other_commerce", confidence: 0.8, rationale: "Paid hosting request for a college fest.", min: inr(15_000), max: inr(25_000),
    state: "waiting", source: "link", waitingAgo: 2 * 24 * 60,
    messages: [
      { inbound: true, ago: 3 * 24 * 60, text: "Our college fest needs a fitness session host — paid. Interested?" },
      { inbound: false, ago: 2 * 24 * 60, origin: "native", text: "Heyy! Sounds fun — what date and how long? – D" },
    ],
  },
  {
    id: "t-saffron", handle: "saffronpantry", name: "Saffron Pantry", followers: 128_000, verified: true, followsYou: false,
    label: "brand_deal", confidence: 0.92, rationale: "Spice brand asks for a paid recipe series with clear deliverables.", min: inr(100_000), max: inr(180_000),
    state: "open", source: "dm", account: "ig-demo-rohan",
    messages: [{ inbound: true, ago: 2 * 60 + 15, text: "Hi Rohan! Saffron Pantry here. We'd love a 3-reel festive recipe series using our new garam masala. What would that cost? Shoot window is 10–20 Nov." }],
  },
  {
    id: "t-castiron", handle: "castiron.co.in", name: "Cast Iron Co", followers: 41_300, verified: false, followsYou: true,
    label: "brand_deal", confidence: 0.86, rationale: "Cookware brand offers a paid collab and asks for rates.", min: inr(45_000), max: inr(80_000),
    state: "open", source: "ad", account: "ig-demo-rohan",
    messages: [{ inbound: true, ago: 19 * 60, text: "Hey Rohan, big fan of your tadka reels! Would you do 1 reel + 2 stories with our seasoned kadai? Budget is flexible, please share rates." }],
  },
  {
    id: "t-baking", handle: "ananya.bakes", name: "Ananya Rao", followers: 760, verified: false, followsYou: true,
    label: "course_inquiry", confidence: 0.83, rationale: "Asks about the price of the weekend cooking class.", min: inr(4_999), max: inr(4_999),
    state: "open", source: "story", account: "ig-demo-rohan", hinglish: true,
    messages: [{ inbound: true, ago: 6 * 60, text: "Weekend cooking class ka next batch kab hai? Fees kitni hai? Mere saath meri sister bhi aayegi" }],
  },
  {
    id: "t-ferns", handle: "fernshotels", name: "Ferns Hotels", followers: 212_000, verified: true, followsYou: false,
    label: "brand_deal", confidence: 0.9, rationale: "Hotel group offers a paid stay with deliverables.", min: inr(70_000), max: inr(120_000),
    state: "open", source: "dm", account: "ig-demo-ira",
    messages: [{ inbound: true, ago: 4 * 60 + 40, text: "Hi Ira, Ferns Hotels here. We'd like to host you at our Coorg resort for 3 nights in December: 2 reels + 4 stories, paid. Are you open to it? What are your rates?" }],
  },
  {
    id: "t-itinerary", handle: "kabir.travels", name: "Kabir Malhotra", followers: 1_900, verified: false, followsYou: true,
    label: "other_commerce", confidence: 0.81, rationale: "Paid itinerary planning request with dates.", min: inr(12_000), max: inr(18_000),
    state: "open", source: "reel", account: "ig-demo-ira",
    messages: [{ inbound: true, ago: 26 * 60, text: "Do you plan custom itineraries? 10 days in Japan for two in March, happy to pay for your time." }],
  },
  {
    id: "r-collab", handle: "collab.desk.in", name: null, followers: 410, verified: false, followsYou: false,
    label: "brand_deal", confidence: 0.42, rationale: "Vague business opener; no brand or ask is named.", min: null, max: null,
    state: "open", review: true, source: "dm",
    messages: [{ inbound: true, ago: 4 * 60, text: "Hi, interesting profile. We should talk sometime about opportunities." }],
  },
  {
    id: "r-ankit", handle: "ankit_v", name: "Ankit V", followers: 210, verified: false, followsYou: true,
    label: "coaching_lead", confidence: 0.61, rationale: "Mentions work, but not what kind.", min: null, max: null,
    state: "open", review: true, source: "dm",
    messages: [{ inbound: true, ago: 7 * 60, text: "Aapse baat karni thi kaam ke baare mein." }],
  },
  {
    id: "r-neha", handle: "neha.yoga.sutra", name: "नेहा", followers: 2_300, verified: false, followsYou: true,
    label: "coaching_lead", confidence: 0.64, rationale: "Asks about classes and fees in Hindi.", min: null, max: null,
    state: "open", review: true, source: "dm",
    messages: [{ inbound: true, ago: 11 * 60, text: "नमस्ते दीया जी, क्या आप ऑनलाइन योग क्लास भी लेती हैं? फीस कितनी है?" }],
  },
  {
    id: "r-nisha", handle: "nisha.creates", name: "Nisha", followers: 15_600, verified: false, followsYou: false,
    label: "other_commerce", confidence: 0.58, rationale: "Offers something without saying what.", min: null, max: null,
    state: "open", review: true, source: "reel",
    messages: [{ inbound: true, ago: 26 * 60, text: "Hey! Got something you might like. Can I share?" }],
  },
  {
    id: "r-growth", handle: "growthwala.agency", name: null, followers: 980, verified: false, followsYou: false,
    label: "spam", confidence: 0.7, rationale: "Follower-growth pitch; asks for nothing specific yet.", min: null, max: null,
    state: "open", review: true, source: "dm",
    messages: [{ inbound: true, ago: 2 * 24 * 60 + 60, text: "We help creators 10x their reach in 30 days. Free audit for you — reply YES." }],
  },
];

// ── Ledger history (six months, recovered money climbing toward the goal) ──

export interface SeedSale { monthsAgo: number; day: number; handle: string; name: string; dealType: DealType; rupees: number; note?: string }
export const SEED_SALES: SeedSale[] = [
  { monthsAgo: 0, day: 3, handle: "glowtonic.in", name: "GlowTonic", dealType: "brand", rupees: 75_000, note: "Diwali reel + 2 stories" },
  { monthsAgo: 0, day: 8, handle: "vikram.trains", name: "Vikram Rao", dealType: "coaching", rupees: 24_000 },
  { monthsAgo: 0, day: 12, handle: "learnwithtara", name: "Tara Bose", dealType: "course", rupees: 7_999 },
  { monthsAgo: 0, day: 19, handle: "freshbowl.co", name: "FreshBowl", dealType: "brand", rupees: 120_000, note: "Usage rights for 3 months" },
  { monthsAgo: 0, day: 24, handle: "ananya.k", name: "Ananya K", dealType: "coaching", rupees: 30_000 },
  { monthsAgo: 0, day: 27, handle: "stride.collective", name: "Stride Collective", dealType: "other", rupees: 45_000, note: "Corporate workshop" },
  { monthsAgo: 1, day: 4, handle: "monsoonchai", name: "Monsoon Chai Co.", dealType: "brand", rupees: 90_000 },
  { monthsAgo: 1, day: 11, handle: "dev.gains", name: "Dev Malhotra", dealType: "coaching", rupees: 24_000 },
  { monthsAgo: 1, day: 15, handle: "zenpath.yoga", name: "ZenPath", dealType: "brand", rupees: 85_000 },
  { monthsAgo: 1, day: 22, handle: "kriti.reads", name: "Kriti", dealType: "course", rupees: 7_999 },
  { monthsAgo: 1, day: 26, handle: "rohit.runs", name: "Rohit", dealType: "coaching", rupees: 30_000 },
  { monthsAgo: 2, day: 6, handle: "bloomwell.in", name: "Bloomwell", dealType: "brand", rupees: 70_000 },
  { monthsAgo: 2, day: 14, handle: "aisha.fit", name: "Aisha", dealType: "coaching", rupees: 24_000 },
  { monthsAgo: 2, day: 20, handle: "pune.devs", name: "Pune Devs", dealType: "other", rupees: 40_000 },
  { monthsAgo: 2, day: 27, handle: "nikhil.k", name: "Nikhil", dealType: "course", rupees: 7_999 },
  { monthsAgo: 3, day: 9, handle: "tealeaf.co", name: "TeaLeaf", dealType: "brand", rupees: 110_000 },
  { monthsAgo: 3, day: 16, handle: "maya.moves", name: "Maya", dealType: "coaching", rupees: 30_000 },
  { monthsAgo: 3, day: 23, handle: "sid.strong", name: "Sid", dealType: "coaching", rupees: 24_000 },
  { monthsAgo: 4, day: 5, handle: "urbanroots.in", name: "Urban Roots", dealType: "brand", rupees: 60_000 },
  { monthsAgo: 4, day: 18, handle: "jaya.lifts", name: "Jaya", dealType: "coaching", rupees: 24_000 },
  { monthsAgo: 4, day: 25, handle: "omkar.reads", name: "Omkar", dealType: "course", rupees: 7_999 },
  { monthsAgo: 5, day: 10, handle: "freshpress.juice", name: "FreshPress", dealType: "brand", rupees: 55_000 },
  { monthsAgo: 5, day: 21, handle: "ritu.trains", name: "Ritu", dealType: "coaching", rupees: 24_000 },
];
export const DEMO_GOAL_MINOR = inr(400_000);
export const DEMO_LEAK_BASELINE_MINOR = inr(180_000);

const SALE_ASKS: Record<DealType, string> = {
  brand: "Hi Diya! We'd love a reel + stories for our launch. Can you share your rates?",
  coaching: "Hey! Is the 12-week coaching open? What are the fees?",
  course: "Is the Strength Basics cohort still open? How do I join?",
  other: "Could you run a paid session for our team next month?",
};
export function saleConversation(sale: SeedSale): SeedMessage[] {
  return [
    { inbound: true, ago: 0, text: SALE_ASKS[sale.dealType] },
    { inbound: false, ago: 0, origin: "dealdock", text: "Heyy! Yes — sending the details and the link now. – D" },
    { inbound: true, ago: 0, text: "Done, payment sent. Thank you!" },
  ];
}

// ── Offers ───────────────────────────────────────────────────────────────

export function seedOffers(now: number): OfferDto[] {
  const updatedAt = new Date(now - 3 * DAY).toISOString();
  const base = { igAccountId: null, currencyCode: "INR" as const, updatedAt };
  return [
    { ...base, id: "offer-reel", name: "Reel + 2 stories", dealType: "brand", priceMinMinor: inr(60_000), priceMaxMinor: inr(90_000), link: "https://example.com/diya/rate-card", details: "Usage rights +30%. Exclusivity on request.", availability: "2 slots left in November", active: true, sortOrder: 0 },
    { ...base, id: "offer-coaching", name: "12-week transformation coaching", dealType: "coaching", priceMinMinor: inr(24_000), priceMaxMinor: inr(30_000), link: "https://example.com/diya/12-week", details: "Weekly check-ins, a custom plan and WhatsApp support.", availability: "4 spots in the December batch", active: true, sortOrder: 1 },
    { ...base, id: "offer-cohort", name: "Strength Basics cohort", dealType: "course", priceMinMinor: inr(7_999), priceMaxMinor: null, link: "https://example.com/diya/strength-basics", details: "Six weeks, live and recorded. EMI available.", availability: "Next cohort starts 1 December", active: true, sortOrder: 2 },
    { ...base, id: "offer-call", name: "1:1 strategy call", dealType: "coaching", priceMinMinor: inr(3_500), priceMaxMinor: null, link: "https://example.com/diya/call", details: "45 minutes on training or nutrition.", availability: null, active: true, sortOrder: 3 },
    { ...base, id: "offer-workshop", name: "Corporate wellness workshop", dealType: "other", priceMinMinor: inr(40_000), priceMaxMinor: inr(60_000), link: null, details: "90 minutes, up to 80 people, in person or online.", availability: null, active: false, sortOrder: 4 },
  ];
}

// ── Your voice ───────────────────────────────────────────────────────────

const SAMPLE_TEXTS: Array<[string, MessageOrigin, number]> = [
  ["Heyy! Thank you for thinking of me 🙏 Sending my rates and deliverables now. – D", "native", 2],
  ["Heyy Sana! Yes — two slots left for December. Sending the details now. – D", "dealdock", 1],
  ["Haha no stress, take your time. Batch starts 1 Dec. – D", "native", 4],
  ["Heyy! Love that you're serious about this. Fees are ₹24,000 for 12 weeks, EMI bhi hai. Want the link? – D", "native", 5],
  ["Yesss let's do it! Sending the brief back tonight. – D", "native", 6],
  ["Heyy, thanks yaar! Recorded + live dono hai. Link bhejti hoon. – D", "native", 8],
  ["Heyy! Love Urban Loom. My rate for a reel + 2 stories is ₹60,000–₹90,000. Happy to share past results. – D", "native", 4],
  ["Got it, will review tonight. – D", "native", 5],
  ["Heyy! Abhi slots full hain, but the January batch is open. Waitlist pe daal doon? – D", "native", 11],
  ["Thank you so much 🙏 See you on the call!", "native", 12],
  ["Heyy! Can you share the brief with deliverables and timeline first? Then I'll send my rate. – D", "dealdock", 5],
  ["Hey! Thanks for reaching out. Could you share the brief with deliverables, timeline and budget range?", "dealdock", 15],
  ["Heyy! Sounds fun — what date and how long? – D", "native", 2],
  ["Haan bilkul, 6am slot available hai. Sending the form. – D", "native", 18],
  ["Use code DIYA10 for 10% off the cohort 🛍️", "automation", 20],
  ["Heyy! I'd love that. Sending a couple of dates — what does your schedule look like? – D", "dealdock", 3],
];
export function seedSamples(now: number): VoiceSampleDto[] {
  return SAMPLE_TEXTS.map(([text, origin, daysAgo], index) => ({
    messageId: `sample-${index + 1}`,
    text,
    sentAt: new Date(now - daysAgo * DAY - index * HOUR).toISOString(),
    origin,
    excluded: origin === "automation",
    weight: origin === "native" ? 1 : origin === "dealdock" ? (text.startsWith("Hey!") ? 0.5 : 0.8) : 0,
  }));
}
export const SAMPLE_INBOUND: Record<string, string> = {
  "sample-1": "Hi! Would love to collaborate on our launch. What are your rates?",
  "sample-4": "Is your coaching open? Fees kya hai?",
  "sample-7": "What's your rate card for a 2-reel collab?",
  "sample-11": "Paid collab for our winter line — interested?",
};

export function seedRules(now: number): VoiceRuleDto[] {
  const at = (days: number) => new Date(now - days * DAY).toISOString();
  return [
    { id: "rule-heyy", key: "greeting.heyy", text: "Open with “Heyy” instead of “Hi”", scope: "all", status: "candidate", source: "edits", evidence: 3, against: 0, updatedAt: at(1),
      examples: [{ before: "Hi! Thanks for reaching out — this sounds great.", after: "Heyy! Thanks for reaching out — this sounds great." }, { before: "Hi Sana, yes we have slots.", after: "Heyy Sana! Yes — two slots left." }] },
    { id: "rule-brief-first", key: "brand.brief_first", text: "Ask brands for the brief before quoting a rate", scope: "brand_deal", status: "candidate", source: "edits", evidence: 2, against: 1, updatedAt: at(2),
      examples: [{ before: "My rate for a reel is ₹60,000. Let me know!", after: "Can you share the brief with deliverables and timeline first? Then I'll send my rate." }] },
    { id: "rule-signoff", key: "signoff.d", text: "Sign off with “– D”", scope: "all", status: "active", source: "samples", evidence: 41, against: 2, updatedAt: at(9), examples: [] },
    { id: "rule-coaching-short", key: "length.coaching_lead", text: "Keep coaching replies under 50 words", scope: "coaching_lead", status: "active", source: "edits", evidence: 7, against: 1, updatedAt: at(4),
      examples: [{ before: "Hey! Thank you so much for your message. My 12-week program includes weekly check-ins, a custom workout plan, nutrition guidance and WhatsApp support, and it costs ₹24,000.", after: "Heyy! 12 weeks, weekly check-ins, ₹24,000. Want the link? – D" }] },
    { id: "rule-no-price-first", key: "brand.no_price_first", text: "Never quote prices in the first reply to a brand", scope: "brand_deal", status: "pinned", source: "user", evidence: 0, against: 0, updatedAt: at(20), examples: [] },
    { id: "rule-pray", key: "emoji.pray", text: "End replies with 🙏", scope: "all", status: "muted", source: "feedback", evidence: 2, against: 4, updatedAt: at(6), examples: [] },
  ];
}

const EMOJI = /\p{Extended_Pictographic}/u;
const HINGLISH_WORDS = new Set(["hai", "hain", "kya", "nahi", "haan", "bilkul", "yaar", "abhi", "bhi", "dono", "bhejti", "hoon", "pe", "daal", "doon", "ke", "baad", "chahiye", "kitna", "kab", "mein", "aap", "aapke", "ji", "bhejun", "kar", "raha"]);
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** Measured fingerprint of a set of replies (Your voice → "How you write"). */
export function measureStyle(texts: string[], scope: VoiceRuleScope = "all"): MeasuredStyle {
  const counts = texts.map((text) => words(text).length);
  const tokens = texts.flatMap(words);
  const tally = (pick: (text: string) => string | null) => {
    const map = new Map<string, number>();
    for (const text of texts) { const key = pick(text); if (key) map.set(key, (map.get(key) ?? 0) + 1); }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key]) => key);
  };
  return {
    scope,
    samples: texts.length,
    avgWords: texts.length ? Math.round(counts.reduce((a, b) => a + b, 0) / texts.length) : 0,
    emojiRate: texts.length ? Math.round((texts.filter((text) => EMOJI.test(text)).length / texts.length) * 100) / 100 : 0,
    hinglishIndex: tokens.length ? Math.round((tokens.filter((token) => HINGLISH_WORDS.has(token)).length / tokens.length) * 100) / 100 : 0,
    topOpeners: tally((text) => text.split(/[\s!,.—]+/)[0] || null),
    topSignoffs: tally((text) => (/– D\s*$/.test(text) ? "– D" : null)),
  };
}

/** A plausible style card derived from the creator's own (included) replies. */
export function styleCardFrom(texts: string[]): StyleCard {
  const measured = measureStyle(texts);
  return {
    greeting: measured.topOpeners[0] ?? "Hey",
    tone: "Warm, direct and a little playful",
    sentenceLength: measured.avgWords <= 16 ? "short" : measured.avgWords <= 32 ? "medium" : "long",
    signoff: measured.topSignoffs[0] ?? "",
    emojiUsage: measured.emojiRate === 0 ? "none" : measured.emojiRate < 0.4 ? "light" : "heavy",
    codeSwitching: measured.hinglishIndex > 0.03 ? "Hinglish with followers, English with brands" : "English",
    characteristicPhrases: ["no stress", "let's do it", "sending the details now"],
    avoidPhrases: ["Dear Sir/Madam", "Kindly revert"],
  };
}

export const WEEKLY_MATCH = [48, 52, 55, 61, 63, 68, 71, 74];
export const WEEKLY_SENT = [6, 9, 8, 11, 10, 12, 13, 9];

// ── Drafting: deterministic transforms honouring chips and instructions ──

export interface DraftSubject {
  label: ClassificationLabel | null;
  kind: "reply" | "nudge";
  firstName: string | null;
  hinglish: boolean;
  declined?: boolean;
}

const SIGNOFF = "– D";
function money(minor: number | null, ctx: MoneyContext) { return minor === null ? "" : formatMoneyExact(minor, ctx); }
export function offerPrice(offer: OfferDto, ctx: MoneyContext): string {
  if (offer.priceMinMinor === null) return "price on request";
  return offer.priceMaxMinor && offer.priceMaxMinor !== offer.priceMinMinor ? `${money(offer.priceMinMinor, ctx)}–${money(offer.priceMaxMinor, ctx)}` : money(offer.priceMinMinor, ctx);
}
export function offerFor(label: ClassificationLabel | null, offers: OfferDto[]): OfferDto | null {
  const type = dealTypeForLabel(label);
  return offers.find((offer) => offer.active && offer.dealType === type) ?? null;
}

export function baseDraft(subject: DraftSubject, offers: OfferDto[], ctx: MoneyContext): string {
  const hi = subject.firstName ? `Heyy ${subject.firstName}!` : "Heyy!";
  if (subject.kind === "nudge") return `${hi} Just circling back on this — still keen to make it work if you are. Any update on your side? ${SIGNOFF}`;
  const offer = offerFor(subject.label, offers);
  switch (subject.label) {
    case "brand_deal":
      return `${hi} Thank you for thinking of me 🙏 This sounds like a lovely fit. Could you share the brief — deliverables, timeline and usage? Then I'll send my rate card. ${SIGNOFF}`;
    case "coaching_lead":
      return subject.hinglish
        ? `${hi} Haan, the 12-week program abhi open hai 🙌 Fees ${offer ? offerPrice(offer, ctx) : "share karti hoon"}, EMI bhi hai. Morning slots available hain — link bhejun? ${SIGNOFF}`
        : `${hi} Love that you're serious about this. The 12-week program is open — fees are ${offer ? offerPrice(offer, ctx) : "on the link"} with weekly check-ins. Want me to send the link? ${SIGNOFF}`;
    case "course_inquiry":
      return `${hi} Yes, the next Strength Basics cohort is open — ${offer ? offerPrice(offer, ctx) : "details on the link"}, live and recorded, and EMI is available. Sending the link now. ${SIGNOFF}`;
    default:
      return `${hi} Sounds great — happy to do it. Could you share the date, audience size and session length? I'll send my fee right after. ${SIGNOFF}`;
  }
}

const TO_HINGLISH: Array<[RegExp, string]> = [
  [/\bThank you\b/, "Thank you so much yaar"],
  [/\bSending the link now\b/, "Link abhi bhejti hoon"],
  [/\bWant me to send the link\?/, "Link bhejun?"],
  [/\bYes,/, "Haan,"],
  [/\bSounds great\b/, "Bilkul, sounds great"],
  [/\bCould you share\b/, "Kya aap share kar sakte ho"],
];
const TO_ENGLISH: Array<[RegExp, string]> = [
  [/Thank you so much yaar/, "Thank you"],
  [/Link abhi bhejti hoon/, "Sending the link now"],
  [/link bhejun\?/i, "want me to send the link?"],
  [/\bHaan,\s*/, "Yes, "],
  [/abhi open hai/, "is open"],
  [/share karti hoon/, "on the link"],
  [/EMI bhi hai/, "EMI is available"],
  [/Morning slots available hain/, "Morning slots are available"],
  [/Bilkul, /, ""],
  [/Kya aap share kar sakte ho/, "Could you share"],
];
const EMOJI_ALL = new RegExp("\\s?\\p{Extended_Pictographic}\\uFE0F?", "gu");

function beforeSignoff(body: string, sentence: string): string {
  return body.endsWith(SIGNOFF) ? `${body.slice(0, -SIGNOFF.length).trimEnd()} ${sentence} ${SIGNOFF}` : `${body} ${sentence}`;
}
function sentences(body: string): string[] {
  return body.replace(` ${SIGNOFF}`, "").match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [body];
}

/** One steering chip → a deterministic rewrite (demo stand-in for the model). */
export function applyChip(body: string, chip: DraftChip, subject: DraftSubject, offers: OfferDto[], ctx: MoneyContext): string {
  switch (chip) {
    case "shorter": {
      const parts = sentences(body);
      return `${parts.slice(0, Math.min(2, parts.length)).join(" ")} ${body.endsWith(SIGNOFF) ? SIGNOFF : ""}`.trim();
    }
    case "longer":
      return beforeSignoff(body, "Happy to share results from similar collaborations too.");
    case "warmer":
      return body.replace(/^(Heyy[^!]*!)/, "$1 So lovely to hear from you.");
    case "more_formal":
      return body.replace(/^Heyy/, "Hello").replace(EMOJI_ALL, "").replace(SIGNOFF, `Best, ${DEMO_CREATOR.firstName}`).replace(/\s{2,}/g, " ");
    case "more_casual":
      return body.replace(/^Hello/, "Heyy").replace(/Best, \w+$/, SIGNOFF).replace(/\.\s+(?=\S)/, " — no stress at all. ");
    case "more_hinglish":
      return TO_HINGLISH.reduce((text, [pattern, value]) => text.replace(pattern, value), body);
    case "more_english":
      return TO_ENGLISH.reduce((text, [pattern, value]) => text.replace(pattern, value), body);
    case "add_emoji":
      return EMOJI.test(body) ? body : beforeSignoff(body, "🙌");
    case "no_emoji":
      return body.replace(EMOJI_ALL, "").replace(/\s{2,}/g, " ");
    case "ask_budget":
      return beforeSignoff(body, "What budget do you have in mind for this?");
    case "quote_rate": {
      const offer = offerFor(subject.label, offers);
      return offer ? beforeSignoff(body, `My rate for ${offer.name.toLowerCase()} is ${offerPrice(offer, ctx)}.`) : body;
    }
    case "decline_politely":
      return `${subject.firstName ? `Heyy ${subject.firstName}!` : "Heyy!"} Thank you so much for thinking of me 🙏 I'm fully booked this month, so I'll have to pass for now — would love to stay in touch for the next one. ${SIGNOFF}`;
    case "wrong_facts":
    default:
      return body;
  }
}

/** Free-text steering: "say I'm booked till March" → "I'm booked till March." before the sign-off. */
export function applyInstruction(body: string, instruction: string): string {
  const cleaned = instruction.trim().replace(/^(please\s+)?(say|mention|tell them|add|note)( that)?\s+/i, "").replace(/[.!\s]+$/, "");
  if (!cleaned) return body;
  return beforeSignoff(body, `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}.`);
}

/** What changed between the draft and what the creator actually sent ("Noted: …"). */
export function learnedSignals(draft: string, finalText: string, label: ClassificationLabel | null): LearnedSignal[] {
  const signals: LearnedSignal[] = [];
  const scope: VoiceRuleScope = label ?? "all";
  if (/^heyy\b/i.test(finalText.trim()) && !/^heyy\b/i.test(draft.trim())) signals.push({ key: "greeting.heyy", text: "you open with “Heyy”", scope: "all" });
  const before = words(draft).length;
  const after = words(finalText).length;
  if (before > 0 && after < before * 0.7) signals.push({ key: `length.${scope}`, text: "you keep these replies shorter", scope });
  if (EMOJI.test(draft) && !EMOJI.test(finalText)) signals.push({ key: `emoji.none.${scope}`, text: "you skip emoji here", scope });
  if (/– D\s*$/.test(finalText) && !/– D\s*$/.test(draft)) signals.push({ key: "signoff.d", text: "you sign off with “– D”", scope: "all" });
  return signals;
}

// ── Voice-note audio (demo only: a soft tone per word, clearly not a voice) ──

const TONE_RATE = 8_000;

/** 8 kHz mono 16-bit PCM WAV (encodePcm16Wav); one short tone per word, max ~4 s. */
export function toneWav(text: string, maxSeconds = 4): Uint8Array {
  const wordCount = Math.max(1, Math.min(words(text).length || 1, maxSeconds * 4));
  const samplesPerWord = Math.floor(TONE_RATE * 0.22);
  const gap = Math.floor(TONE_RATE * 0.04);
  // The gap between words stays silent: a fresh Float32Array is all zeros.
  const samples = new Float32Array(wordCount * (samplesPerWord + gap));
  for (let w = 0; w < wordCount; w++) {
    const frequency = 220 + ((w * 47) % 140);
    const start = w * (samplesPerWord + gap);
    for (let i = 0; i < samplesPerWord; i++) {
      const envelope = Math.sin((Math.PI * i) / samplesPerWord);
      samples[start + i] = 0.3125 * envelope * Math.sin((2 * Math.PI * frequency * i) / TONE_RATE);
    }
  }
  return encodePcm16Wav(samples, TONE_RATE);
}
export function wavDataUrl(bytes: Uint8Array): string {
  return `data:audio/wav;base64,${bytesToBase64(bytes)}`;
}
/** Playing time of a PCM WAV: its data bytes over the header's byte rate. */
export function wavDurationMs(bytes: Uint8Array): number {
  const byteRate = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(28, true);
  return byteRate ? Math.round(((bytes.length - 44) / byteRate) * 1000) : 0;
}
