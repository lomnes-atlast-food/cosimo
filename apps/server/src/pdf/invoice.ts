import {
  PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  PDFString,
  type RGB,
  rgb,
  StandardFonts,
} from "pdf-lib";
import { fmtDate, fmtMoney, hexToRgb, toWinAnsi, truncateText, wrapText } from "./text.ts";

export interface InvoicePdfData {
  org: {
    name: string;
    legalName: string;
    address: Record<string, string> | null;
    email?: string | null;
    phone?: string | null;
    logo?: { bytes: Uint8Array; mime: "image/png" | "image/jpeg" } | null;
    color: string;
  };
  invoice: {
    number: string;
    issueDate: string;
    dueDate: string;
    terms: string | null;
    memo: string | null;
    status: "draft" | "sent" | "partial" | "paid" | "void";
    currency: string;
    subtotal: number;
    total: number;
    amountPaid: number;
    balanceDue: number;
  };
  customer: { name: string; email: string | null; address: Record<string, string> | null };
  lines: { description: string; quantityMilli: number; unitPrice: number; amount: number }[];
  paymentInstructions: string | null;
  /** The online pay link (or a payment link entered by hand); printed and clickable. */
  payUrl?: string | null;
}

const W = 612;
const H = 792;
const M = 48;
const CONTENT_W = W - 2 * M;
const BOTTOM = M + 20;
const TEXT = rgb(0.13, 0.15, 0.18);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.82, 0.84, 0.87);
const ZEBRA = rgb(0.96, 0.965, 0.975);
const WATERMARK = rgb(0.86, 0.87, 0.89);
const WHITE = rgb(1, 1, 1);

