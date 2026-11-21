import { afterEach, describe, expect, it } from "vitest";
import fontkit from "@pdf-lib/fontkit";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { computeInvoice, invoiceDeclaration, invoiceProof, invoiceTitle, type InvoiceDto, type InvoiceKind, type InvoiceParty, type InvoiceSupplier } from "@dealdock/core";
import { renderInvoicePdf } from "../src/invoice-pdf";
import { publicInvoiceUrl, signInvoicePath, signMediaPath, verifyInvoiceSignature } from "../src/media-sign";

const gstSupplier: InvoiceSupplier = {
  legalName: "Riya Sharma",
  addressLines: ["12 Carter Road", "Bandra West 400050"],
  city: "Mumbai",
  state: "27",
  country: "IN",
  email: "riya@example.com",
  phone: "+91 98765 43210",
  tax: { kind: "gst_in", number: "27AAPFU0939F1ZV", ratePercent: null, lutArn: null },
  pan: "AAPFU0939F",
  udyamNumber: "UDYAM-MH-01-0001234",
  sacCode: "998361",
  payment: { upiId: "riya@okhdfcbank", bankName: "HDFC Bank", accountName: "Riya Sharma", accountNumber: "50100123456789", ifsc: "HDFC0001234", swift: null, iban: null, paymentLink: "https://rzp.io/l/riya" },
  timezone: "Asia/Kolkata",
  locale: "en-IN",
};
const glow: InvoiceParty = { name: "Glow Co Pvt Ltd", addressLines: ["4th Floor, Lotus Park"], city: "Mumbai", state: "27", country: "IN", taxNumber: "27AAACR5055K1Z7" };

function invoiceOf(supplier: InvoiceSupplier, billTo: InvoiceParty, kind: InvoiceKind, baseMinor: number, currencyCode = "INR"): InvoiceDto {
  const computed = computeInvoice({ baseMinor, description: kind === "advance" ? "Advance (50%): 1 reel + 2 stories" : "1 reel + 2 stories", supplier, billTo });
  return {
    id: "inv_1",
    dealId: "deal_1",
    kind,
    number: "RIYA-2026-27-001",
    status: "issued",
    title: invoiceTitle(computed.supplyType, supplier.tax.kind),
    issuedAt: "2026-11-04T06:30:00.000Z",
    dueAt: "2026-11-11T06:30:00.000Z",
    currencyCode,
    supplier,
    billTo,
    ...computed,
    declaration: invoiceDeclaration(computed.supplyType, supplier.tax.lutArn),
    notes: "Usage: organic only, 3 months.",
    paidAt: null,
    receivedMinor: null,
    tdsMinor: null,
    voidedAt: null,
    createdAt: "2026-11-04T06:30:00.000Z",
    updatedAt: "2026-11-04T06:30:00.000Z",
  };
}

interface ShownRun {
  font: string;
  /** Glyphs in drawing order, read back through the font's ToUnicode map. */
  text: string;
  /** TJ positioning numbers (GPOS mark offsets and kerning). */
  adjustments: number[];
  /** The Span's ActualText (Devanagari runs), in reading order. */
  actualText: string | null;
  /** Where a Td put the run, for runs drawn with one. */
  at: [number, number] | null;
}

