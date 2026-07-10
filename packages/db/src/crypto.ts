import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Application-layer AES-256-GCM for IG access tokens (ARCHITECTURE.md §8).
 * INTERNAL to @dealdock/db — decrypted tokens never leave the repository
 * layer except inside ConnectedAccount objects handed to adapters.
 * Format: v1:<iv b64>:<authTag b64>:<ciphertext b64>
 */

function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is required to store IG tokens");
  const buf = Buffer.from(raw, raw.length === 64 ? "hex" : "base64");
  if (buf.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (hex or base64)");
  }
  return buf;
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptToken(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("unrecognized token ciphertext format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
