import { randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";
import type { OutgoingAttachment } from "../provider";

/** The Gmail API message fields DealDock reads (format=full or format=metadata). */
export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  /** Epoch milliseconds, as a string: when Gmail received (or sent) the message. */
  internalDate?: string;
  payload?: GmailPart;
}

/** A file someone sent, as kept in Message.raw. Downloads look the part up again by partId. */
export interface EmailAttachment {
  partId: string;
  attachmentId: string | null;
  filename: string;
  mimeType: string;
  size: number;
}

/** An email can carry a whole contract; the classifier and the inbox need the new part, not all of it. */
const MAX_TEXT = 10_000;
/**
 * Files on one reply. Sends go through Gmail's JSON `raw` field, whose request
 * size is limited, and base64 is applied twice (MIME, then base64url).
 */
export const MAX_SEND_ATTACHMENT_BYTES = 3 * 1024 * 1024;

const PLAIN_ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

export function partHeader(part: GmailPart | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return part?.headers?.find((h) => h.name?.toLowerCase() === wanted)?.value;
}

export function header(message: GmailMessage, name: string): string | undefined {
  return partHeader(message.payload, name);
}

/** One bare address, nothing a header could smuggle a second recipient or a line break through. */
export function isPlainAddress(value: string): boolean {
  return value.length <= 254 && PLAIN_ADDRESS.test(value);
}

/** The first mailbox in an address header: `"Doe, Jane" <JANE@x.com>, bob@y.com` → jane@x.com, "Doe, Jane". */
export function firstMailbox(value: string | undefined): { address: string; name: string | null } | null {
  const match = value?.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>|([^\s<>,;:"()]+@[^\s<>,;:"()]+)/);
  if (!value || !match) return null;
  const name = match[1] ? value.slice(0, match.index).trim().replace(/^"(.*)"$/, "$1").trim() : "";
  return { address: (match[1] ?? match[2])!.toLowerCase(), name: name || null };
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** Where quoted history or a signature begins: the new part of a message ends at the first match. */
const CUT_MARKERS = [
  // Gmail / Apple Mail attribution; Gmail wraps a long one over up to three lines.
  /^[ \t]*On\b[^\n]{0,200}(?:\n[^\n]{0,200}){0,2}?\bwrote:[ \t]*$/m,
  /^[^\n]{0,300}ने लिखा:[ \t]*$/m,
  /^[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}/im,
  // Outlook's reply header. Gmail and Apple forwards use "Date:", so forwarded content is kept.
  /^[ \t]*\*?From:\*?[ \t][^\n]+\n[ \t]*\*?Sent:\*?[ \t]/m,
  /^[ \t]*_{20,}[ \t]*$/m,
  /^-- ?$/m,
  /^[ \t]*(?:Sent from (?:my|Mail|Outlook|Yahoo)\b|Get Outlook for (?:iOS|Android))[^\n]{0,40}$/im,
];

/** Quoted-history containers in HTML mail (Gmail, Apple Mail, Outlook, Yahoo) and Gmail's signature block. */
const HTML_CUT = /<div[^>]*\b(?:gmail_quote\w*|gmail_signature|yahoo_quoted)\b|<blockquote[^>]*\btype=["']?cite|<div[^>]*\bid=["']?(?:appendonsend|divRplyFwdMsg)\b/i;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…", bull: "•", rupee: "₹",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] !== "#") return ENTITIES[code] ?? entity;
    const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

function tidy(text: string): string {
  return text
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** HTML mail → readable text, dropping the quoted history and Gmail signature containers. */
export function htmlToText(html: string): string {
  const cut = html.search(HTML_CUT);
  return tidy(decodeEntities(
    (cut >= 0 ? html.slice(0, cut) : html)
      .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|tr|h[1-6]|table|blockquote)\s*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]*>/g, "")
  ));
}

/**
 * The new part of a reply: cut at the first attribution, Outlook header,
 * signature separator or mobile footer, then drop ">" quoted lines (inline
 * replies keep the answers between them). A message that is all quote is
 * kept whole rather than emptied.
 */
export function stripQuoted(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const cut = Math.min(...CUT_MARKERS.map((marker) => normalized.search(marker)).filter((at) => at >= 0), normalized.length);
  const kept = normalized.slice(0, cut).split("\n").filter((line) => !/^[ \t]*>/.test(line)).join("\n");
  return tidy(kept) || tidy(normalized);
}

function decodeText(part: GmailPart): string {
  const bytes = Buffer.from(part.body?.data ?? "", "base64url");
  const charset = /charset="?([^";\s]+)/i.exec(partHeader(part, "Content-Type") ?? "")?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