/** Every string the PDF draws (Tj or TJ), read back from its content streams through each font's ToUnicode map. */
async function pdfRuns(bytes: Uint8Array): Promise<ShownRun[]> {
  const doc = await PDFDocument.load(bytes);
  const shown: ShownRun[] = [];
  for (const page of doc.getPages()) {
    const maps = new Map<string, Map<string, string>>();
    const fonts = page.node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
    for (const [name, ref] of fonts.entries()) {
      const toUnicode = doc.context.lookup(doc.context.lookup(ref, PDFDict).get(PDFName.of("ToUnicode"))) as PDFRawStream;
      const cmap = Buffer.from(decodePDFRawStream(toUnicode).decode()).toString("latin1");
      const glyphs = new Map<string, string>();
      for (const [, cid, unicode] of cmap.matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/gi)) {
        glyphs.set(cid!.toUpperCase(), String.fromCodePoint(...unicode!.match(/.{4}/g)!.map((hex) => parseInt(hex, 16))));
      }
      maps.set(name.asString(), glyphs);
    }
    const contents = page.node.Contents()!;
    const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref) as PDFRawStream) : [contents as PDFRawStream];
    let font = "";
    let actualText: string | null = null;
    let at: [number, number] | null = null;
    for (const stream of streams) {
      const ops = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
      for (const [, actual, name, x, y, hex, array] of ops.matchAll(/\/ActualText <([0-9A-F]+)>|(\/\S+) [\d.]+ Tf|(-?[\d.]+) (-?[\d.]+) Td|<([0-9A-F]*)> Tj|\[([^\]]*)\] TJ/gi)) {
        // UTF-16BE after a byte-order mark.
        if (actual) actualText = Buffer.from(actual, "hex").swap16().toString("utf16le").slice(1);
        else if (name) font = name;
        else if (x) at = [Number(x), Number(y)];
        else {
          const codes = hex ?? [...array!.matchAll(/<([0-9A-F]*)>/gi)].map((match) => match[1]).join("");
          const glyphs = maps.get(font)!;
          shown.push({
            font,
            text: (codes.match(/.{4}/g) ?? []).map((cid) => glyphs.get(cid.toUpperCase()) ?? "?").join(""),
            adjustments: array === undefined ? [] : [...array.replace(/<[0-9A-F]*>/gi, " ").matchAll(/-?[\d.]+/g)].map((match) => Number(match[0])),
            actualText,
            at,
          });
          actualText = null;
          at = null;
        }
      }
    }
  }
  return shown;
}

/** Glyphs whose outline can't be read back from an embedded font program: a corrupt subset draws nothing in any viewer. */
async function unreadableGlyphs(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const broken: string[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || !object.has(PDFName.of("FontFile2"))) continue;
    const program = fontkit.create(Buffer.from(decodePDFRawStream(doc.context.lookup(object.get(PDFName.of("FontFile2"))) as PDFRawStream).decode()));
    for (let id = 0; id < program.numGlyphs; id++) {
      try {
        void program.getGlyph(id).path;
      } catch {
        broken.push(`${object.get(PDFName.of("FontName"))}#${id}`);
      }
    }
  }
  return broken;
}

/** Every string the PDF draws, read back from its content streams through each font's ToUnicode map. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  return (await pdfRuns(bytes)).map((run) => run.text).join("\n");
}

/** The fonts the PDF embeds, by name. */
async function fontNames(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return [...doc.context.enumerateIndirectObjects()].flatMap(([, object]) =>
    object instanceof PDFDict && object.has(PDFName.of("FontFile2")) ? [String(object.get(PDFName.of("FontName")))] : [],
  );
}

