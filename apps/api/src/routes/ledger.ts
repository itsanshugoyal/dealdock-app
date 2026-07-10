import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deleteLedgerEntry, getDashboard, getLedger, updateLedgerEntry } from "@dealdock/db";
import { requireAuth } from "../auth";

const PatchBody = z.object({
  amountMinor: z.number().int().positive().optional(),
  dealType: z.enum(["brand", "coaching", "course", "other"]).optional(),
  note: z.string().max(500).optional(),
});

export async function ledgerRoutes(app: FastifyInstance) {
  app.get("/ledger", { preHandler: requireAuth }, async (req) => {
    const month = (req.query as Record<string, string>)["month"];
    return getLedger(req.auth!.orgId, /^\d{4}-\d{2}$/.test(month ?? "") ? month : undefined);
  });

  app.patch("/ledger/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const updated = await updateLedgerEntry(req.auth!.orgId, {
      entryId: id,
      seatId: req.auth!.seatId,
      ...parsed.data,
    });
    return { id: updated.id, amountMinor: updated.amountMinor };
  });

  app.delete("/ledger/:id", { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await deleteLedgerEntry(req.auth!.orgId, id, req.auth!.seatId);
    return { deleted: true };
  });

  /** CSV export — always available, incl. post-cancellation (PRD §5.7). */
  app.get("/ledger/export.csv", { preHandler: requireAuth }, async (req, reply) => {
    const ledger = await getLedger(req.auth!.orgId);
    const all = await Promise.all(
      ledger.months.map((m) => getLedger(req.auth!.orgId, m.month))
    );
    const rows = all.flatMap((l) => l.entries);
    const header = "date,handle,deal_type,amount_minor,currency,note";
    const lines = rows.map((e) =>
      [
        e.closedAt.toISOString().slice(0, 10),
        `@${e.handle}`,
        e.dealType,
        e.amountMinor,
        "", // currency joined below via org — kept simple in M1
        JSON.stringify(e.note ?? ""),
      ].join(",")
    );
    reply.header("content-type", "text/csv");
    reply.header("content-disposition", "attachment; filename=dealdock-ledger.csv");
    return [header, ...lines].join("\n");
  });

  app.get("/dashboard", { preHandler: requireAuth }, async (req) => {
    return getDashboard(req.auth!.orgId);
  });
}
