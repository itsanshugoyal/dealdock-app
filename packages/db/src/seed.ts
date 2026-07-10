import { prisma } from "./client";
import { createOrganizationWithCreator } from "./repos/orgs";

/**
 * Seed: one demo org (INR, mock provider) ready for the M0 ingestion demo.
 * Run: npm run db:seed -w @dealdock/db  (requires DATABASE_URL + migrations applied)
 */
async function main() {
  const existing = await prisma.organization.findFirst({
    where: { name: "Demo Creator Co" },
  });
  if (existing) {
    console.log(`Seed: demo org already exists (${existing.id})`);
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

  await prisma.voiceProfile.create({
    data: {
      orgId: org.id,
      igAccountId: igAccount.id,
      enabled: true,
      styleCard: {
        greeting: "Hey hey!",
        tone: "warm, direct, high-energy",
        sentenceLength: "short",
        signoff: "– D",
        codeSwitching: "light Hinglish when the other side uses it",
      },
    },
  });

  console.log(`Seed: created org ${org.id} with IG account ${igAccount.id} + context + voice`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