describe("invoice PDF", () => {
  it("renders a GST tax invoice with CGST/SGST, place of supply, words and UPI, and parses", async () => {
    const invoice = invoiceOf(gstSupplier, glow, "advance", 2_625_000);
    const bytes = await renderInvoicePdf(invoice);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe("Tax invoice RIYA-2026-27-001");
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");

    const text = await pdfText(bytes);
    for (const expected of [
      "Riya Sharma",
      "12 Carter Road",
      "Mumbai, Maharashtra, India",
      "GSTIN: 27AAPFU0939F1ZV",
      "PAN: AAPFU0939F",
      "Udyam: UDYAM-MH-01-0001234",
      "Tax invoice",
      "RIYA-2026-27-001",
      "4 Nov 2026",
      "11 Nov 2026",
      "Maharashtra (27)",
      "Reverse charge",
      "BILL TO",
      "Glow Co Pvt Ltd",
      "GSTIN: 27AAACR5055K1Z7",
      "Advance (50%): 1 reel + 2 stories",
      "998361",
      "Taxable value",
      "₹26,250.00",
      "CGST 9%",
      "SGST 9%",
      "₹2,362.50",
      "Total (INR)",
      "₹30,975.00",
      "Amount in words: Rupees Thirty Thousand Nine Hundred Seventy Five Only",
      "UPI: riya@okhdfcbank",
      "Scan to pay ₹30,975.00 with any UPI app",
      "IFSC: HDFC0001234",
      "Account number: 50100123456789",
      "Pay online: https://rzp.io/l/riya",
      "Usage: organic only, 3 months.",
      "Computer-generated invoice; no signature required.",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("IGST");
    expect(text).not.toContain("export");
    // Text extraction can pass while viewers draw nothing: every embedded glyph must read back.
    expect(await unreadableGlyphs(bytes)).toEqual([]);
    expect((await fontNames(bytes)).some((name) => name.includes("Devanagari"))).toBe(false);
  });

  it("draws Hindi in Noto Sans Devanagari: shaped, with its mark offsets, wrapped, and copied back in reading order", async () => {
    const supplier: InvoiceSupplier = { ...gstSupplier, legalName: "प्रिया शर्मा", addressLines: ["12 कार्टर रोड", "बांद्रा पश्चिम 400050"] };
    const buyer: InvoiceParty = { ...glow, name: "राहुल कुमार", addressLines: ["कृष्णा अग्रवाल एंड संस, दिल्ली"] };
    const invoice = { ...invoiceOf(supplier, buyer, "full", 5_000_000), notes: `धन्यवाद! Payment within 7 days. ${"कृपया समय पर भुगतान करें। ".repeat(12)}` };
    const bytes = await renderInvoicePdf(invoice);
    const runs = await pdfRuns(bytes);
    const hindi = runs.filter((run) => run.font.includes("NotoSansDevanagari"));
    const run = (word: string) => hindi.find((shown) => shown.actualText === word)!;

    // Each Devanagari word is its own run in the Devanagari font, the rest of the line in Noto Sans.
    expect(hindi.map((shown) => shown.actualText)).toEqual(expect.arrayContaining(["प्रिया", "शर्मा", "कार्टर", "राहुल", "कुमार", "कृष्णा", "दिल्ली", "धन्यवाद"]));
    expect(runs.find((shown) => shown.text.startsWith("! Payment within 7 days."))?.font).toContain("NotoSans-Regular");
    expect(run("प्रिया").font).toContain("NotoSansDevanagari-Bold");
    expect(run("दिल्ली").font).toContain("NotoSansDevanagari-Regular");
    // Shaped by fontkit's Indic shaper: the conjunct प्र is one glyph and the vowel sign ि is drawn before it, as written.
    expect(run("प्रिया").text).toBe("िप्रया");
    expect(run("शर्मा").text).toBe("शमार्");
    // GPOS: the ु of कुमार moves under its letter; प्रिया needs no adjustment.
    expect(run("कुमार").adjustments.length).toBeGreaterThan(0);
    expect(run("प्रिया").adjustments).toEqual([]);
    // The long note wraps onto several lines, all inside the page's margins.
    const note = hindi.filter((shown) => shown.actualText === "भुगतान");
    expect(new Set(note.map((shown) => shown.at![1])).size).toBeGreaterThan(1);
    expect(hindi.every((shown) => shown.at![0] >= 48 && shown.at![0] < 595.28 - 48)).toBe(true);

    expect(await unreadableGlyphs(bytes)).toEqual([]);
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(await renderInvoicePdf(invoice)))).toBe(0);
  });

  it("renders an export invoice under LUT: no tax, the declaration, place of supply outside India", async () => {
    const supplier = { ...gstSupplier, tax: { ...gstSupplier.tax, lutArn: "AD270326001234X" } };
    const brand: InvoiceParty = { name: "Glow Inc", addressLines: ["500 Market St"], city: "San Francisco", state: "CA", country: "US", taxNumber: null };
    const text = await pdfText(await renderInvoicePdf(invoiceOf(supplier, brand, "full", 5_250_000)));
    for (const expected of [
      "Export invoice",
      "Outside India",
      "San Francisco, CA, United States",
      "Subtotal",
      "₹52,500.00",
      "Supply meant for export under LUT without payment of integrated tax (LUT ARN AD270326001234X)",
      "Amount in words: Rupees Fifty Two Thousand Five Hundred Only",
      "IFSC: HDFC0001234",
    ]) {
      expect(text).toContain(expected);
    }
    // A foreign payer cannot pay by UPI.
    expect(text).not.toMatch(/CGST|SGST|IGST|Taxable value|UPI/);
  });

  it("renders a plain VAT invoice without UPI, and the same invoice to the same bytes", async () => {
    const uk: InvoiceSupplier = {
      ...gstSupplier,
      state: null,
      country: "GB",
      city: "London",
      tax: { kind: "vat", number: "GB123456789", ratePercent: 20, lutArn: null },
      pan: null,
      udyamNumber: null,
      sacCode: null,
      payment: { ...gstSupplier.payment, ifsc: null, iban: "GB29NWBK60161331926819" },
      locale: "en-GB",
      timezone: "Europe/London",
    };
    const invoice = invoiceOf(uk, { name: "Glow Ltd", addressLines: [], city: "Leeds", state: null, country: "GB", taxNumber: "GB987654321" }, "full", 100_000, "GBP");
    const bytes = await renderInvoicePdf(invoice);
    const text = await pdfText(bytes);
    for (const expected of ["Invoice", "VAT: GB123456789", "VAT 20%", "£200.00", "£1,200.00", "Tax no.: GB987654321", "IBAN: GB29NWBK60161331926819", "One Thousand Two Hundred Pounds Only"]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toMatch(/UPI|GSTIN|Place of supply|Reverse charge/);
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(await renderInvoicePdf(invoice)))).toBe(0);
  });

  it("marks a void invoice", async () => {
    const text = await pdfText(await renderInvoicePdf({ ...invoiceOf(gstSupplier, glow, "full", 100_000), status: "void", voidedAt: "2026-11-05T00:00:00.000Z" }));
    expect(text).toContain("VOID");
  });

  it("adds proof of delivery: each post's link, date and results, and the disclosure ticked", async () => {
    const invoice = invoiceOf(gstSupplier, glow, "full", 100_000);
    const link = `https://www.instagram.com/reel/Cx1AbC9/?utm=${"x".repeat(120)}`;
    const proof = invoiceProof({
      deliverables: [
        { id: "d1", label: "1 reel", dueAt: null, done: true, postUrl: link, postedAt: "2026-11-01T06:30:00.000Z", metrics: { views: 12_400, reach: 9_800, likes: null, comments: null, shares: null, saves: 210 }, metricsAt: "2026-11-08T06:30:00.000Z" },
        { id: "d2", label: "2 stories", dueAt: null, done: false },
      ],
      disclosure: ["paid_partnership", "brand_tagged"],
    });
    const bytes = await renderInvoicePdf(invoice, proof);
    const text = await pdfText(bytes);
    for (const expected of ["PROOF OF DELIVERY", "1 reel, posted 1 Nov 2026", "Results as of 8 Nov 2026: 12,400 views · 9,800 reach · 210 saves", "Disclosure: “Paid partnership” label turned on; Brand tagged"]) {
      expect(text).toContain(expected);
    }
    // A long link breaks across lines instead of running off the page; nothing about a deliverable not posted.
    expect(text.replace(/\s+/g, "")).toContain(link);
    expect(text).not.toContain("2 stories, posted");
    expect(await unreadableGlyphs(bytes)).toEqual([]);
    expect(await pdfText(await renderInvoicePdf(invoice))).not.toContain("PROOF OF DELIVERY");
  });
});

