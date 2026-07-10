import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { editDistance } from "@dealdock/core";
import { createPipeline } from "@dealdock/ai";
import {
  claimDraftForSend,
  closeDeal,
  createDraft,
  dismissNudge,
  getConnectedAccount,
  getCreatorContext,
  getDraftForSend,
  getThreadDetail,
  markTokenExpired,
  recordSend,
  releaseDraftClaim,
  setThreadState,
} from "@dealdock/db";
import {
  InstagramGraphAdapter,
  MockInstagramAdapter,
  RateBudgetExceededError,
  TokenExpiredError,
  type MessagingProvider,
} from "@dealdock/messaging";
import { requireAuth } from "../auth";
import { requirePermission, requireWritable } from "../guards";

/** One adapter instance per provider — the graph adapter keeps rate buckets. */
const graphAdapter = new InstagramGraphAdapter();
const mockAdapter = new MockInstagramAdapter();

function providerFor(kind: string): MessagingProvider {
  if (kind === "mock") return mockAdapter;
  if (kind === "instagram_graph") return graphAdapter;
  throw new Error(`unknown provider ${kind}`);
}

/** Meta's standard messaging window (ARCHITECTURE.md §4.2). */
const SEND_WINDOW_MS = 24 * 60 * 60_000;

const SendBody = z.object({
  draftId: z.string(),
  finalText: z.string().min(1).max(4000),
});

const CloseBody = z.object({
  amountMinor: z.number().int().positive(),
  dealType: z.enum(["brand", "coaching", "course", "other"]),
  note: z.string().max(500).optional(),
});

const StateBody = z.object({
  state: z.enum(["open", "waiting", "closed"]),
});

export async function threadRoutes(app: FastifyInstance) {
  app.get("/threads/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const thread = await getThreadDetail(req.auth!.orgId, id);
    if (!thread) return reply.code(404).send({ error: "not_found" });
    return thread;
  });

  /** On-demand (re)generation — the <5s path (PRD §7.3). */
  app.post("/threads/:id/draft", { preHandler: [requireAuth, requireWritable] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = req.auth!;
    const thread = await getThreadDetail(auth.orgId, id);
    if (!thread) return reply.code(404).send({ error: "not_found" });

    const creator = await getCreatorContext(auth.orgId, thread.igAccountId);
    if (!creator.voiceEnabled) {
      return reply.code(409).send({ error: "voice_modeling_disabled" });
    }

    const pipeline = createPipeline();
    const result = await pipeline.draft({
      kind: "reply",
      classificationLabel: thread.topLabel ?? "brand_deal",
      threadHistory: thread.messages.map((m) => ({
        direction: m.direction as "inbound" | "outbound",
        text: m.text,
      })),
      creator,
    });

    const draft = await createDraft(auth.orgId, {
      threadId: id,
      kind: "reply",
      body: result.body,
      modelVersion: result.modelVersion,
      promptVersion: result.promptVersion,
    });

    return { id: draft.id, body: draft.body, version: draft.version };
  });

  /**
   * THE SEND GATE (ARCHITECTURE.md §6.2). Requires ALL of:
   *  1. an authenticated seat (requireAuth),
   *  2. a live draft whose final text the human echoes back,
   *  3. an active account within the platform send window.
   * Edit distance is computed server-side; the audit row is written in the
   * same transaction as the outbound message. Never auto-send — structurally.
   */
  app.post("/threads/:id/send", { preHandler: [requireAuth, requireWritable, requirePermission("send")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = req.auth!;

    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    }
    const { draftId, finalText } = parsed.data;

    const draft = await getDraftForSend(auth.orgId, draftId);
    if (!draft || draft.thread.id !== id) {
      return reply.code(404).send({ error: "draft_not_found_or_already_sent" });
    }
    if (draft.thread.igAccount.status !== "active") {
      return reply.code(409).send({ error: "account_not_active" });
    }

    // 24h-window pre-check for the real platform — reject before spending a
    // Graph call; the adapter maps Meta's own rejection as the backstop.
    if (draft.thread.igAccount.provider === "instagram_graph") {
      const lastInbound = draft.thread.lastInboundAt?.getTime() ?? 0;
      if (Date.now() - lastInbound > SEND_WINDOW_MS) {
        return reply.code(409).send({
          error: "send_window_closed",
          hint: "This thread's reply window has closed — reply from Instagram directly.",
        });
      }
    }

    const connected = await getConnectedAccount(auth.orgId, draft.thread.igAccount.id);
    if (!connected) return reply.code(409).send({ error: "account_not_active" });

    // Double-send lock (M5 audit): exactly one concurrent request wins the
    // claim; everyone else 409s BEFORE any platform call is made.
    const { claimed } = await claimDraftForSend(auth.orgId, draftId);
    if (!claimed) return reply.code(409).send({ error: "send_already_in_flight" });

    const provider = providerFor(draft.thread.igAccount.provider);
    let receipt;
    try {
      receipt = await provider.sendMessage(
        {
          accountId: connected.accountId,
          platformUserId: connected.platformUserId,
          handle: connected.handle,
          accessToken: connected.accessToken,
        },
        {
          platformThreadId: draft.thread.igThreadId,
          recipientPlatformId: draft.thread.participantIgId,
        },
        finalText
      );
    } catch (err) {
      // Platform send failed — release the lock so the draft is editable again.
      await releaseDraftClaim(auth.orgId, draftId);
      if ((err as Error).name === "SendWindowClosedError") {
        return reply.code(409).send({ error: "send_window_closed" });
      }
      if (err instanceof TokenExpiredError) {
        await markTokenExpired(draft.thread.igAccount.id);
        return reply.code(409).send({
          error: "token_expired",
          hint: "Instagram connection needs a refresh — reconnect from Settings.",
        });
      }
      if (err instanceof RateBudgetExceededError) {
        return reply
          .code(429)
          .header("Retry-After", String(Math.ceil(err.retryAfterMs / 1000)))
          .send({ error: "rate_budget_exceeded" });
      }
      throw err;
    }

    const distance = editDistance(draft.body, finalText);
    const result = await recordSend(auth.orgId, {
      draftId,
      seatId: auth.seatId,
      finalText,
      editDistance: distance,
      platformMessageId: receipt.platformMessageId,
      sentAt: receipt.sentAt,
    });

    return { sent: true, messageId: result.messageId, editDistance: distance };
  });

  /** Mark closed for [amount] → LedgerEntry (PRD §5.4). */
  app.post("/threads/:id/close", { preHandler: [requireAuth, requireWritable, requirePermission("close")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = CloseBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    }
    const entry = await closeDeal(req.auth!.orgId, {
      threadId: id,
      seatId: req.auth!.seatId,
      ...parsed.data,
    });
    return { entryId: entry.id, amountMinor: entry.amountMinor };
  });

  /** Keep waiting, silence this nudge; clock resets (PRD §6.5). */
  app.post("/threads/:id/nudge/dismiss", { preHandler: [requireAuth, requireWritable] }, async (req) => {
    const { id } = req.params as { id: string };
    await dismissNudge(req.auth!.orgId, id, req.auth!.seatId);
    return { dismissed: true };
  });

  /** open ↔ waiting ↔ closed; waiting starts the nudge clock (PRD §6.5). */
  app.patch("/threads/:id", { preHandler: [requireAuth, requireWritable] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = StateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const updated = await setThreadState(req.auth!.orgId, {
      threadId: id,
      seatId: req.auth!.seatId,
      state: parsed.data.state,
    });
    return { state: updated.state, waitingSince: updated.waitingSince };
  });
}
