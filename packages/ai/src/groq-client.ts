/** Chat completions for Groq and OpenAI (same wire format), kept server-side. Never log response bodies or credentials. */
import type { ChatVendor } from "./provider";

type Schema = { [key: string]: unknown };

export const CHAT_VENDORS = {
  groq: { label: "Groq", url: "https://api.groq.com/openai/v1/chat/completions", keyEnv: "GROQ_API_KEY", timeoutMs: 45_000 },
  // High reasoning effort can take longer than Groq's open models.
  openai: { label: "OpenAI", url: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", timeoutMs: 120_000 },
} as const satisfies Record<ChatVendor, { label: string; url: string; keyEnv: string; timeoutMs: number }>;

const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
/** Reasoning tokens count toward max_completion_tokens, so OpenAI gets room for them on top of the answer. */
const OPENAI_REASONING_HEADROOM = 16_384;

export function openaiReasoningEffort(): (typeof REASONING_EFFORTS)[number] {
  const value = process.env.OPENAI_REASONING_EFFORT?.trim().toLowerCase() || "high";
  if (!(REASONING_EFFORTS as readonly string[]).includes(value)) throw new Error(`OPENAI_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(", ")}`);
  return value as (typeof REASONING_EFFORTS)[number];
}

/** A provider rate limit (HTTP 429). Kept under its original name: the eval scripts retry on it for any vendor. */
export class GroqRateLimitError extends Error {
  readonly retryAfterMs: number | null;
  constructor(retryAfter: string | null, label = "Groq") {
    super(`${label} request failed (HTTP 429)`);
    this.name = "GroqRateLimitError";
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    this.retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
  }
}

/** Convert the existing tool schema to Groq's strict JSON-schema subset. */
export function strictSchema(input: Schema): Schema {
  const out: Schema = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "properties" && value && typeof value === "object") {
      const properties = value as Record<string, Schema>;
      const required = new Set(Array.isArray(input.required) ? input.required as string[] : []);
      out.properties = Object.fromEntries(Object.entries(properties).map(([name, schema]) => {
        const converted = strictSchema(schema);
        return [name, required.has(name) ? converted : { anyOf: [converted, { type: "null" }] }];
      }));
      out.required = Object.keys(properties);
      out.additionalProperties = false;
    } else if (key === "items" && value && typeof value === "object") {
      out.items = strictSchema(value as Schema);
    } else if (!["required", "additionalProperties", "minItems", "maxItems"].includes(key)) {
      out[key] = value;
    }
  }
  return out;
}

export async function groqStructured(options: {
  model: string; name: string; schema: Schema; system: string; user: string; maxTokens: number; temperature: number;
  apiKey?: string; fetchImpl?: typeof fetch; vendor?: ChatVendor;
}): Promise<unknown> {
  const vendor = CHAT_VENDORS[options.vendor ?? "groq"];
  const key = options.apiKey ?? process.env[vendor.keyEnv];
  if (!key) throw new Error(`${vendor.label} requires ${vendor.keyEnv}`);
  // OpenAI reasoning models take a reasoning effort instead of a sampling temperature.
  const sampling = options.vendor === "openai"
    ? { max_completion_tokens: options.maxTokens + OPENAI_REASONING_HEADROOM, reasoning_effort: openaiReasoningEffort() }
    : { max_completion_tokens: options.maxTokens, temperature: options.temperature };
  const body = JSON.stringify({
      model: options.model,
      messages: [
        { role: "system", content: `${options.system}\nReturn the result as a JSON object matching the supplied schema. Do not call a tool.` },
        { role: "user", content: options.user },
      ],
      response_format: { type: "json_schema", json_schema: { name: options.name, strict: true, schema: strictSchema(options.schema) } },
      ...sampling,
  });
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await (options.fetchImpl ?? fetch)(vendor.url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(vendor.timeoutMs),
      body,
    });
    // Groq can occasionally return this transient generation error even with
    // strict constrained decoding. Retry the exact same strict schema at most
    // twice; never retry other 400s or log the provider's response body.
    if (response.status !== 400 || attempt === 2) break;
    let code: unknown;
    try {
      const error = await response.clone().json() as { error?: { code?: unknown } };
      code = error?.error?.code;
    } catch { /* A malformed error is not safe to retry as a generation failure. */ }
    if (code !== "json_validate_failed") break;
  }
  if (!response) throw new Error(`${vendor.label} request failed`);
  if (response.status === 429) throw new GroqRateLimitError(response.headers.get("retry-after"), vendor.label);
  if (!response.ok) throw new Error(`${vendor.label} request failed (HTTP ${response.status})`);
  const data = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: unknown; refusal?: unknown } }> };
  const choice = data.choices?.[0];
  if (!choice || choice.finish_reason !== "stop" || choice.message?.refusal || typeof choice.message?.content !== "string") {
    throw new Error(`${vendor.label} returned an incomplete or refused structured response`);
  }
  try { return JSON.parse(choice.message.content); }
  catch { throw new Error(`${vendor.label} returned invalid structured JSON`); }
}
