import type { ClassificationLabel } from "@dealdock/core";

/**
 * Seed corpus for the MockInstagramAdapter — realistic Indian-creator DM shapes
 * across all 8 classes (PRD §6.2), Hinglish-weighted (PRD risk §10.1.2).
 * The full labelled eval corpus (≥200 messages) lands in M0 — this file seeds
 * the demo loop. `expectedLabel` is fixture ground truth for contract tests;
 * production classification never sees it.
 */

export interface FixtureMessage {
  handle: string;
  text: string;
  expectedLabel: ClassificationLabel;
  minutesAgo: number;
}

export const FIXTURE_MESSAGES: FixtureMessage[] = [
  {
    handle: "herbalindia_official",
    text: "Hi! We loved your recent reel on morning routines. We'd like to discuss a paid collaboration for our Q3 campaign — 3 reels + 2 stories. Budget is flexible for the right fit. Can we share the brief?",
    expectedLabel: "brand_deal",
    minutesAgo: 120,
  },
  {
    handle: "vikram.lifts91",
    text: "Bhai your 12-week transformation program ke baare mein poochna tha — 1-on-1 coaching bhi karte ho kya? Charges kitne hain?",
    expectedLabel: "coaching_lead",
    minutesAgo: 240,
  },
  {
    handle: "anjali_learns",
    text: "Hey! Is the next cohort of your content creator course still open? Maine waitlist join kiya tha last month. Payment plan available hai kya?",
    expectedLabel: "course_inquiry",
    minutesAgo: 300,
  },
  {
    handle: "startupdesi.in",
    text: "Namaste! We run a D2C founders community. Would you be open to a paid workshop session for our members? Around 90 minutes, aapki fees bata dijiye.",
    expectedLabel: "other_commerce",
    minutesAgo: 480,
  },
  {
    handle: "rohan_fan123",
    text: "Love your content bhai!! 🔥🔥 aapki wajah se gym jana start kiya",
    expectedLabel: "fan",
    minutesAgo: 15,
  },
  {
    handle: "growfast.agency.2026",
    text: "We help influencers 10x their followers GUARANTEED. Check our page and DM 'GROW' for free audit!!",
    expectedLabel: "spam",
    minutesAgo: 60,
  },
  {
    handle: "priyasharma_sis",
    text: "Bhaiya Sunday ko ghar aa rahe ho na? Mummy pooch rahi thi",
    expectedLabel: "personal",
    minutesAgo: 90,
  },
  {
    handle: "wellness.collab.hub",
    text: "Hi, interesting profile. We should talk sometime about opportunities.",
    expectedLabel: "uncertain",
    minutesAgo: 200,
  },
];
