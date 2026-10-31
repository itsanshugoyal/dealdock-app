import { prisma } from "./client";
import { createOrganizationWithCreator } from "./repos/orgs";

/**
 * Demo rate card + monthly goal (redesign F3/F7). Idempotent: offers are only
 * added to an org that has none, and an existing goal is never overwritten,
 * so re-running the seed on an older local database fills in the new data.
 */
async function seedOffersAndGoal(orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { currencyCode: true, monthlyGoalMinor: true },
  });
  if (org.monthlyGoalMinor === null) {
    await prisma.organization.update({
      where: { id: orgId },
      data: { monthlyGoalMinor: 50_000_000n }, // ₹5L confirmed revenue / month
    });
  }
  if ((await prisma.offer.count({ where: { orgId } })) > 0) return 0;
  const offers: Array<{
    name: string;
    dealType: "brand" | "coaching" | "course" | "other";
    priceMinMinor: bigint | null;
    priceMaxMinor: bigint | null;
    link: string | null;
    details: string;
    availability: string | null;
  }> = [
    {
      name: "Reel + 3 Stories (brand collab)",
      dealType: "brand",
      priceMinMinor: 15_000_000n, // ₹1.5L
      priceMaxMinor: 25_000_000n, // ₹2.5L
      link: null,
      details: "One 30–60s Reel plus 3 Stories with link sticker. 30-day organic usage rights, one revision round.",
      availability: "Booking campaigns from mid-November",
    },
    {
      name: "Dedicated Reel + 7-day link in bio",
      dealType: "brand",
      priceMinMinor: 30_000_000n, // ₹3L
      priceMaxMinor: 40_000_000n, // ₹4L
      link: null,
      details: "Dedicated product Reel, pinned for 7 days, link in bio for the week. Paid usage quoted separately.",
      availability: null,
    },
    {
      name: "1-on-1 coaching (monthly)",
      dealType: "coaching",
      priceMinMinor: 2_500_000n, // ₹25K
      priceMaxMinor: 8_000_000n, // ₹80K
      link: null,
      details: "Weekly video call, custom training + nutrition plan, WhatsApp check-ins. Price depends on call frequency.",
      availability: "3 seats left this month",
    },
    {
      name: "12-week transformation program",
      dealType: "coaching",
      priceMinMinor: 4_500_000n, // ₹45K
      priceMaxMinor: 4_500_000n,
      link: "https://example.com/12-week",
      details: "Group program: 12 weeks of workouts, meal plans and a weekly live Q&A. Next batch starts on the 5th.",
      availability: "Next batch starts on the 5th",
    },
    {
      name: "Content-creator course",
      dealType: "course",
      priceMinMinor: 800_000n, // ₹8K
      priceMaxMinor: 1_500_000n, // ₹15K
      link: "https://example.com/creator-course",
      details: "Self-paced, 6 modules on growing a fitness page and pitching brands. Lifetime access.",
      availability: null,
    },
  ];
  await prisma.offer.createMany({
    data: offers.map((offer, sortOrder) => ({
      ...offer,
      orgId,
      currencyCode: org.currencyCode,
      active: true,
      sortOrder,
    })),
  });
  return offers.length;
}

/**
 * Seed: one demo org (INR, mock provider) ready for the M0 ingestion demo.
 * Run: npm run db:seed -w @dealdock/db  (requires DATABASE_URL + migrations applied)
 */
async function main() {
  const existing = await prisma.organization.findFirst({
    where: { name: "Demo Creator Co" },
  });
  if (existing) {
    const added = await seedOffersAndGoal(existing.id);
    console.log(`Seed: demo org already exists (${existing.id})${added ? ` — added ${added} offers` : ""}`);
    return;
  }

  const { org, igAccount } = await createOrganizationWithCreator({
    name: "Demo Creator Co",
    tier: "solo",
    currencyCode: "INR",
    locale: "en-IN",
    timezone: "Asia/Kolkata",
    creator: {
      clerkUserId: "user_demo_local",
      email: "demo@dealdock.local",
      name: "Demo Creator",
    },
    igAccount: {
      provider: "mock",
      igUserId: "mock-ig-user-1",
      handle: "demo.creator",
      accountType: "creator",
    },
  });

  // Onboarding questionnaire answers (PRD §5.1.5) — feeds value estimation.
  await prisma.organization.update({
    where: { id: org.id },
    data: {
      businessContext: {
        businessSummary:
          "Fitness coach selling a 12-week transformation program, 1-on-1 coaching, and a content-creator course.",
        typicalBrandDealMinor: { min: 15_000_000, max: 40_000_000 }, // ₹1.5L–₹4L
        typicalCoachingMinor: { min: 2_500_000, max: 8_000_000 }, // ₹25K–₹80K
        typicalCourseMinor: { min: 800_000, max: 1_500_000 }, // ₹8K–₹15K
      },
    },
  });

  await prisma.voiceProfile.upsert({
    where: { igAccountId: igAccount.id },
    update: { enabled: true, consentedAt: new Date(), revokedAt: null },
    create: {
      orgId: org.id,
      igAccountId: igAccount.id,
      enabled: true,
      consentedAt: new Date(),
      styleCard: {
        greeting: "Hey hey!",
        tone: "warm, direct, high-energy",
        sentenceLength: "short",
        signoff: "– D",
        codeSwitching: "light Hinglish when the other side uses it",
      },
    },
  });

  const offers = await seedOffersAndGoal(org.id);

  console.log(`Seed: created org ${org.id} with IG account ${igAccount.id} + context + voice + ${offers} offers + goal`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
