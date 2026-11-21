import { describe, expect, it } from "vitest";
import {
  MAX_SEND_ATTACHMENT_BYTES,
  composeReply,
  firstMailbox,
  htmlToText,
  parseGmailMessage,
  stripQuoted,
} from "../src/gmail/mime";
import { BRAND_PITCH, BRAND_REPLY_WITH_BRIEF, CREATOR_REPLY, HINGLISH_PITCH, message, textPart } from "./gmail-fixtures";

/** The RFC 2822 text inside a `raw` value, with CRLFs shown as \n. */
const decodeRaw = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");
const headerLines = (mime: string) => mime.split("\r\n\r\n")[0]!.split("\r\n");

describe("reading Gmail messages", () => {
  it("prefers the plain part of multipart/alternative and drops the signature", () => {
    expect(parseGmailMessage(BRAND_PITCH)).toEqual({
      text: "Hi Aanya,\n\nWe'd love to collaborate on a paid reel for our new serum launch. Budget is ₹45,000 for 1 reel + 2 stories.\n\nCould you share your rate card?\n\nBest,\nPriya",
      attachments: [],
    });
  });

  it("strips a wrapped Gmail attribution and its quoted lines", () => {
    expect(parseGmailMessage(CREATOR_REPLY).text).toBe("Hi Priya! My rate is ₹60k for a reel. Media kit attached.");
  });

  it("converts HTML-only mail, cuts the gmail_quote, and notes real attachments but not inline logos", () => {
    const parsed = parseGmailMessage(BRAND_REPLY_WITH_BRIEF);
    expect(parsed.text).toBe("Works for us & the brief is attached.\n\nThanks,\nPriya\n\n[Attachment: GlowCo brief.pdf]");
    expect(parsed.attachments).toEqual([
      { partId: "1", attachmentId: "ANGjdJ_brief", filename: "GlowCo brief.pdf", mimeType: "application/pdf", size: 48213 },
    ]);
  });

  it("keeps Hinglish text and decodes the part's declared charset", () => {
    expect(parseGmailMessage(HINGLISH_PITCH).text).toBe(
      "Hi didi, aapka reel bahut accha tha! Hum Café launch ke liye ek collab karna chahte hain, budget 25k hai. Kya aap interested ho?"
    );
    const utf8 = message("m-hi", {
      from: "Neha <neha@desi.co>",
      internalDate: 1,
      payload: textPart("", "text/plain", "Namaste! 🙏 Collab ke liye ready ho? धन्यवाद\n\nसोम, 3 नव॰ 2026 को 3:00 pm बजे Aanya <aanya.creates@gmail.com> ने लिखा:\n> पुराना संदेश"),
    });
    expect(parseGmailMessage(utf8).text).toBe("Namaste! 🙏 Collab ke liye ready ho? धन्यवाद");
  });

  it("notes a file-only message so it is never empty", () => {
    const fileOnly = message("m-file", {
      from: "Rohan <rohan@chaicafe.in>",
      internalDate: 1,
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          textPart("0", "text/plain", ""),
          { partId: "1", mimeType: "application/pdf", filename: "rate-card.pdf", body: { size: 900, attachmentId: "att-1" } },
        ],
      },
    });
    expect(parseGmailMessage(fileOnly).text).toBe("[Attachment: rate-card.pdf]");
  });
});

describe("quote and signature stripping", () => {
  it("cuts Outlook reply headers and separators", () => {
    expect(stripQuoted("Thanks, confirmed for the 12th.\r\n\r\n________________________________\r\nFrom: Aanya <a@x.com>\r\nSent: Monday\r\nOld")).toBe("Thanks, confirmed for the 12th.");
    expect(stripQuoted("Yes.\n\nFrom: Aanya <a@x.com>\nSent: Monday, 3 November 2026 18:00\nTo: Rohan\n\nOld")).toBe("Yes.");
    expect(stripQuoted("Ok\n-----Original Message-----\nOld")).toBe("Ok");
  });

  it("keeps the answers between inline quotes", () => {
    expect(stripQuoted("> Rate for a reel?\n₹60k\n> Timeline?\nTwo weeks")).toBe("₹60k\nTwo weeks");
  });

  it("drops mobile footers but keeps forwarded content", () => {
    expect(stripQuoted("Works for me\n\nSent from my iPhone")).toBe("Works for me");
    const forward = "FYI\n\n---------- Forwarded message ---------\nFrom: Brand <b@brand.com>\nDate: Mon, Nov 3, 2026\nSubject: Collab\n\nPaid reel, ₹40k";
    expect(stripQuoted(forward)).toBe(forward);
  });

  it("keeps a message that is all quote rather than emptying it", () => {
    expect(stripQuoted("> only a quote")).toBe("> only a quote");
  });

  it("turns HTML into readable text", () => {
    expect(htmlToText("<html><head><style>p{}</style></head><body><p>Line&nbsp;one</p><ul><li>A</li><li>B</li></ul>&#8377;5k &lt;ok&gt;</body></html>")).toBe(
      "Line one\n- A\n- B\n₹5k <ok>"
    );
  });

  it("reads the first mailbox of an address header", () => {
    expect(firstMailbox('"Sharma, Priya" <Priya@GlowCo.in>, bob@x.com')).toEqual({ address: "priya@glowco.in", name: "Sharma, Priya" });
    expect(firstMailbox("bob@x.com")).toEqual({ address: "bob@x.com", name: null });
    expect(firstMailbox("undisclosed-recipients:;")).toBeNull();
  });
});

