import { describe, expect, it } from "vitest";
import { InboundMediaError, downloadInboundAudio, isAllowedMediaUrl, sniffAudioMimeType, toneWav } from "../src/index";

const MP4_VOICE_NOTE = new Uint8Array([0, 0, 0, 0x20, ...Buffer.from("ftypisom"), 0, 0, 2, 0, ...Buffer.from("isomiso2mp41")]);

function cdn(routes: Record<string, { status?: number; body?: Uint8Array; headers?: Record<string, string> }>) {
  const requested: string[] = [];
  const impl = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    requested.push(String(url));
    expect(init.redirect).toBe("manual");
    const route = routes[String(url)];
    if (!route) throw new TypeError("fetch failed");
    return new Response(route.body ?? null, { status: route.status ?? 200, headers: route.headers });
  }) as typeof fetch;
  return { impl, requested };
}

const LOOKASIDE = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=abc";
const SCONTENT = "https://scontent.xx.fbcdn.net/v/t42/voice.mp4?oh=1";

describe("isAllowedMediaUrl", () => {
  it("allows only https Meta CDN hosts", () => {
    expect(isAllowedMediaUrl(LOOKASIDE)).toBe(true);
    expect(isAllowedMediaUrl(SCONTENT)).toBe(true);
    expect(isAllowedMediaUrl("https://instagram.fbom3-1.fna.cdninstagram.com/a.mp4")).toBe(true);
    expect(isAllowedMediaUrl("http://lookaside.fbsbx.com/x")).toBe(false);
    expect(isAllowedMediaUrl("https://fbcdn.net.attacker.example/x")).toBe(false);
    expect(isAllowedMediaUrl("https://user:pw@lookaside.fbsbx.com/x")).toBe(false);
    expect(isAllowedMediaUrl("https://lookaside.fbsbx.com:8443/x")).toBe(false);
    expect(isAllowedMediaUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedMediaUrl("not a url")).toBe(false);
  });
});

describe("downloadInboundAudio", () => {
  it("follows an allowlisted redirect and sniffs mp4 voice notes labelled as video", async () => {
    const { impl, requested } = cdn({
      [LOOKASIDE]: { status: 302, headers: { location: SCONTENT } },
      [SCONTENT]: { body: MP4_VOICE_NOTE, headers: { "content-type": "video/mp4" } },
    });
    const audio = await downloadInboundAudio(LOOKASIDE, { fetchImpl: impl });
    expect(audio.mimeType).toBe("audio/mp4");
    expect(audio.bytes).toEqual(MP4_VOICE_NOTE);
    expect(requested).toEqual([LOOKASIDE, SCONTENT]);
  });

  it("never follows a redirect off the allowlist", async () => {
    const { impl, requested } = cdn({ [LOOKASIDE]: { status: 302, headers: { location: "http://10.0.0.5/internal" } } });
    await expect(downloadInboundAudio(LOOKASIDE, { fetchImpl: impl })).rejects.toMatchObject({ reason: "rejected", code: "redirect_host_not_allowed" });
    expect(requested).toEqual([LOOKASIDE]);
  });

  it("refuses a non-allowlisted URL without making a request", async () => {
    const { impl, requested } = cdn({});
    await expect(downloadInboundAudio("https://example.com/a.wav", { fetchImpl: impl })).rejects.toMatchObject({ reason: "rejected" });
    expect(requested).toEqual([]);
  });

  it("marks expired links unavailable and other failures failed", async () => {
    await expect(downloadInboundAudio(SCONTENT, { fetchImpl: cdn({ [SCONTENT]: { status: 404 } }).impl })).rejects.toMatchObject({ reason: "unavailable" });
    await expect(downloadInboundAudio(SCONTENT, { fetchImpl: cdn({ [SCONTENT]: { status: 500 } }).impl })).rejects.toMatchObject({ reason: "failed" });
    await expect(downloadInboundAudio(SCONTENT, { fetchImpl: cdn({}).impl })).rejects.toMatchObject({ reason: "failed", code: "network_error" });
  });

  it("enforces the size cap from the header and while streaming", async () => {
    const big = new Uint8Array(64);
    const declared = cdn({ [SCONTENT]: { body: big, headers: { "content-length": "64" } } });
    await expect(downloadInboundAudio(SCONTENT, { fetchImpl: declared.impl, maxBytes: 32 })).rejects.toMatchObject({ code: "too_large" });
    const streamed = cdn({ [SCONTENT]: { body: big } });
    const error = await downloadInboundAudio(SCONTENT, { fetchImpl: streamed.impl, maxBytes: 32 }).catch((e) => e);
    expect(error).toBeInstanceOf(InboundMediaError);
    expect(error.code).toBe("too_large");
  });

  it("rejects payloads that are not audio", async () => {
    const html = new TextEncoder().encode("<html><body>login required</body></html>");
    await expect(downloadInboundAudio(SCONTENT, { fetchImpl: cdn({ [SCONTENT]: { body: html } }).impl })).rejects.toMatchObject({ code: "not_audio" });
  });

  it("serves the mock fixture scheme only when allowed", async () => {
    await expect(downloadInboundAudio("mock-media://fixture/voice-note-0")).rejects.toMatchObject({ code: "mock_scheme_refused" });
    const audio = await downloadInboundAudio("mock-media://fixture/voice-note-0", { allowMockScheme: true });
    expect(audio.mimeType).toBe("audio/wav");
  });
});

describe("sniffAudioMimeType", () => {
  it("recognises common voice-note containers", () => {
    expect(sniffAudioMimeType(toneWav(100))).toBe("audio/wav");
    expect(sniffAudioMimeType(MP4_VOICE_NOTE)).toBe("audio/mp4");
    expect(sniffAudioMimeType(new Uint8Array([...Buffer.from("OggS"), ...new Uint8Array(12)]))).toBe("audio/ogg");
    expect(sniffAudioMimeType(new Uint8Array([0xff, 0xf1, ...new Uint8Array(12)]))).toBe("audio/aac");
    expect(sniffAudioMimeType(new Uint8Array([0xff, 0xfb, ...new Uint8Array(12)]))).toBe("audio/mpeg");
    expect(sniffAudioMimeType(new Uint8Array(4))).toBeNull();
  });
});
