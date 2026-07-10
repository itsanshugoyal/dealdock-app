import type { FastifyRequest } from "fastify";

/**
 * Route-level preParsing hook: captures the raw body for HMAC webhook
 * verification, then re-streams it to the JSON parser.
 */
export const captureRawBody = {
  preParsing: async (
    req: FastifyRequest,
    _reply: unknown,
    payload: AsyncIterable<Buffer>
  ) => {
    const chunks: Buffer[] = [];
    for await (const chunk of payload) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    (req as { rawBody?: string }).rawBody = raw.toString("utf8");
    const { Readable } = await import("node:stream");
    return Readable.from(raw);
  },
};

export function rawBodyOf(req: FastifyRequest): string {
  return (req as { rawBody?: string }).rawBody ?? "";
}
