import type { FastifyInstance } from "fastify";
import { getAudioAssetForDelivery } from "@dealdock/db";
import { verifyMediaSignature } from "../media-sign";

export async function mediaRoutes(app: FastifyInstance) {
  /**
   * Public clip delivery for Meta's fetcher (voice-note sends) and in-app
   * <audio>. No auth header: the HMAC over id + expiry is the capability, and
   * every failure is a plain 404 (no existence oracle). Kept out of request
   * logs; Cross-Origin-Resource-Policy is opened so the web app's origin can
   * play the clip.
   */
  app.get(
    "/media/a/:id",
    { logLevel: "silent", helmet: { crossOriginResourcePolicy: { policy: "cross-origin" } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { exp, sig } = req.query as { exp?: unknown; sig?: unknown };
      const asset = verifyMediaSignature(id, exp, sig) ? await getAudioAssetForDelivery(id) : null;
      if (!asset) return reply.code(404).send({ error: "not_found" });
      return reply
        .header("content-type", asset.mimeType)
        .header("content-length", String(asset.bytes.byteLength))
        .header("cache-control", "private, max-age=300")
        .header("accept-ranges", "none")
        .send(Buffer.from(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength));
    }
  );
}