describe("composing a threaded reply", () => {
  const base = {
    to: "priya@glowco.in",
    subject: "Paid collab: GlowCo serum launch",
    inReplyTo: "<18c2a1b2c3d4e5f6@mail.gmail.com>",
    references: "<18c1f0a2b3c4d5e6@mail.gmail.com> <18c1f9e8d7c6b5a4@mail.gmail.com>",
    text: "Sounds good! Invoice to follow.\nThanks 🙏",
  };

  it("sets the threading headers and a base64url raw with a UTF-8 body", () => {
    const raw = composeReply(base);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const mime = decodeRaw(raw);
    expect(headerLines(mime)).toEqual([
      "To: priya@glowco.in",
      "Subject: Re: Paid collab: GlowCo serum launch",
      "In-Reply-To: <18c2a1b2c3d4e5f6@mail.gmail.com>",
      "References: <18c1f0a2b3c4d5e6@mail.gmail.com> <18c1f9e8d7c6b5a4@mail.gmail.com> <18c2a1b2c3d4e5f6@mail.gmail.com>",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
    ]);
    const body = mime.split("\r\n\r\n")[1]!;
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Sounds good! Invoice to follow.\r\nThanks 🙏");
  });

  it("adds Re: once and encodes a non-ASCII subject", () => {
    expect(headerLines(decodeRaw(composeReply({ ...base, subject: "RE: Rates" })))[1]).toBe("Subject: RE: Rates");
    const subject = decodeRaw(composeReply({ ...base, subject: "Collab? ☕ आपके लिए एक लंबा प्रस्ताव है जो कई शब्दों में है" })).split("\r\nIn-Reply-To")[0]!;
    const words = [...subject.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1]!, "base64").toString("utf8"));
    expect(words.join("")).toBe("Re: Collab? ☕ आपके लिए एक लंबा प्रस्ताव है जो कई शब्दों में है");
    expect(subject.split("\r\n").every((line) => line.length <= 78)).toBe(true);
  });

  it("never lets a header value start a new header", () => {
    const mime = decodeRaw(
      composeReply({ ...base, subject: "Hi\r\nBcc: evil@attacker.com", inReplyTo: "<a@b>\r\nBcc: evil@attacker.com", references: "x\nCc: evil@attacker.com" })
    );
    expect(headerLines(mime).filter((line) => /^(Bcc|Cc):/i.test(line))).toEqual([]);
    expect(headerLines(mime)).toContain("In-Reply-To: <a@b>");
    expect(() => composeReply({ ...base, to: "priya@glowco.in\r\nBcc: evil@attacker.com" })).toThrow("one plain address");
    expect(() => composeReply({ ...base, to: "priya@glowco.in, evil@attacker.com" })).toThrow("one plain address");
  });

  it("builds multipart/mixed for attachments with safe filenames", () => {
    const pdf = Buffer.from("%PDF-1.7 invoice");
    const mime = decodeRaw(composeReply({ ...base, attachments: [{ filename: 'inv"oice\r\n₹.pdf', contentType: "application/pdf", bytes: pdf }] }));
    const boundary = /boundary="([^"]+)"/.exec(mime)?.[1];
    expect(boundary).toBeTruthy();
    const parts = mime.split(`--${boundary}`);
    expect(parts).toHaveLength(4); // headers, text, file, closing "--"
    expect(parts[2]).toContain("Content-Disposition: attachment; filename=\"inv_oice _.pdf\"; filename*=UTF-8''inv_oice%20%E2%82%B9.pdf");
    expect(Buffer.from(parts[2]!.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").equals(pdf)).toBe(true);
    expect(() => composeReply({ ...base, attachments: [{ filename: "big.pdf", contentType: "application/pdf", bytes: new Uint8Array(MAX_SEND_ATTACHMENT_BYTES + 1) }] })).toThrow("size limit");
  });
});
