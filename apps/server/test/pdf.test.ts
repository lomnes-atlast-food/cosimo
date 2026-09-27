import { describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  fmtDate,
  formatCell,
  formatQuantity,
  hexToRgb,
  type InvoicePdfData,
  type ReportPdfData,
  renderInvoicePdf,
  renderReportPdf,
  toWinAnsi,
  wrapText,
} from "../src/pdf/index.ts";

const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQt4oHAAE0ALmPgfRgAAAAAElFTkSuQmCC"),
  (c) => c.charCodeAt(0),
);

function invoice(overrides: Partial<InvoicePdfData> = {}, lineCount = 3): InvoicePdfData {
  const lines = Array.from({ length: lineCount }, (_, i) => ({
    description: `Consulting services, item ${i + 1}`,
    quantityMilli: 2500,
    unitPrice: 12_000,
    amount: 30_000,
  }));
  const total = lines.reduce((a, l) => a + l.amount, 0);
  return {
    org: {
      name: "Acme Studio",
      legalName: "Acme Studio LLC",
      address: { line1: "1 Main St", city_line: "Springfield, IL 62701" },
      email: "billing@acme.test",
      phone: "555-0100",
      logo: null,
      color: "#1f3a5f",
    },
    invoice: {
      number: "INV-0001",
      issueDate: "2026-01-31",
      dueDate: "2026-03-02",
      terms: "Net 30",
      memo: "Thanks for your business.",
      status: "sent",
      currency: "USD",
      subtotal: total,
      total,
      amountPaid: 0,
      balanceDue: total,
    },
    customer: { name: "Globex Corp", email: "ap@globex.test", address: { line1: "9 Elm Rd" } },
    lines,
    paymentInstructions: "ACH to routing 000000000, account 0000000.",
    ...overrides,
  };
}

function report(rowCount: number, overrides: Partial<ReportPdfData> = {}): ReportPdfData {
  return {
    title: "Profit and Loss",
    orgName: "Acme Studio",
    subtitle: "January 1, 2026 to March 31, 2026 · Accrual basis",
    currency: "USD",
    columns: [{ label: "Account" }, { label: "Amount" }],
    rows: Array.from({ length: rowCount }, (_, i) => ({
      kind: "account" as const,
      depth: 1,
      cells: [`Account ${i}`, (i % 3 === 0 ? -1 : 1) * i * 1234],
    })),
    footer: ["Generated 2026-04-01", `Chain head ${"ab".repeat(32)}`],
    ...overrides,
  };
}

async function load(bytes: Uint8Array) {
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  return PDFDocument.load(bytes, { updateMetadata: false });
}

describe("text helpers", () => {
  test("toWinAnsi maps common unicode and never throws", () => {
    expect(toWinAnsi("“hi” ‘x’")).toBe("\"hi\" 'x'");
    expect(toWinAnsi("a–b—c")).toBe("a-b-c");
    expect(toWinAnsi("wait…")).toBe("wait...");
    expect(toWinAnsi("a · b")).toBe("a - b");
    expect(toWinAnsi("a b")).toBe("a b");
    expect(toWinAnsi("≥ ≤ →")).toBe(">= <= ->");
    expect(toWinAnsi("• café €5")).toBe("• café €5");
    expect(toWinAnsi("Łódź")).toBe("Lódz");
    expect(toWinAnsi("\u{1F600}")).toBe("?");
    expect(toWinAnsi("\u{1F44D}\u{1F3FD}")).toBe("??");
    expect(toWinAnsi("東京")).toBe("??");
    const font = { encode: toWinAnsi("\u{1F468}‍\u{1F469}‍\u{1F467} ☃️ \ud800") };
    expect(font.encode).toBe("??? ? ?");
  });

  test("toWinAnsi output is encodable by Helvetica", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const nasty = "\u{1F600}東京 “q” … · \u0000\u0007 ­ ☃ א Ж é";
    expect(() => font.encodeText(toWinAnsi(nasty).replace(/\n/g, " "))).not.toThrow();
  });

  test("wrapText wraps, honors newlines and hard-breaks long words", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = wrapText(`short words here\n${"x".repeat(200)}`, font, 10, 100);
    expect(lines[0]).toBe("short words here");
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(font.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(100);
    expect(lines.slice(1).join("")).toBe("x".repeat(200));
    expect(wrapText("a\n\nb", font, 10, 100)).toEqual(["a", "", "b"]);
  });

  test("fmtDate, hexToRgb, formatQuantity", () => {
    expect(fmtDate("2026-01-31")).toBe("Jan 31, 2026");
    expect(fmtDate("2026-12-01")).toBe("Dec 1, 2026");
    expect(fmtDate("bogus")).toBe("bogus");
    expect(hexToRgb("#ff0000")).toMatchObject({ red: 1, green: 0, blue: 0 });
    expect(hexToRgb("nope")).toEqual(hexToRgb("#1f3a5f"));
    expect(formatQuantity(1000)).toBe("1");
    expect(formatQuantity(2500)).toBe("2.5");
    expect(formatQuantity(125)).toBe("0.125");
    expect(formatQuantity(1_234_500)).toBe("1,234.5");
  });

  test("formatCell uses parentheses for negatives and no symbol", () => {
    expect(formatCell(-123456, "USD")).toBe("(1,234.56)");
    expect(formatCell(123456, "USD")).toBe("1,234.56");
    expect(formatCell(0, "USD")).toBe("0.00");
    expect(formatCell(-5, "EUR")).toBe("(0.05)");
    expect(formatCell(null, "USD")).toBe("");
    expect(formatCell("Revenue", "USD")).toBe("Revenue");
    expect(formatCell(-100, "JPY")).toBe("(1.00)");
  });
});

