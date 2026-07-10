import {
  asOrgId,
  backdateDeletionRequest,
  countOrgResidue,
  createOrganizationWithCreator,
  exportOrgArchive,
  hardDeleteOrg,
  listOrgsDueHardDelete,
  requestAccountDeletion,
  upsertInboundMessage,
} from "@dealdock/db";

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

  // 2. Export works before deletion (PRD §6.11).
  const archive = await exportOrgArchive(orgId);
  const exportedThreads = (archive as { threads?: unknown[] }).threads?.length ?? 0;
  console.log(`drill: archive exported — ${exportedThreads} threads`);
  if (exportedThreads !== 5) {
    console.error(`DRILL FAILED: expected 5 threads in export, got ${exportedThreads}`);
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