/** quantityMilli / 1000 without trailing zeros: 1000 -> "1", 2500 -> "2.5", 125 -> "0.125". */
export function formatQuantity(quantityMilli: number): string {
  const q = Math.trunc(quantityMilli);
  const abs = Math.abs(q);
  const int = String(Math.trunc(abs / 1000)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = String(abs % 1000)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return `${q < 0 ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

export function addressLines(addr: Record<string, string> | null | undefined): string[] {
  if (!addr) return [];
  return [addr.line1, addr.line2, addr.city_line]
    .map((l) => (typeof l === "string" ? l.trim() : ""))
    .filter((l) => l.length > 0);
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

function text(
  page: PDFPage,
  s: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  color: RGB = TEXT,
  align: "left" | "right" = "left",
) {
  const t = toWinAnsi(s).replace(/\n/g, " ");
  const dx = align === "right" ? font.widthOfTextAtSize(t, size) : 0;
  page.drawText(t, { x: x - dx, y, size, font, color });
}

/** Make a rectangle of the page open `url` when clicked (a PDF URI link annotation). */
export function linkAnnotation(
  doc: PDFDocument,
  page: PDFPage,
  rect: { x: number; y: number; width: number; height: number },
  url: string,
) {
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
  });
  page.node.addAnnot(doc.context.register(annot));
}

async function embedLogo(doc: PDFDocument, logo: InvoicePdfData["org"]["logo"]): Promise<PDFImage | null> {
  if (!logo?.bytes?.length) return null;
  const isPng = logo.bytes[0] === 0x89 && logo.bytes[1] === 0x50;
  const isJpg = logo.bytes[0] === 0xff && logo.bytes[1] === 0xd8;
  const order = isPng
    ? ["png", "jpg"]
    : isJpg
      ? ["jpg", "png"]
      : logo.mime === "image/png"
        ? ["png"]
        : ["jpg"];
  for (const kind of order) {
    try {
      return kind === "png" ? await doc.embedPng(logo.bytes) : await doc.embedJpg(logo.bytes);
    } catch {
      // try the next decoder, then fall back to the org name
    }
  }
  return null;
}

export async function renderInvoicePdf(d: InvoicePdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const now = new Date();
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  doc.setTitle(toWinAnsi(`Invoice ${d.invoice.number}`));
  doc.setProducer("Cosimo");
  doc.setCreator("Cosimo");
  doc.setAuthor(toWinAnsi(d.org.legalName || d.org.name));
  const f: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const accent = hexToRgb(d.org.color);
  const cur = d.invoice.currency;
  const money = (c: number) => fmtMoney(c, cur);
  const logo = await embedLogo(doc, d.org.logo);

  let page = doc.addPage([W, H]);
  let y = H - M;

  // Header, left: logo or org name
  let leftBottom: number;
  if (logo) {
    const scale = Math.min(140 / logo.width, 60 / logo.height);
    const lw = logo.width * scale;
    const lh = logo.height * scale;
    page.drawImage(logo, { x: M, y: y - lh, width: lw, height: lh });
    leftBottom = y - lh;
  } else {
    const nameLines = wrapText(d.org.name || d.org.legalName || "", f.bold, 20, 290).slice(0, 3);
    let ny = y - 18;
    for (const l of nameLines) {
      text(page, l, M, ny, f.bold, 20, accent);
      ny -= 24;
    }
    leftBottom = ny + 24 - 6;
  }

  // Header, right: title + meta
  const right = W - M;
  text(page, "INVOICE", right, y - 22, f.bold, 24, accent, "right");
  let ry = y - 44;
  const meta: [string, string][] = [
    ["Invoice #", d.invoice.number],
    ["Issue date", fmtDate(d.invoice.issueDate)],
    ["Due date", fmtDate(d.invoice.dueDate)],
  ];
  if (d.invoice.terms) meta.push(["Terms", d.invoice.terms]);
  for (const [label, value] of meta) {
    text(page, label, right - 150, ry, f.regular, 9, MUTED);
    text(page, truncateText(value, f.bold, 9, 140), right, ry, f.bold, 9, TEXT, "right");
    ry -= 14;
  }
  const stamp = { draft: "DRAFT", void: "VOID", paid: "PAID" }[d.invoice.status as string];
  if (stamp) {
    ry -= 26;
    text(page, stamp, right, ry, f.bold, 36, WATERMARK, "right");
    ry -= 8;
  }
  y = Math.min(leftBottom, ry) - 22;

  // From / Bill to
  const colW = CONTENT_W / 2 - 12;
  const block = (x: number, label: string, title: string, rest: string[]) => {
    let by = y;
    text(page, label, x, by, f.bold, 8, MUTED);
    by -= 15;
    for (const l of wrapText(title, f.bold, 10.5, colW)) {
      text(page, l, x, by, f.bold, 10.5);
      by -= 13.5;
    }
    for (const r of rest) {
      for (const l of wrapText(r, f.regular, 9.5, colW)) {
        text(page, l, x, by, f.regular, 9.5);
        by -= 12.5;
      }
    }
    return by;
  };
  const fromRest = [...addressLines(d.org.address), d.org.email ?? "", d.org.phone ?? ""].filter(Boolean);
  const toRest = [...addressLines(d.customer.address), d.customer.email ?? ""].filter(Boolean);
  const b1 = block(M, "FROM", d.org.legalName || d.org.name, fromRest);
  const b2 = block(M + CONTENT_W / 2 + 12, "BILL TO", d.customer.name, toRest);
  y = Math.min(b1, b2) - 16;

  // Line table
  const cols = [
    { label: "Description", w: CONTENT_W - 60 - 95 - 95, align: "left" as const },
    { label: "Qty", w: 60, align: "right" as const },
    { label: "Unit price", w: 95, align: "right" as const },
    { label: "Amount", w: 95, align: "right" as const },
  ];
  const pad = 7;
  const size = 9.5;
  const lh = 12.5;
  const headerH = 20;
  const drawHeader = () => {
    page.drawRectangle({ x: M, y: y - headerH, width: CONTENT_W, height: headerH, color: accent });
    let x = M;
    for (const c of cols) {
      const tx = c.align === "right" ? x + c.w - pad : x + pad;
      text(page, c.label, tx, y - 13.5, f.bold, 9, WHITE, c.align);
      x += c.w;
    }
    y -= headerH;
  };
  const newPage = () => {
    page = doc.addPage([W, H]);
    y = H - M;
    text(page, `Invoice ${d.invoice.number} (continued)`, M, y - 10, f.bold, 10, accent);
    y -= 24;
  };

  if (y - headerH - lh - 8 < BOTTOM) newPage();
  drawHeader();
  const descW = cols[0]!.w - 2 * pad;
  d.lines.forEach((line, i) => {
    let desc = wrapText(line.description || "", f.regular, size, descW);
    const cells = [formatQuantity(line.quantityMilli), money(line.unitPrice), money(line.amount)];
    let first = true;
    while (desc.length > 0 || first) {
      const room = Math.floor((y - BOTTOM - 8) / lh);
      if (room < 1) {
        newPage();
        drawHeader();
        continue;
      }
      const chunk = desc.slice(0, room);
      desc = desc.slice(chunk.length);
      const rowH = Math.max(chunk.length, 1) * lh + 8;
      if (i % 2 === 1)
        page.drawRectangle({ x: M, y: y - rowH, width: CONTENT_W, height: rowH, color: ZEBRA });
      let ty = y - 4 - size;
      for (const l of chunk) {
        text(page, l, M + pad, ty, f.regular, size);
        ty -= lh;
      }
      if (first) {
        let x = M + cols[0]!.w;
        cells.forEach((c, ci) => {
          const col = cols[ci + 1]!;
          text(
            page,
            truncateText(c, f.regular, size, col.w - pad),
            x + col.w - pad,
            y - 4 - size,
            f.regular,
            size,
            TEXT,
            "right",
          );
          x += col.w;
        });
      }
      first = false;
      y -= rowH;
    }
  });
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.75, color: RULE });

  // Totals
  const totals: { label: string; value: string; strong?: boolean }[] = [
    { label: "Subtotal", value: money(d.invoice.subtotal) },
    { label: "Total", value: money(d.invoice.total) },
  ];
  if (d.invoice.amountPaid > 0) totals.push({ label: "Paid", value: money(-d.invoice.amountPaid) });
  totals.push({ label: "Balance due", value: money(d.invoice.balanceDue), strong: true });
  const totalsH = totals.length * 16 + 22;
  if (y - totalsH < BOTTOM) newPage();
  y -= 18;
  const tx = W - M - 230;
  for (const t of totals) {
    if (t.strong) {
      y -= 4;
      page.drawLine({
        start: { x: tx, y: y + 13 },
        end: { x: W - M, y: y + 13 },
        thickness: 1,
        color: accent,
      });
      y -= 3;
      text(page, t.label, tx + pad, y, f.bold, 11, accent);
      text(page, t.value, W - M - pad, y, f.bold, 11, accent, "right");
    } else {
      text(page, t.label, tx + pad, y, f.regular, 9.5, MUTED);
      text(page, t.value, W - M - pad, y, f.regular, 9.5, TEXT, "right");
    }
    y -= 16;
  }
  y -= 12;

  // Memo & payment instructions
  const section = (label: string, body: string | null) => {
    if (!body?.trim()) return;
    const lines = wrapText(body.trim(), f.regular, 9.5, CONTENT_W);
    if (y - 14 - lh < BOTTOM) newPage();
    y -= 4;
    text(page, label, M, y, f.bold, 8, MUTED);
    y -= 14;
    for (const l of lines) {
      if (y < BOTTOM) newPage();
      text(page, l, M, y, f.regular, 9.5);
      y -= lh;
    }
    y -= 10;
  };
  section("NOTES", d.invoice.memo);
  const payUrl = d.payUrl?.trim();
  if (payUrl && /^https?:\/\//i.test(payUrl) && d.invoice.status !== "paid" && d.invoice.status !== "void") {
    const lines = wrapText(payUrl, f.regular, 9.5, CONTENT_W);
    if (y - 14 - lh * (lines.length + 1) < BOTTOM) newPage();
    y -= 4;
    text(page, "PAY ONLINE", M, y, f.bold, 8, MUTED);
    y -= 14;
    text(page, "Pay securely online:", M, y, f.regular, 9.5);
    y -= lh;
    for (const l of lines) {
      text(page, l, M, y, f.regular, 9.5, accent);
      const w = f.regular.widthOfTextAtSize(l, 9.5);
      page.drawLine({
        start: { x: M, y: y - 1.5 },
        end: { x: M + w, y: y - 1.5 },
        thickness: 0.5,
        color: accent,
      });
      linkAnnotation(doc, page, { x: M, y: y - 3, width: w, height: lh }, payUrl);
      y -= lh;
    }
    y -= 10;
  }
  section("PAYMENT INSTRUCTIONS", d.paymentInstructions);

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    text(p, label, W - M, M - 18, f.regular, 8, MUTED, "right");
    text(
      p,
      truncateText(`${d.org.name} - Invoice ${d.invoice.number}`, f.regular, 8, 360),
      M,
      M - 18,
      f.regular,
      8,
      MUTED,
    );
  });

  return doc.save();
}
