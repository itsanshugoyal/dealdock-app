import type { FastifyRequest } from "fastify";
import { Readable } from "node:stream";

const DEFAULT_MAX_RAW_BODY_BYTES = 512 * 1024;

function bodyTooLarge(): Error & { statusCode: number; code: string } {
  const error = new Error("webhook body exceeds configured limit") as Error & {
    statusCode: number;
    code: string;
  };
  error.statusCode = 413;
  error.code = "WEBHOOK_BODY_TOO_LARGE";
  return error;
}

/**
 * Route-level preParsing hook: captures the raw body for HMAC webhook
 * verification, then re-streams it to the JSON parser.
 */
export function captureRawBody(maxBytes = DEFAULT_MAX_RAW_BODY_BYTES) {
  return {
    preParsing: async (
      req: FastifyRequest,
      _reply: unknown,
      payload: AsyncIterable<Buffer | string>
    ) => {
    const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of payload) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > maxBytes) throw bodyTooLarge();
        chunks.push(buffer);
      }
    const raw = Buffer.concat(chunks);
    (req as { rawBody?: string }).rawBody = raw.toString("utf8");
    return Readable.from(raw);
    },
  };
}

export function rawBodyOf(req: FastifyRequest): string {
  return (req as { rawBody?: string }).rawBody ?? "";
}