describe("signed invoice links", () => {
  afterEach(() => {
    delete process.env.PUBLIC_API_URL;
  });

  it("opens only its invoice, only until it expires, and never from an audio signature", () => {
    const now = Date.parse("2026-11-04T06:30:00Z");
    const url = new URL(signInvoicePath("inv_1", "RIYA-2026-27-001.pdf", 3600, now), "https://api.example.test");
    expect(url.pathname).toBe("/media/invoices/inv_1/RIYA-2026-27-001.pdf");
    const [exp, sig] = [url.searchParams.get("exp"), url.searchParams.get("sig")];
    expect(verifyInvoiceSignature("inv_1", exp, sig, now)).toBe(true);
    expect(verifyInvoiceSignature("inv_2", exp, sig, now)).toBe(false);
    expect(verifyInvoiceSignature("inv_1", exp, sig, now + 3_601_000)).toBe(false);
    const audio = new URL(signMediaPath("inv_1", 3600, now), "https://api.example.test");
    expect(verifyInvoiceSignature("inv_1", audio.searchParams.get("exp"), audio.searchParams.get("sig"), now)).toBe(false);
  });

  it("needs a public https origin for Meta to fetch", () => {
    expect(() => publicInvoiceUrl("inv_1", "X.pdf")).toThrow("public_media_url_unconfigured");
    process.env.PUBLIC_API_URL = "https://api.example.test/";
    expect(publicInvoiceUrl("inv_1", "X.pdf")).toMatch(/^https:\/\/api\.example\.test\/media\/invoices\/inv_1\/X\.pdf\?exp=\d+&sig=[0-9a-f]{64}$/);
  });
});
