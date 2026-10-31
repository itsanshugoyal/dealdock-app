import {
  asOrgId,
  backdateDeletionRequest,
  countOrgResidue,
  createOrganizationWithCreator,
  exportOrgArchive,
  hardDeleteOrg,
  listOrgsDueHardDelete,
  purgeExpiredAudioAssets,
  requestAccountDeletion,
  seedDrillCoverageRows,
  upsertInboundMessage,
} from "@dealdock/db";

/** Redesign tables that must be populated before, and empty after, the delete. */
const REDESIGN_TABLES = ["voiceRules", "draftFeedback", "offers", "speakingVoices", "audioAssets"] as const;

/**
 * M5 deletion drill (PLAN.md exit criterion): export → delete → PROVE GONE.
 * Creates a throwaway org, seeds data, exports the archive, requests deletion,
 * backdates past the 7-day grace, runs the retention pass, then asserts zero
 * residue across every org-scoped table. Exits non-zero on any residue.
 * Runs in CI's integration job.
 */
async function main() {
  // 1. Throwaway org with real data.
  const { org, seat, igAccount } = await createOrganizationWithCreator({
    name: `drill-org-${process.pid}`,
    creator: {
      clerkUserId: `drill-user-${process.pid}`,
      email: "drill@dealdock.local",
    },
    igAccount: {
      provider: "mock",
      igUserId: `drill-ig-${process.pid}`,
      handle: "drill.creator",
      accountType: "creator",
    },
  });
  const orgId = asOrgId(org.id);

  for (let i = 0; i < 5; i++) {
    await upsertInboundMessage(orgId, {
      igAccountId: igAccount.id,
      igThreadId: `drill-t${i}`,
      participantHandle: `drill.sender${i}`,
      participantIgId: `drill-p${i}`,
      igMessageId: `drill-m${i}-${process.pid}`,
      direction: "inbound",
      text: `drill message ${i} — sensitive content that must be provably deleted`,
      sentAt: new Date(),
    });
  }

  // One row in every redesign table (voice rules, feedback, offers, speaking
  // voice, audio clips) so the drill proves they are covered too.
  await seedDrillCoverageRows(org.id, igAccount.id, seat.id);

  // Expired audio clips are purged by the retention tick, not only on delete.
  const { purgedAudioAssets } = await purgeExpiredAudioAssets();
  const afterPurge = await countOrgResidue(org.id);
  if (purgedAudioAssets < 1 || afterPurge.audioAssets !== 1) {
    console.error(`DRILL FAILED: expired audio not purged (purged ${purgedAudioAssets}, left ${afterPurge.audioAssets})`);
    process.exit(1);
  }
  const unseeded = REDESIGN_TABLES.filter((table) => afterPurge[table] === 0);
  if (unseeded.length) {
    console.error(`DRILL FAILED: drill fixture missing rows in ${unseeded.join(", ")}`);
    process.exit(1);
  }

  // 2. Export works before deletion (PRD §6.11).
  const archive = await exportOrgArchive(orgId);
  const exportedThreads = (archive as { threads?: unknown[] }).threads?.length ?? 0;
  console.log(`drill: archive exported — ${exportedThreads} threads`);
  if (exportedThreads !== 5) {
    console.error(`DRILL FAILED: expected 5 threads in export, got ${exportedThreads}`);
    process.exit(1);
  }
  const exported = archive as Record<string, unknown[] | undefined>;
  for (const key of ["offers", "voiceRules", "speakingVoices", "audioAssets"]) {
    if (exported[key]?.length !== 1) {
      console.error(`DRILL FAILED: expected 1 ${key} row in export, got ${exported[key]?.length ?? 0}`);
      process.exit(1);
    }
  }
  if ((exported.audioAssets as Array<Record<string, unknown>>).some((clip) => "bytes" in clip)) {
    console.error("DRILL FAILED: audio bytes leaked into the JSON export");
    process.exit(1);
  }

  // 3. Request deletion, then simulate the 7-day grace elapsing.
  await requestAccountDeletion(orgId, seat.id);
  await backdateDeletionRequest(org.id, 8);

  // 4. The retention pass must pick it up and wipe it.
  const due = await listOrgsDueHardDelete();
  if (!due.some((d) => d.orgId === org.id)) {
    console.error("DRILL FAILED: org past grace not picked up by retention query");
    process.exit(1);
  }
  const wiped = await hardDeleteOrg(org.id);
  console.log(
    `drill: hard delete removed ${wiped.deletedMessages} messages, ${wiped.deletedLedgerEntries} ledger entries`
  );

  // 5. Prove gone — zero residue in EVERY org-scoped table.
  const residue = await countOrgResidue(org.id);
  const total = Object.values(residue).reduce((a, b) => a + b, 0);
  console.log(`drill: residue check ${JSON.stringify(residue)}`);
  if (total !== 0) {
    console.error("DRILL FAILED: residue remains after hard delete");
    process.exit(1);
  }

  console.log("DELETION DRILL PASSED ✓ — export worked, delete cascaded, residue zero");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
