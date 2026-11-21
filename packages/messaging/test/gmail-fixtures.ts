import type { GmailMessage, GmailPart } from "../src/gmail/mime";

/** Gmail API body data: base64url of the part's bytes, after transfer decoding. */
export const b64 = (text: string, encoding: BufferEncoding = "utf8") => Buffer.from(text, encoding).toString("base64url");

const headers = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, value }));

export const textPart = (partId: string, mimeType: "text/plain" | "text/html", body: string, charset = "UTF-8", encoding: BufferEncoding = "utf8"): GmailPart => ({
  partId,
  mimeType,
  filename: "",
  headers: headers({ "Content-Type": `${mimeType}; charset="${charset}"`, "Content-Transfer-Encoding": "quoted-printable" }),
  body: { size: body.length, data: b64(body, encoding) },
});

export function message(
  id: string,
  opts: { threadId?: string; from: string; to?: string; subject?: string; internalDate: number; labels?: string[]; payload: GmailPart; extraHeaders?: Record<string, string> }
): GmailMessage {
  return {
    id,
    threadId: opts.threadId ?? "18c1f0a2b3c4d5e6",
    labelIds: opts.labels ?? ["INBOX", "CATEGORY_PERSONAL", "UNREAD"],
    internalDate: String(opts.internalDate),
    payload: {
      ...opts.payload,
      partId: "",
      headers: [
        ...headers({
          From: opts.from,
          To: opts.to ?? "Aanya Kapoor <aanya.creates@gmail.com>",
          Subject: opts.subject ?? "Paid collab: GlowCo serum launch",
          Date: new Date(opts.internalDate).toUTCString(),
          "Message-ID": `<${id}@mail.gmail.com>`,
          ...opts.extraHeaders,
        }),
        ...(opts.payload.headers ?? []),
      ],
    },
  };
}

const NOV_3 = Date.UTC(2026, 10, 3, 9, 30);

/** A brand pitch: multipart/alternative with an RFC 3676 signature. */
export const BRAND_PITCH = message("18c1f0a2b3c4d5e6", {
  from: "Priya Sharma <Priya@GlowCo.in>",
  internalDate: NOV_3,
  payload: {
    mimeType: "multipart/alternative",
    parts: [
      textPart(
        "0",
        "text/plain",
        "Hi Aanya,\r\n\r\nWe'd love to collaborate on a paid reel for our new serum launch. Budget is ₹45,000 for 1 reel + 2 stories.\r\n\r\nCould you share your rate card?\r\n\r\nBest,\r\nPriya\r\n-- \r\nPriya Sharma | Partnerships, GlowCo\r\n+91 98765 43210\r\n"
      ),
      textPart(
        "1",
        "text/html",
        '<div dir="ltr">Hi Aanya,<br><br>We\'d love to collaborate&hellip;</div>'
      ),
    ],
  },
});

/** The creator's reply, sent from Gmail itself. */
export const CREATOR_REPLY = message("18c1f9e8d7c6b5a4", {
  from: "Aanya Kapoor <aanya.creates@gmail.com>",
  to: "Priya Sharma <priya@glowco.in>",
  subject: "Re: Paid collab: GlowCo serum launch",
  internalDate: NOV_3 + 2 * 3600_000,
  labels: ["SENT"],
  payload: textPart("", "text/plain", "Hi Priya! My rate is ₹60k for a reel. Media kit attached.\r\n\r\nOn Mon, Nov 3, 2026 at 3:00 PM Priya Sharma <\r\npriya@glowco.in> wrote:\r\n> Hi Aanya,\r\n> We'd love to collaborate\r\n"),
  extraHeaders: { "In-Reply-To": "<18c1f0a2b3c4d5e6@mail.gmail.com>", References: "<18c1f0a2b3c4d5e6@mail.gmail.com>" },
});

/** HTML-only reply with Gmail's quote container, a PDF brief and an inline signature logo. */
export const BRAND_REPLY_WITH_BRIEF = message("18c2a1b2c3d4e5f6", {
  from: '"Priya Sharma" <priya@glowco.in>',
  subject: "Re: Paid collab: GlowCo serum launch",
  internalDate: NOV_3 + 26 * 3600_000,
  payload: {
    mimeType: "multipart/mixed",
    parts: [
      {
        partId: "0",
        mimeType: "multipart/related",
        parts: [
          textPart(
            "0.0",
            "text/html",
            '<div dir="ltr">Works for us &amp; the brief is attached.<br><br>Thanks,<br>Priya</div><br>' +
              '<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Mon, Nov 3, 2026 at 5:00 PM Aanya &lt;aanya.creates@gmail.com&gt; wrote:<br></div>' +
              '<blockquote class="gmail_quote">My rate is ₹60k for a reel.</blockquote></div>'
          ),
          {
            partId: "0.1",
            mimeType: "image/png",
            filename: "image001.png",
            headers: [{ name: "Content-ID", value: "<ii_logo01>" }, { name: "Content-Disposition", value: "inline; filename=image001.png" }],
            body: { size: 4120, attachmentId: "ANGjdJ_logo" },
          },
        ],
      },
      {
        partId: "1",
        mimeType: "application/pdf",
        filename: "GlowCo brief.pdf",
        headers: [{ name: "Content-Disposition", value: 'attachment; filename="GlowCo brief.pdf"' }],
        body: { size: 48213, attachmentId: "ANGjdJ_brief" },
      },
    ],
  },
  extraHeaders: { References: "<18c1f0a2b3c4d5e6@mail.gmail.com> <18c1f9e8d7c6b5a4@mail.gmail.com>" },
});

/** A Hinglish DM-style email in a non-UTF-8 charset (Latin-1 "Café"). */
export const HINGLISH_PITCH = message("18c3b4c5d6e7f8a9", {
  threadId: "18c3b4c5d6e7f8a9",
  from: "Rohan Mehta <rohan@chaicafe.in>",
  subject: "Collab? ☕",
  internalDate: NOV_3 + 30 * 3600_000,
  payload: textPart("", "text/plain", "Hi didi, aapka reel bahut accha tha! Hum Café launch ke liye ek collab karna chahte hain, budget 25k hai. Kya aap interested ho?", "ISO-8859-1", "latin1"),
});

/** Promotions: never a conversation. */
export const NEWSLETTER = message("18c4c5d6e7f8a9b0", {
  threadId: "18c4c5d6e7f8a9b0",
  from: "Myntra <offers@myntra.com>",
  subject: "50% off!",
  internalDate: NOV_3,
  labels: ["INBOX", "CATEGORY_PROMOTIONS"],
  payload: textPart("", "text/html", "<p>Sale</p>"),
});
