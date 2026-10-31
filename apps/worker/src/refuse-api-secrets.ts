/**
 * Imported first by index.ts, before any consumer module loads. The worker
 * receives normalized, already-authorized jobs only: it must be unable to
 * decrypt Graph credentials or make any Graph call even if code is later
 * changed, so it fails closed when an API-only secret is injected here
 * (ARCHITECTURE.md §6.2).
 */
const forbiddenSecrets = [
  "TOKEN_ENCRYPTION_KEY",
  "META_APP_SECRET",
  "META_APP_ID",
  "META_WEBHOOK_VERIFY_TOKEN",
  "GRAPH_ACCESS_TOKEN",
].filter((name) => process.env[name]);

if (forbiddenSecrets.length) {
  console.error(`worker refused API-only credentials: ${forbiddenSecrets.join(", ")}`);
  process.exit(1);
}

export {};
