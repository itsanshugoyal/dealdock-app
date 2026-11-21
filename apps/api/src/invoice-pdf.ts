import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit, { type Font as FontkitFont } from "@pdf-lib/fontkit";
import {
  beginText,
  endText,
  moveText,
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingColor,
  setFontAndSize,
  type PDFFont,
  type PDFPage,
  type RGB,
} from "pdf-lib";
import QRCode from "qrcode";
import { amountInWords, formatMoneyFixed, INDIAN_STATES, metricsLine, upiPayUrl, type CurrencyCode, type InvoiceDto, type InvoiceParty, type InvoiceProof } from "@dealdock/core";

/**
 * @pdf-lib/fontkit 1.1.1 was transpiled so the one generator in its Indic
 * shaper (syllable matching) needs regenerator's global runtime: without it
 * the first Devanagari string throws. This covers all that generator uses
 * (plain yields; no try/catch, no delegation); recheck if fontkit changes.
 */
interface GeneratorStep { prev: number; next: number; done: boolean; stop(): void }
(globalThis as { regeneratorRuntime?: unknown }).regeneratorRuntime ??= {
  mark: <T>(generator: T) => generator,
  wrap(step: (context: GeneratorStep) => unknown, _outer: unknown, self: unknown) {
    const context: GeneratorStep = { prev: 0, next: 0, done: false, stop() { this.done = true; } };
    return {
      next() {
        const value = context.done ? undefined : step.call(self, context);
        return context.done ? { value: undefined, done: true } : { value, done: false };
      },
      [Symbol.iterator]() { return this; },
    };
  },
};

const FONT_DIR = join(__dirname, "..", "assets", "fonts");
// The notofonts.github.io (fontc) builds: fontkit's subsetter writes a short loca, which needs
// even-length glyph records; a build that leaves them unpadded loses letters in every viewer.
const FONTS = {
  regular: "NotoSans-Regular.ttf",
  bold: "NotoSans-Bold.ttf",
  devanagari: "NotoSansDevanagari-Regular.ttf",
  devanagariBold: "NotoSansDevanagari-Bold.ttf",
} as const;
let fontFiles: Record<keyof typeof FONTS, Buffer> | undefined;
let shapers: { regular: FontkitFont; bold: FontkitFont } | undefined;
const FEATURES = { liga: false };
/** Devanagari (and its Vedic and Extended blocks) with the joiners that shape it; split() puts each run at an odd index. */
const DEVANAGARI_RUNS = /([\u{900}-\u{97F}\u{1CD0}-\u{1CFF}\u{A8E0}-\u{A8FF}\u{200C}\u{200D}]+)/u;

/** A weight: Noto Sans for everything but Devanagari, which Noto Sans Devanagari draws, shaped. */
interface Face {
  latin: PDFFont;
  devanagari: { font: PDFFont; shaper: FontkitFont } | null;
}

const PAGE: [number, number] = [595.28, 841.89]; // A4
const MARGIN = 48;
const RIGHT = PAGE[0] - MARGIN;
const INK = rgb(0.09, 0.09, 0.11);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.85, 0.85, 0.87);
/** UPI's usual per-payment limit: past it a pay QR would fail in the payer's app. */
const UPI_QR_MAX_MINOR = 1_00_000_00;

export function invoiceFileName(invoice: Pick<InvoiceDto, "number">): string {
  return `${invoice.number}.pdf`;
}

/**
 * An invoice as an A4 PDF, from the frozen invoice alone (no clock, no
 * random ids, no live profile), so the same invoice renders the same bytes.
 * Noto Sans carries ₹; Noto Sans Devanagari, embedded only when the invoice
 * has Hindi (or other Devanagari) text, its names and addresses. Server-only:
 * the web gets the bytes from the API. `proof` (core invoiceProof, from the
 * deal as it is now) adds a "Proof of delivery" section: each posted
 * deliverable's link, date and results, and the disclosure ticked.
 */
