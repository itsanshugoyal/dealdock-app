import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Serialise the writers of one conversation (classification summary, draft
 * generation, send receipts and echoes) on its Thread row.
 */
export async function lockThread(tx: Tx, threadId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Thread" WHERE "id" = ${threadId} FOR UPDATE`;
}

/**
 * Move a conversation's clocks forward to a message sent at `at`, never back:
 * backfills, webhook echoes and send receipts arrive out of order, and an
 * older delivery winning a race must not make the thread look older.
 */
export async function advanceThreadClocks(tx: Tx, threadId: string, direction: "inbound" | "outbound", at: Date) {
  await tx.thread.updateMany({ where: { id: threadId, lastMessageAt: { lt: at } }, data: { lastMessageAt: at } });
  if (direction === "inbound") {
    await tx.thread.updateMany({
      where: { id: threadId, OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: at } }] },
      data: { lastInboundAt: at },
    });
  } else {
    await tx.thread.updateMany({
      where: { id: threadId, OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: at } }] },
      data: { lastOutboundAt: at },
    });
  }
}
