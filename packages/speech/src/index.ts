/**
 * @dealdock/speech — voice cloning, text-to-speech and transcription behind
 * one SpeechProvider seam (F8/F9, docs/research/03-voice-cloning-and-audio.md).
 * Server-only: apps/web may not import it (scripts/boundary-rules.mjs). The
 * worker may use it (transcription, CDN download) — it holds no Meta capability.
 */
export * from "./provider";
export * from "./config";
export * from "./elevenlabs";
export * from "./self-hosted";
export * from "./mock";
export * from "./wav";
export * from "./language";
export * from "./inbound-media";