describe("renderInvoicePdf", () => {
  test("renders a basic invoice with metadata", async () => {
    const doc = await load(await renderInvoicePdf(invoice()));
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe("Invoice INV-0001");
    expect(doc.getProducer()).toBe("Cosimo");
    expect(doc.getCreator()).toBe("Cosimo");
  });

  test("120 lines span multiple pages", async () => {
    const doc = await load(await renderInvoicePdf(invoice({}, 120)));
    expect(doc.getPageCount()).toBeGreaterThan(2);
  });

  test("unicode-heavy input renders", async () => {
    const d = invoice({ paymentInstructions: "Pay → IBAN · “ref”… \u{1F4B8}" });
    d.org.name = "Café 東京 \u{1F600}";
    d.customer.name = "“Smart” — · … \u{1F44D}\u{1F3FD}";
    d.invoice.status = "paid";
    d.lines[0]!.description = `\u{1F680} 中文 ${"—".repeat(300)}\nsecond line\ttab`;
    const doc = await load(await renderInvoicePdf(d));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  test("corrupt logo falls back to the name", async () => {
    const bytes = new Uint8Array(256).map((_, i) => (i * 97 + 13) % 256);
    const d = invoice();
    d.org.logo = { bytes, mime: "image/png" };
    await load(await renderInvoicePdf(d));
    d.org.logo = { bytes: PNG_1X1.slice(0, 20), mime: "image/png" };
    await load(await renderInvoicePdf(d));
    d.org.logo = { bytes, mime: "image/jpeg" };
    await load(await renderInvoicePdf(d));
  });

  test("valid PNG logo renders; draft/void watermark and paid amounts", async () => {
    const d = invoice();
    d.org.logo = { bytes: PNG_1X1, mime: "image/png" };
    d.invoice.status = "draft";
    await load(await renderInvoicePdf(d));
    d.invoice.status = "void";
    d.invoice.amountPaid = 10_000;
    d.invoice.balanceDue = d.invoice.total - 10_000;
    await load(await renderInvoicePdf(d));
  });
});

describe("renderReportPdf", () => {
  test("renders a small report", async () => {
    const doc = await load(await renderReportPdf(report(10)));
    expect(doc.getPageCount()).toBe(1);
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    expect(w).toBeLessThan(h);
  });

  test("300 rows paginate", async () => {
    const doc = await load(await renderReportPdf(report(300)));
    expect(doc.getPageCount()).toBeGreaterThan(4);
  });

  test("wide reports go landscape and handle all row kinds", async () => {
    const cols = [
      { label: "Account" },
      ...Array.from({ length: 7 }, (_, i) => ({ label: `Period ${i + 1}` })),
    ];
    const d = report(0, {
      columns: cols,
      rows: [
        { kind: "header", cells: ["Income", 1, null] },
        {
          kind: "account",
          depth: 1,
          cells: ["Sales — “retail” \u{1F600}", ...cols.slice(1).map(() => -99_999_999)],
        },
        { kind: "subtotal", depth: 1, cells: ["Total income", ...cols.slice(1).map(() => 0)] },
        { kind: "total", cells: ["Net income".repeat(20), ...cols.slice(1).map(() => 123_456_789_012)] },
        { kind: "check", cells: ["Balanced ✓"] },
      ],
      footer: ["x".repeat(500)],
    });
    const doc = await load(await renderReportPdf(d));
    expect(doc.getPage(0).getWidth()).toBeGreaterThan(doc.getPage(0).getHeight());
  });

  test("handles no columns and no rows", async () => {
    await load(await renderReportPdf(report(0, { columns: [], rows: [], footer: [] })));
  });
});
