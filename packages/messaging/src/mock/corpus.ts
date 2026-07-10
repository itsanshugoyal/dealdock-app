import type { ClassificationLabel } from "@dealdock/core";
import { FIXTURE_MESSAGES, type FixtureMessage } from "./fixtures";

/**
 * Deterministic template-expanded corpus (M0 target: ≥200 labelled messages,
 * Hinglish-weighted — PLAN.md M0). Curated seeds in fixtures.ts remain the
 * demo set; this expansion feeds ingestion-volume tests and, in M2, seeds the
 * golden eval set (which then grows with hand-labelled + anonymized pilot data).
 */

interface Template {
  label: ClassificationLabel;
  /** `{h}` = handle slot, `{n}` = niche noun slot */
  texts: string[];
}

const NICHES = ["fitness", "skincare", "personal finance", "cooking", "travel"];

const HANDLE_POOLS: Record<string, string[]> = {
  brand: ["glowherbals.in", "fitfuel_official", "urbanthreads.co", "ayurroots_brand", "peakwear.in"],
  person: ["rahul_j92", "sneha.builds", "arjunk_daily", "meera_paints", "dev_lifts", "tanya.speaks"],
  spam: ["growth.gurus.4u", "viral_boost_agency", "collab.kingz", "promo_blast_in"],
};

const TEMPLATES: Template[] = [
  {
    label: "brand_deal",
    texts: [
      "Hi! We're launching a new {n} range next month. Would love to discuss a paid partnership — 2 reels + 3 stories. Budget bata dijiye, we're flexible for the right creator.",
      "Namaste! Our marketing team shortlisted you for our {n} campaign. Deliverables: 1 reel, 1 static post. Can we send the brief and commercials?",
      "Hey, loved your recent {n} content. We have budget approved for Q3 creator collabs. Are you open to a paid partnership? Media kit share karenge?",
      "Hello! We work with D2C brands in {n}. One of our clients wants a 3-month ambassadorship with you. Monthly retainer + performance bonus. Interested?",
      "Hi team! Diwali campaign ke liye we want 2 dedicated reels. What are your rates? Timeline is tight so quick reply appreciated 🙏",
    ],
  },
  {
    label: "coaching_lead",
    texts: [
      "Bhai your {n} transformation posts are insane. Do you take 1-on-1 clients? Fees kya hai?",
      "Hi! I've been following your {n} journey for 6 months. Main serious hoon — personal coaching available hai kya? Budget is not an issue.",
      "Sir, mujhe aapke coaching program ke baare mein jaanna hai. 3 month wala plan kitne ka hai?",
      "Hey! Saw your client results. I want to sign up for coaching — how do I start? Payment options?",
      "Aapka 12-week program abhi open hai? Office ke saath manage ho jayega na? Details please!",
    ],
  },
  {
    label: "course_inquiry",
    texts: [
      "Is the next cohort of your {n} course open? Waitlist join kiya tha, koi update?",
      "Hi! Course ka price kya hai? EMI option available hai kya? Really want to join this batch.",
      "Your course curriculum mein live sessions hain ya recorded? Thinking of enrolling this month.",
      "Bhai course refund policy kya hai? Job ke saath time nahi mila toh? Otherwise ready to enroll.",
      "Enrolled friends ne recommend kiya. Next batch kab se start? Seats bachi hain?",
    ],
  },
  {
    label: "other_commerce",
    texts: [
      "Hi! We run a founders community. Paid workshop session for our members — 90 minutes on {n}. Aapki fees?",
      "Hello, would you consult for our startup on {n} strategy? Paid engagement, 2 calls per month.",
      "We're organising a {n} summit in Bangalore. Speaker fees ke saath invite karna chahte hain. Interested?",
      "Can we license your {n} content for our app? Happy to discuss commercial terms.",
    ],
  },
  {
    label: "fan",
    texts: [
      "Bhai aap legend ho 🔥🔥 aapki wajah se {n} start kiya maine",
      "Love your content!! Please keep posting 🙏❤️",
      "Aaj ka reel dekha... goosebumps. Respect++",
      "You inspire me so much didi! Ek din aapse milna hai",
      "Best {n} creator in India, period.",
    ],
  },
  {
    label: "spam",
    texts: [
      "We help influencers 10x followers GUARANTEED!! DM 'GROW' for FREE audit 🚀🚀",
      "Collab? Collab? Collab? Check our page for paid promotion packages!!",
      "Sir ji, buy 10k followers only ₹999. Instant delivery. Limited offer!!!",
      "Congratulations! You've been selected as brand ambassador. Pay ₹2000 registration to claim.",
    ],
  },
  {
    label: "personal",
    texts: [
      "Bhaiya Sunday ko ghar aa rahe ho na? Mummy pooch rahi thi",
      "Yaar call kar jab free ho, kuch important baat karni hai",
      "Happy birthday!! Party kab de raha hai 😄",
    ],
  },
  {
    label: "uncertain",
    texts: [
      "Hi, interesting profile. We should talk sometime about opportunities.",
      "Hello sir. Message me back when free. Important.",
      "Hey! Got something you might like. Can I share?",
      "Aapse baat karni thi kaam ke baare mein.",
    ],
  },
];

function poolFor(label: ClassificationLabel): string[] {
  if (label === "brand_deal" || label === "other_commerce") return HANDLE_POOLS.brand!;
  if (label === "spam") return HANDLE_POOLS.spam!;
  return HANDLE_POOLS.person!;
}

/** Opener variants — second expansion axis so non-slotted texts still multiply. */
const OPENERS = ["", "Hey! ", "Hi ji, ", "Namaste! "];

/** Spread messages over ~29 days (Leak Scan realism); deterministic, no RNG. */
function spreadMinutes(seq: number): number {
  return 30 + ((seq * 977) % (60 * 24 * 29));
}

/**
 * Deterministic expansion: texts with a `{n}` slot expand across all niches ×
 * 2 openers; texts without expand across all 4 openers. Yields 200+ messages.
 */
export function generateCorpus(): FixtureMessage[] {
  const corpus: FixtureMessage[] = [...FIXTURE_MESSAGES];
  let seq = 0;

  const push = (template: Template, text: string) => {
    const handles = poolFor(template.label);
    corpus.push({
      handle: handles[seq % handles.length]!,
      text,
      expectedLabel: template.label,
      minutesAgo: spreadMinutes(seq),
    });
    seq += 1;
  };

  for (const template of TEMPLATES) {
    for (const text of template.texts) {
      if (text.includes("{n}")) {
        for (const niche of NICHES) {
          for (const opener of OPENERS.slice(0, 2)) {
            push(template, opener + text.replace(/\{n\}/g, niche));
          }
        }
      } else {
        for (const opener of OPENERS) {
          push(template, opener + text);
        }
      }
    }
  }

  return corpus;
}

export const CORPUS = generateCorpus();
