import type { FastifyInstance } from "fastify";
import { getThreadDetail, isSpeakingVoiceReady, resolveDraftContext } from "@dealdock/db";
import { requireAuth } from "../auth";
import { toThreadDetail } from "../dto/thread";
import { isHumanAgentEnabled, isSpeechConfigured, speechProviderKind } from "../feature-flags";
import { isProfileStale, refreshParticipantProfileInBackground } from "../profile";

export async function threadDetailRoutes(app: FastifyInstance) {
  /** Conversation view: v1 fields plus sender, reply window, audio, draft context and close-out signal. */
  app.get("/threads/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { orgId } = req.auth!;

    const detail = await getThreadDetail(orgId, id);
    if (!detail) return reply.code(404).send({ error: "not_found" });
    // Sender context is best-effort (F5): a stale card refreshes after this
    // response and shows on the next read, so it never stalls the conversation.
    if (isProfileStale(detail.participant.fetchedAt)) refreshParticipantProfileInBackground(orgId, id, req.log);
    const [draftContext, voiceReady] = await Promise.all([
      detail.currentDraft ? resolveDraftContext(orgId, detail.currentDraft.generationContext) : null,
      isSpeechConfigured() ? isSpeakingVoiceReady(orgId, detail.igAccountId, speechProviderKind()) : false,
    ]);
    return toThreadDetail(detail, {
      now: new Date(),
      humanAgentEnabled: isHumanAgentEnabled(),
      canSendVoice: voiceReady,
      draftContext,
    });
  });
}