export async function renderInvoicePdf(invoice: InvoiceDto, proof: InvoiceProof | null = null): Promise<Uint8Array> {
  fontFiles ??= {
    regular: readFileSync(join(FONT_DIR, FONTS.regular)),
    bold: readFileSync(join(FONT_DIR, FONTS.bold)),
    devanagari: readFileSync(join(FONT_DIR, FONTS.devanagari)),
    devanagariBold: readFileSync(join(FONT_DIR, FONTS.devanagariBold)),
  };
  // Metadata is set by hand: pdf-lib's automatic dates would change every render.
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const embed = (bytes: Buffer) => doc.embedFont(bytes, { subset: true, features: FEATURES });
  const [latinRegular, latinBold] = await Promise.all([embed(fontFiles.regular), embed(fontFiles.bold)]);
  let regular: Face = { latin: latinRegular, devanagari: null };
  let bold: Face = { latin: latinBold, devanagari: null };
  if (DEVANAGARI_RUNS.test(JSON.stringify({ invoice, proof }))) {
    shapers ??= { regular: fontkit.create(fontFiles.devanagari), bold: fontkit.create(fontFiles.devanagariBold) };
    const [devanagari, devanagariBold] = await Promise.all([embed(fontFiles.devanagari), embed(fontFiles.devanagariBold)]);
    regular = { latin: latinRegular, devanagari: { font: devanagari, shaper: shapers.regular } };
    bold = { latin: latinBold, devanagari: { font: devanagariBold, shaper: shapers.bold } };
  }
  const s = invoice.supplier;
  doc.setTitle(`${invoice.title} ${invoice.number}`);
  doc.setAuthor(s.legalName);
  doc.setCreator("DealDock");
  doc.setProducer("DealDock");
  doc.setCreationDate(new Date(invoice.issuedAt));
  doc.setModificationDate(new Date(invoice.issuedAt));

  const money = (minor: number) => formatMoneyFixed(minor, { currency: invoice.currencyCode as CurrencyCode, locale: s.locale });
  const date = (iso: string) => new Intl.DateTimeFormat(s.locale, { day: "numeric", month: "short", year: "numeric", timeZone: s.timezone }).format(new Date(iso));
  const country = (code: string) => new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  const stateName = (code: string) => INDIAN_STATES[code] ?? code;
  const place = (party: Pick<InvoiceParty, "city" | "state" | "country">) =>
    [party.city, party.state && (party.country === "IN" ? stateName(party.state) : party.state), country(party.country)].filter(Boolean).join(", ");

  let page: PDFPage = doc.addPage(PAGE);
  let y = PAGE[1] - MARGIN;
  /** Starts a new page when the next `height` points would run into the footer. */
  const room = (height: number) => {
    if (y - height >= MARGIN + 28) return;
    page = doc.addPage(PAGE);
    y = PAGE[1] - MARGIN;
  };
  /** The text as runs in the font that draws each, with its width: shaped advances (GPOS included) for Devanagari. */
  const runsOf = (value: string, size: number, face: Face) =>
    value.split(DEVANAGARI_RUNS).flatMap((text, i) => {
      if (!text) return [];
      const shaped = i % 2 === 1 ? face.devanagari! : null;
      const width = shaped ? (shaped.shaper.layout(text, FEATURES).advanceWidth * size) / shaped.shaper.unitsPerEm : face.latin.widthOfTextAtSize(text, size);
      return [{ text, shaped, width }];
    });
  const widthOf = (value: string, size: number, face: Face) => runsOf(value, size, face).reduce((sum, run) => sum + run.width, 0);
  /**
   * One Devanagari run, glyph by glyph: pdf-lib's drawText keeps the shaped
   * glyphs (conjuncts, reordered matras) but drops the font's mark offsets and
   * kerning, which put the ु of कुमार under its letter. ActualText keeps copy
   * and search in logical order, not the reordered glyph order.
   */
  const drawShaped = (text: string, x: number, at: number, size: number, shaped: NonNullable<Face["devanagari"]>, color: RGB) => {
    const codes = shaped.font.encodeText(text).asString(); // 4 hex digits per glyph, in the order layout() returns them
    const { glyphs, positions } = shaped.shaper.layout(text, FEATURES);
    if (codes.length !== glyphs.length * 4) throw new Error("devanagari_layout_mismatch");
    const unit = 1000 / shaped.shaper.unitsPerEm;
    const shown = PDFArray.withContext(doc.context);
    glyphs.forEach((glyph, i) => {
      const { xOffset, xAdvance } = positions[i]!;
      // A TJ number moves what follows left by that many thousandths of the font size.
      if (xOffset) shown.push(PDFNumber.of(-xOffset * unit));
      shown.push(PDFHexString.of(codes.slice(i * 4, i * 4 + 4)));
      const back = xOffset + glyph.advanceWidth - xAdvance;
      if (back) shown.push(PDFNumber.of(back * unit));
    });
    // pdf-lib's operator-argument type leaves out dictionaries, which BDC takes; it writes any PDF object.
    const actualText = doc.context.obj({ ActualText: PDFHexString.fromText(text) }) as unknown as PDFArray;
    page.pushOperators(
      pushGraphicsState(),
      PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of("Span"), actualText]),
      beginText(),
      setFillingColor(color),
      setFontAndSize(page.node.newFontDictionary(shaped.font.name, shaped.font.ref), size),
      moveText(x, at),
      PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [shown]),
      endText(),
      PDFOperator.of(PDFOperatorNames.EndMarkedContent),
      popGraphicsState(),
    );
  };
  const draw = (value: string, x: number, at: number, o: { size?: number; font?: Face; color?: RGB; right?: boolean } = {}) => {
    const size = o.size ?? 9.5;
    const face = o.font ?? regular;
    const color = o.color ?? INK;
    const runs = runsOf(value, size, face);
    let cursor = o.right ? x - runs.reduce((sum, run) => sum + run.width, 0) : x;
    for (const run of runs) {
      if (run.shaped) drawShaped(run.text, cursor, at, size, run.shaped, color);
      else page.drawText(run.text, { x: cursor, y: at, size, font: face.latin, color });
      cursor += run.width;
    }
  };
  const wrap = (value: string, width: number, size = 9.5, font = regular): string[] => {
    const lines: string[] = [];
    let line = "";
    for (const word of value.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, size, font) <= width || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    return line ? [...lines, line] : lines;
  };
  /** Left-aligned lines from the cursor down. */
  const block = (lines: Array<{ text: string; font?: Face; size?: number; color?: RGB }>, x = MARGIN, width = RIGHT - MARGIN) => {
    for (const line of lines) {
      for (const part of wrap(line.text, width, line.size, line.font)) {
        room(14);
        draw(part, x, y, line);
        y -= (line.size ?? 9.5) + 4.5;
      }
    }
  };
  const label = (value: string) => block([{ text: value.toUpperCase(), font: bold, size: 7.5, color: MUTED }]);
  const rule = () => {
    room(10);
    page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: RIGHT, y: y + 4 }, thickness: 0.6, color: RULE });
    y -= 8;
  };

  // ── Header: the issuer on the left, the invoice on the right ──────────────
  const top = y;
  const ids = [
    s.tax.kind === "gst_in" && s.tax.number ? `GSTIN: ${s.tax.number}` : null,
    s.tax.kind === "vat" && s.tax.number ? `VAT: ${s.tax.number}` : null,
    s.pan ? `PAN: ${s.pan}` : null,
    s.udyamNumber ? `Udyam: ${s.udyamNumber}` : null,
  ].filter((line): line is string => line !== null);
  block(
    [
      { text: s.legalName, font: bold, size: 13 },
      ...s.addressLines.map((text) => ({ text })),
      { text: place(s) },
      ...([s.email, s.phone].some(Boolean) ? [{ text: [s.email, s.phone].filter(Boolean).join(" · ") }] : []),
      ...ids.map((text) => ({ text, color: MUTED })),
    ],
    MARGIN,
    250,
  );
  const leftBottom = y;

  y = top;
  draw(invoice.title, RIGHT, y - 6, { font: bold, size: 20, right: true });
  y -= 30;
  if (invoice.status === "void") {
    draw("VOID", RIGHT, y, { font: bold, size: 12, color: rgb(0.7, 0.12, 0.12), right: true });
    y -= 18;
  }
  const meta: Array<[string, string]> = [
    ["Invoice no.", invoice.number],
    ["Date", date(invoice.issuedAt)],
    ["Due", date(invoice.dueAt)],
    ...(invoice.placeOfSupply
      ? [["Place of supply", invoice.placeOfSupply === "96" ? "Outside India" : `${stateName(invoice.placeOfSupply)} (${invoice.placeOfSupply})`] as [string, string]]
      : []),
    ...(s.tax.kind === "gst_in" ? [["Reverse charge", "No"] as [string, string]] : []),
  ];
  for (const [name, value] of meta) {
    draw(name, RIGHT - 190, y, { color: MUTED });
    draw(value, RIGHT, y, { font: bold, right: true });
    y -= 14;
  }
  y = Math.min(y, leftBottom) - 14;
  rule();

  // ── Bill to ───────────────────────────────────────────────────────────────
  const to = invoice.billTo;
  label("Bill to");
  block([
    { text: to.name, font: bold, size: 11 },
    ...to.addressLines.map((text) => ({ text })),
    { text: place(to) },
    ...(to.taxNumber ? [{ text: `${to.country === "IN" ? "GSTIN" : "Tax no."}: ${to.taxNumber}`, color: MUTED }] : []),
  ]);
  y -= 10;

  // ── Lines ─────────────────────────────────────────────────────────────────
  const withSac = invoice.lines.some((line) => line.sacCode);
  room(30);
  draw("#", MARGIN, y, { font: bold, size: 8, color: MUTED });
  draw("Description", MARGIN + 22, y, { font: bold, size: 8, color: MUTED });
  if (withSac) draw("SAC", 400, y, { font: bold, size: 8, color: MUTED });
  draw("Amount", RIGHT, y, { font: bold, size: 8, color: MUTED, right: true });
  y -= 6;
  rule();
  invoice.lines.forEach((line, i) => {
    const description = wrap(line.description, 320);
    room(description.length * 14 + 4);
    draw(String(i + 1), MARGIN, y);
    if (withSac && line.sacCode) draw(line.sacCode, 400, y);
    draw(money(line.amountMinor), RIGHT, y, { right: true });
    for (const part of description) {
      draw(part, MARGIN + 22, y);
      y -= 14;
    }
  });
  rule();

  // ── Totals ────────────────────────────────────────────────────────────────
  const total = (name: string, minor: number, strong = false) => {
    room(16);
    draw(name, RIGHT - 190, y, { font: strong ? bold : regular, size: strong ? 11 : 9.5, color: strong ? INK : MUTED });
    draw(money(minor), RIGHT, y, { font: strong ? bold : regular, size: strong ? 11 : 9.5, right: true });
    y -= strong ? 18 : 14;
  };
  total(invoice.taxes.length ? "Taxable value" : "Subtotal", invoice.subtotalMinor);
  for (const tax of invoice.taxes) total(tax.label, tax.amountMinor);
  total(`Total (${invoice.currencyCode})`, invoice.totalMinor, true);
  block([{ text: `Amount in words: ${amountInWords(invoice.totalMinor, invoice.currencyCode as CurrencyCode)}`, color: MUTED }]);
  y -= 8;

  // ── Payment ───────────────────────────────────────────────────────────────
  const p = s.payment;
  const bank: Array<[string, string | null]> = [
    ["Account name", p.accountName],
    ["Account number", p.accountNumber],
    ["Bank", p.bankName],
    ["IFSC", p.ifsc],
    ["SWIFT", p.swift],
    ["IBAN", p.iban],
  ];
  // UPI pays rupees within India; a foreign payer uses the bank details.
  const upi = invoice.currencyCode === "INR" && invoice.billTo.country === "IN" ? p.upiId : null;
  if (upi || p.paymentLink || bank.some(([, value]) => value)) {
    rule();
    label("Payment");
    const qr = upi && invoice.totalMinor <= UPI_QR_MAX_MINOR
      ? QRCode.create(upiPayUrl({ upiId: upi, payeeName: s.legalName, amountMinor: invoice.totalMinor, invoiceNumber: invoice.number }), { errorCorrectionLevel: "M" }).modules
      : null;
    const qrSize = 84;
    if (qr) room(qrSize + 20);
    // A QR scans only with clear space (its quiet zone) around it: 8pt above, 12pt below, 16pt beside.
    const qrTop = y - 4;
    if (qr) {
      const cell = qrSize / qr.size;
      // One rectangle per run of dark modules in a row.
      for (let row = 0; row < qr.size; row++) {
        for (let col = 0; col < qr.size; col++) {
          if (!qr.get(row, col)) continue;
          let end = col;
          while (end + 1 < qr.size && qr.get(row, end + 1)) end++;
          page.drawRectangle({ x: MARGIN + col * cell, y: qrTop - (row + 1) * cell, width: (end - col + 1) * cell, height: cell, color: INK });
          col = end;
        }
      }
    }
    const indent = qr ? MARGIN + qrSize + 16 : MARGIN;
    const rows = [
      ...(upi ? [{ text: `UPI: ${upi}`, font: bold }, ...(qr ? [{ text: `Scan to pay ${money(invoice.totalMinor)} with any UPI app` }] : [])] : []),
      ...bank.filter(([, value]) => value).map(([name, value]) => ({ text: `${name}: ${value}` })),
      ...(p.paymentLink ? [{ text: `Pay online: ${p.paymentLink}` }] : []),
    ];
    block(rows, indent, RIGHT - indent);
    if (qr) y = Math.min(y, qrTop - qrSize - 12);
    y -= 6;
  }

  // ── Proof of delivery: the live posts, their results and the disclosure ──
  if (proof) {
    rule();
    label("Proof of delivery");
    /** A link has no spaces to wrap at: past the width it breaks between characters. */
    const pieces = (text: string, width: number) => {
      const out: string[] = [];
      let line = "";
      for (const char of text) {
        if (line && widthOf(line + char, 9.5, regular) > width) { out.push(line); line = ""; }
        line += char;
      }
      return line ? [...out, line] : out;
    };
    for (const post of proof.posts) {
      block([{ text: `${post.label}${post.postedAt ? `, posted ${date(post.postedAt)}` : ""}`, font: bold }]);
      for (const part of pieces(post.postUrl, RIGHT - MARGIN)) block([{ text: part, color: MUTED }]);
      if (post.metrics) block([{ text: `Results${post.metricsAt ? ` as of ${date(post.metricsAt)}` : ""}: ${metricsLine(post.metrics, s.locale)}` }]);
      y -= 4;
    }
    if (proof.disclosure.length) block([{ text: `Disclosure: ${proof.disclosure.join("; ")}` }]);
    y -= 6;
  }

  // ── Declaration, notes, footer ────────────────────────────────────────────
  if (invoice.declaration) {
    rule();
    block([{ text: invoice.declaration, font: bold }]);
  }
  if (invoice.notes) {
    rule();
    label("Notes");
    block([{ text: invoice.notes }]);
  }
  draw("Computer-generated invoice; no signature required.", MARGIN, MARGIN, { size: 8, color: MUTED });

  return doc.save();
}
