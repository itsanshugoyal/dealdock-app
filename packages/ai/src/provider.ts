export type ModelProvider = "groq" | "anthropic" | "openai";
/** Providers that speak the OpenAI chat-completions format (one client serves both). */
export type ChatVendor = "groq" | "openai";

const KEY: Record<ModelProvider, string> = { groq: "GROQ_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

function parseProvider(variable: string, value: string): ModelProvider {
  if (value !== "groq" && value !== "anthropic" && value !== "openai") throw new Error(`${variable} must be groq, anthropic or openai`);
  if (!process.env[KEY[value]]) throw new Error(`${variable}=${value} requires ${KEY[value]}`);
  return value;
}

/** An explicit provider is authoritative; it never switches vendor unless AI_FALLBACK_PROVIDER says so. */
export function configuredModelProvider(): ModelProvider | null {
  const selected = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (selected) return parseProvider("AI_PROVIDER", selected);
  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

/** Opt-in second provider that answers only when the primary call fails. Creator data then reaches it too. */
export function configuredFallbackProvider(): ModelProvider | null {
  const selected = process.env.AI_FALLBACK_PROVIDER?.trim().toLowerCase();
  return selected ? parseProvider("AI_FALLBACK_PROVIDER", selected) : null;
}

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";

export function chatModel(vendor: ChatVendor, kind: "classify" | "draft"): string {
  const prefix = vendor === "groq" ? "GROQ" : "OPENAI";
  return process.env[`${prefix}_${kind === "classify" ? "CLASSIFY" : "DRAFT"}_MODEL`]?.trim() || (vendor === "groq" ? DEFAULT_GROQ_MODEL : DEFAULT_OPENAI_MODEL);
}

export function groqModel(kind: "classify" | "draft"): string {
  return chatModel("groq", kind);
}
