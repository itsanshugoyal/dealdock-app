import { SpeechProviderError, type SpeechErrorKind } from "./provider";

/** Bounded vendor call: a hung socket becomes a typed transient failure. */
export async function vendorFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new SpeechProviderError("transient", timedOut ? "timeout" : "network_error");
  }
  if (!res.ok) throw await vendorError(res);
  return res;
}

/** Map an HTTP failure to a typed error, reading only a snake_case vendor code. */
export async function vendorError(res: Response): Promise<SpeechProviderError> {
  const code = vendorCode(await res.json().catch(() => null)) ?? `http_${res.status}`;
  return new SpeechProviderError(errorKind(res.status, code), code, res.status);
}

export function errorKind(status: number, code: string): SpeechErrorKind {
  // ElevenLabs reports an exhausted character quota as 401 + detail.status "quota_exceeded".
  if (status === 402 || /quota|limit_reached|payment|credits/.test(code)) return "quota";
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  return "validation";
}

/** ElevenLabs: {detail:{status}}; FastAPI-style servers: {error:{code}} or {code}. */
function vendorCode(body: unknown): string | null {
  const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : null);
  const root = record(body);
  const candidates = [record(root?.detail)?.status, record(root?.detail)?.code, record(root?.error)?.code, root?.code];
  const code = candidates.find((value): value is string => typeof value === "string" && /^[a-z0-9_]{1,64}$/i.test(value));
  return code?.toLowerCase() ?? null;
}

/** Vendor response bodies are untrusted; read JSON or fail as a transient vendor fault. */
export async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new SpeechProviderError("transient", "unexpected_response", res.status);
  }
}

export function requireHttpBase(value: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("speech base URL is invalid");
  }
  const schemeOk = url.protocol === "https:" || (allowHttp && url.protocol === "http:");
  if (!schemeOk || url.username || url.password || url.search || url.hash) {
    throw new Error("speech base URL must be a plain http(s) origin without credentials");
  }
  return url.toString().replace(/\/+$/, "");
}

const EXTENSIONS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "video/mp4": "mp4",
};

/** Vendors infer the codec from the filename extension as well as the MIME type. */
export function audioFilename(stem: string, mimeType: string): string {
  return `${stem}.${EXTENSIONS[mimeType.split(";")[0]!.trim().toLowerCase()] ?? "bin"}`;
}
