import { PDFDocument, type PDFFont, type PDFPage, type RGB, rgb, StandardFonts } from "pdf-lib";
import { fmtMoney, toWinAnsi, truncateText, wrapText } from "./text.ts";

export type ReportRowKind = "header" | "account" | "subtotal" | "total" | "check" | "row";

export interface ReportPdfData {
  title: string;
  orgName: string;
  subtitle?: string | null;
  currency: string;
  columns: { label: string; align?: "left" | "right"; width?: number }[];
  rows: {
    kind?: ReportRowKind;
    depth?: number;
    cells: (string | number | null)[];
  }[];
  footer?: string[];
  landscape?: boolean;
}

const MARGIN = 40;
const PAD = 5;
const INDENT = 12;
const TEXT = rgb(0.1, 0.11, 0.13);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.2, 0.22, 0.25);
const FONT_SIZES = [9, 8.5, 8, 7.5, 7];

/** Report cell text: cents with parentheses for negatives and no symbol; null -> "". */
export function formatCell(value: string | number | null | undefined, currency: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return "";
  return fmtMoney(Math.trunc(value), currency, { symbol: false, parens: true });
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

function draw(
  page: PDFPage,
  s: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  color: RGB = TEXT,
) {
  page.drawText(s, { x, y, size, font, color });
}

function drawAligned(
  page: PDFPage,
  s: string,
  x: number,
  w: number,
  y: number,
  font: PDFFont,
  size: number,
  align: "left" | "right" | "center",
  color: RGB = TEXT,
) {
  const tw = font.widthOfTextAtSize(s, size);
  const tx = align === "right" ? x + w - tw : align === "center" ? x + (w - tw) / 2 : x;
  draw(page, s, tx, y, font, size, color);
}

function layoutColumns(d: ReportPdfData, f: Fonts, contentW: number, aligns: ("left" | "right")[]) {
  const n = d.columns.length;
  const cellText = d.rows.map((r) =>
    d.columns.map((_, i) => toWinAnsi(formatCell(r.cells[i] ?? null, d.currency))),
  );
  let best: { size: number; widths: number[] } | null = null;
  for (const size of FONT_SIZES) {
    const widths = d.columns.map((c, i) => {
      if (c.width && c.width > 0) return c.width;
      if (i === 0) return 0;
      let measured = 0;
      for (const row of cellText) {
        const t = row[i] ?? "";
        if (t) measured = Math.max(measured, f.bold.widthOfTextAtSize(t, size));
      }
      const labelWord = Math.max(
        0,
        ...toWinAnsi(c.label)
          .split(/\s+/)
          .map((w) => f.bold.widthOfTextAtSize(w, size)),
      );
      measured = Math.max(measured, labelWord) + 2 * PAD;
      return aligns[i] === "right"
        ? Math.max(measured, (80 * size) / 9)
        : Math.min(Math.max(measured, 50), (200 * size) / 9);
    });
    const col0Fixed = Boolean(d.columns[0]?.width && d.columns[0].width > 0);
    const others = widths.slice(1).reduce((a, b) => a + b, 0);
    let labelNeed = 0;
    for (const [ri, row] of cellText.entries()) {
      const depth = Math.max(0, d.rows[ri]?.depth ?? 0);
      labelNeed = Math.max(labelNeed, f.bold.widthOfTextAtSize(row[0] ?? "", size) + depth * INDENT);
    }
    labelNeed = Math.min(labelNeed + 2 * PAD, 150);
    if (!col0Fixed) widths[0] = contentW - others;
    const total = widths.reduce((a, b) => a + b, 0);
    best = { size, widths };
    if (total <= contentW + 0.5 && (col0Fixed || (widths[0] ?? 0) >= labelNeed)) break;
  }
  if (!best) return { size: 9, widths: [] as number[] };
  // Still too wide at the smallest size: scale to fit, keeping a usable label column.
  const { widths } = best;
  if (n > 0) {
    const col0Fixed = Boolean(d.columns[0]?.width && d.columns[0].width > 0);
    if (!col0Fixed && (widths[0] ?? 0) < Math.min(120, contentW * 0.3)) {
      const label = Math.min(120, contentW * 0.3);
      const others = widths.slice(1).reduce((a, b) => a + b, 0);
      const k = others > 0 ? (contentW - label) / others : 1;
      for (let i = 1; i < n; i++) widths[i] = (widths[i] ?? 0) * k;
      widths[0] = label;
    }
    const total = widths.reduce((a, b) => a + b, 0);
    if (total > contentW) for (let i = 0; i < n; i++) widths[i] = ((widths[i] ?? 0) * contentW) / total;
  }
  return best;
}

export async function renderReportPdf(d: ReportPdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const now = new Date();
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  doc.setTitle(toWinAnsi(`${d.title} - ${d.orgName}`));
  doc.setProducer("Cosimo");
  doc.setCreator("Cosimo");
  const f: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
  const landscape = d.landscape ?? d.columns.length > 5;
  const [PW, PH] = landscape ? [792, 612] : [612, 792];
  const contentW = PW - 2 * MARGIN;
  const bottom = MARGIN + 14;

  const hasNumber = (i: number) => d.rows.some((r) => typeof r.cells[i] === "number");
  const aligns = d.columns.map((c, i) => c.align ?? (i > 0 && hasNumber(i) ? "right" : "left"));
  const { size, widths } = layoutColumns(d, f, contentW, aligns);
  const xs: number[] = [];
  widths.reduce((x, w, i) => {
    xs[i] = x;
    return x + w;
  }, MARGIN);
  const numericCols = aligns.flatMap((a, i) => (i > 0 && a === "right" ? [i] : []));
  const ruleSpan = numericCols.length
    ? { from: xs[numericCols[0]!]!, to: MARGIN + contentW }
    : { from: MARGIN, to: MARGIN + contentW };

  let page = doc.addPage([PW, PH]);
  let y = PH - MARGIN;

  // Title block
  const centered = (s: string, font: PDFFont, sz: number, color: RGB, gap: number) => {
    for (const line of wrapText(s, font, sz, contentW)) {
      drawAligned(page, line, MARGIN, contentW, y - sz, font, sz, "center", color);
      y -= sz + gap;
    }
  };
  centered(d.orgName, f.bold, 11, MUTED, 4);
  centered(d.title, f.bold, 16, TEXT, 5);
  if (d.subtitle) centered(d.subtitle, f.regular, 9, MUTED, 3);
  y -= 14;

  const headerLines = d.columns.map((c, i) => {
    const w = (widths[i] ?? 0) - 2 * PAD;
    const lines = wrapText(c.label, f.bold, size, Math.max(w, 1));
    if (lines.length <= 2) return lines;
    return [lines[0]!, truncateText(lines.slice(1).join(" "), f.bold, size, Math.max(w, 1))];
  });
  const headerRows = Math.max(1, ...headerLines.map((l) => l.length));
  const lineH = size + 2.5;
  const headerH = headerRows * lineH + 7;

  const drawTableHeader = () => {
    headerLines.forEach((lines, i) => {
      const x = (xs[i] ?? MARGIN) + PAD;
      const w = (widths[i] ?? 0) - 2 * PAD;
      // bottom-align multi-line labels
      let ly = y - 3 - size - (headerRows - lines.length) * lineH;
      for (const l of lines) {
        drawAligned(page, l, x, w, ly, f.bold, size, aligns[i] ?? "left");
        ly -= lineH;
      }
    });
    y -= headerH;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + contentW, y }, thickness: 0.9, color: RULE });
    y -= 3;
  };
  const newPage = (withHeader: boolean) => {
    page = doc.addPage([PW, PH]);
    y = PH - MARGIN;
    draw(
      page,
      truncateText(`${d.orgName} - ${d.title}`, f.regular, 8, contentW),
      MARGIN,
      y - 8,
      f.regular,
      8,
      MUTED,
    );
    y -= 20;
    if (withHeader) drawTableHeader();
  };

  if (d.columns.length > 0) {
    drawTableHeader();
    const rowH = size + 6;
    d.rows.forEach((row, ri) => {
      const kind = row.kind ?? "row";
      const strong = kind === "header" || kind === "subtotal" || kind === "total";
      const font = strong ? f.bold : kind === "check" ? f.italic : f.regular;
      const color = kind === "check" ? MUTED : TEXT;
      const extraTop = kind === "total" ? 5 : kind === "subtotal" ? 3 : kind === "header" && ri > 0 ? 5 : 0;
      if (y - rowH - extraTop < bottom) newPage(true);
      y -= extraTop;
      if (kind === "subtotal" || kind === "total") {
        const line = (ly: number) =>
          page.drawLine({
            start: { x: ruleSpan.from + PAD, y: ly },
            end: { x: ruleSpan.to, y: ly },
            thickness: 0.6,
            color: RULE,
          });
        line(y + 1);
        if (kind === "total") line(y + 3);
      }
      const baseline = y - 3 - size;
      d.columns.forEach((_, i) => {
        const v = row.cells[i] ?? null;
        if (kind === "header" && i > 0 && typeof v === "number") return;
        const indent = i === 0 ? Math.max(0, row.depth ?? 0) * INDENT : 0;
        const x = (xs[i] ?? MARGIN) + PAD + indent;
        const w = (widths[i] ?? 0) - 2 * PAD - indent;
        if (w <= 0) return;
        const s = truncateText(formatCell(v, d.currency), font, size, w);
        if (s) drawAligned(page, s, x, w, baseline, font, size, aligns[i] ?? "left", color);
      });
      y -= rowH;
    });
  }

  if (d.footer?.length) {
    y -= 14;
    const fsz = 7.5;
    for (const entry of d.footer) {
      for (const line of wrapText(entry, f.regular, fsz, contentW)) {
        if (y - fsz < bottom) newPage(false);
        draw(page, line, MARGIN, y - fsz, f.regular, fsz, MUTED);
        y -= fsz + 3;
      }
    }
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    drawAligned(p, label, MARGIN, contentW, MARGIN - 16, f.regular, 8, "right", MUTED);
    const left = truncateText(`${d.orgName} - ${d.title}`, f.regular, 8, contentW - 100);
    draw(p, left, MARGIN, MARGIN - 16, f.regular, 8, MUTED);
  });

  return doc.save();
}