/**
 * The new text of a message (plain part preferred, else HTML) with each
 * attachment noted as "[Attachment: name]", plus the attachments' metadata.
 */
export function parseGmailMessage(message: GmailMessage): { text: string; attachments: EmailAttachment[] } {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: EmailAttachment[] = [];
  const walk = (part: GmailPart) => {
    const type = (part.mimeType ?? "").toLowerCase();
    if (part.filename) {
      // Embedded images (cid: signature logos, pasted pictures) are layout, not files someone sent.
      if (!(type.startsWith("image/") && partHeader(part, "Content-ID"))) {
        attachments.push({
          partId: part.partId ?? "",
          attachmentId: part.body?.attachmentId ?? null,
          filename: part.filename,
          mimeType: type || "application/octet-stream",
          size: part.body?.size ?? 0,
        });
      }
      return;
    }
    if (part.parts?.length) return part.parts.forEach(walk);
    if (!part.body?.data) return;
    if (type === "text/plain") plain.push(decodeText(part));
    else if (type === "text/html") html.push(decodeText(part));
  };
  if (message.payload) walk(message.payload);

  const plainText = plain.join("\n");
  const body = stripQuoted(plainText.trim() ? plainText : htmlToText(html.join("\n")));
  const text = [body, ...attachments.map((a) => `[Attachment: ${a.filename}]`)].filter(Boolean).join("\n\n");
  return { text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text, attachments };
}

/** The MIME part with this partId ("0", "1.2", …) anywhere in the message. */
export function findPart(part: GmailPart | undefined, partId: string): GmailPart | undefined {
  if (!part) return undefined;
  if (part.partId === partId) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, partId);
    if (found) return found;
  }
  return undefined;
}

// ── Composing ───────────────────────────────────────────────────────────────

/** Header values never carry a line break: that is how a header gets injected. */
const oneLine = (value: string) => value.replace(/[\r\n\0]+/g, " ").trim();

function base64Lines(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
}

/** RFC 2047 encoded words of ≤39 UTF-8 bytes (64 chars, so "Subject: " + one fits 78), folded onto continuation lines. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let word = "";
  for (const char of value) {
    if (Buffer.byteLength(word + char) > 39) {
      words.push(word);
      word = "";
    }
    word += char;
  }
  words.push(word);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

function attachmentPart(file: OutgoingAttachment): string[] {
  const name = oneLine(file.filename).replace(/[\\/"]/g, "_").slice(0, 200) || "attachment";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.contentType) ? file.contentType : "application/octet-stream";
  return [
    `Content-Type: ${type}; name="${ascii}"`,
    `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(file.bytes),
  ];
}

export interface ReplyInput {
  to: string;
  /** Subject of the message being answered; "Re: " is added once. */
  subject: string;
  /** Message-ID of the message being answered, and its References. */
  inReplyTo?: string;
  references?: string;
  text: string;
  attachments?: OutgoingAttachment[];
}

/**
 * An RFC 2822 reply, base64url-encoded for the Gmail API's `raw` field.
 * Plain text (UTF-8, base64), multipart/mixed when files are attached.
 * Gmail fills in From (the account's name and address), Date and Message-ID.
 */
export function composeReply(input: ReplyInput): string {
  const to = oneLine(input.to);
  if (!isPlainAddress(to)) throw new Error("Email recipient must be one plain address");
  const files = input.attachments ?? [];
  if (files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > MAX_SEND_ATTACHMENT_BYTES) {
    throw new Error("Email attachments exceed the per-reply size limit");
  }
  const subject = oneLine(input.subject).slice(0, 500);
  const ids = (value?: string) => oneLine(value ?? "").match(/<[^<>\s]+>/g) ?? [];
  const parent = ids(input.inReplyTo)[0];
  // RFC 5322: References is the parent's References plus the parent; the newest 20 are plenty to thread.
  const references = [...new Set([...ids(input.references), ...(parent ? [parent] : [])])].slice(-20);

  const headers = [
    `To: ${to}`,
    `Subject: ${encodeHeader(/^re:/i.test(subject) ? subject : `Re: ${subject}`.trim())}`,
    ...(parent ? [`In-Reply-To: ${parent}`] : []),
    ...(references.length ? [`References: ${references.join(" ")}`] : []),
    "MIME-Version: 1.0",
  ];
  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(input.text.replace(/\r?\n/g, "\r\n"), "utf8")),
  ];
  const boundary = `dealdock_${randomBytes(12).toString("hex")}`;
  const lines = files.length
    ? [
        ...headers,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        ...textPart,
        ...files.flatMap((file) => [`--${boundary}`, ...attachmentPart(file)]),
        `--${boundary}--`,
      ]
    : [...headers, ...textPart];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
