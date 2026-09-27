/**
 * QuickBooks Online / Xero / Wave importers (SPEC §14.2): parse product CSV exports into one normalized
 * ImportBundle. Pure and deterministic; no DB or network access.
 */
import { type CsvTable, findTable, ImportContext, type ProductImporter, readCsv } from "./common.ts";
import { qbo } from "./qbo.ts";
import type {
  ImportBundle,
  ImportDetection,
  ImportFileInput,
  ImportFileKind,
  ImportFileStat,
  ImportSource,
} from "./types.ts";
import { wave } from "./wave.ts";
import { xero } from "./xero.ts";

export { guessAccountTypeFromName } from "./common.ts";
export { mapQboType } from "./qbo.ts";
export * from "./types.ts";
export { mapWaveType } from "./wave.ts";
export { mapXeroType } from "./xero.ts";

/** Checked in this order: Wave and Xero headers are more specific than QuickBooks'. */
const PRODUCTS: ProductImporter[] = [wave, xero, qbo];

const PRODUCT_NAMES: Record<ImportSource, string> = { qbo: "QuickBooks Online", xero: "Xero", wave: "Wave" };

function sniff(
  content: string,
  only?: ImportSource,
): { product: ProductImporter; kind: ImportFileKind; table: CsvTable } | null {
  const rows = readCsv(content);
  for (const product of PRODUCTS) {
    if (only && product.source !== only) continue;
    let kind: ImportFileKind | null = null;
    const table = findTable(rows, (h, raw) => {
      kind = product.detect(h, raw);
      return kind !== null;
    });
    if (table && kind) return { product, kind, table };
  }
  return null;
}

/**
 * Identify a product export by sniffing its header row. Tolerates a BOM, quoted fields and a preamble of
 * report title rows (report name, company name, date range, blank lines) before the header.
 */
export function detectFile(file: ImportFileInput): ImportDetection | null {
  const s = sniff(file.content);
  return s ? { source: s.product.source, kind: s.kind } : null;
}

const KIND_ORDER: Record<ImportFileKind, number> = { accounts: 0, contacts: 1, ledger: 2 };

/**
 * Parse a set of export files from one product into an ImportBundle. Never throws for content problems;
 * they are reported in `issues` (errors: file/transaction skipped; warnings: imported but needs review).
 * Charts of accounts are read first, then contacts, then ledgers, so ledger lines resolve against the chart.
 */
export function parseImport(files: ImportFileInput[], opts: { source?: ImportSource } = {}): ImportBundle {
  const sniffed = files.map((f) => ({
    file: f,
    s: (opts.source ? sniff(f.content, opts.source) : null) ?? sniff(f.content),
  }));
  let source = opts.source;
  if (!source) {
    const counts = new Map<ImportSource, number>();
    for (const { s } of sniffed) if (s) counts.set(s.product.source, (counts.get(s.product.source) ?? 0) + 1);
    // Majority product wins; ties go to the first file's product. Default qbo when nothing is recognized.
    let best: ImportSource | undefined;
    for (const { s } of sniffed) {
      if (!s) continue;
      const src = s.product.source;
      if (!best || (counts.get(src) ?? 0) > (counts.get(best) ?? 0)) best = src;
    }
    source = best ?? "qbo";
  }
  const ctx = new ImportContext(source);
  const stats: ImportFileStat[] = files.map((f) => ({ name: f.name, kind: "unknown", rows: 0 }));
  const sources = new Set(sniffed.flatMap(({ s }) => (s ? [s.product.source] : [])));
  sources.add(source);
  if (sources.size > 1) {
    const skipped = sniffed.filter(({ s }) => s && s.product.source !== source).map(({ file }) => file.name);
    ctx.error(
      "",
      null,
      `Files come from more than one product (${[...sources].map((x) => PRODUCT_NAMES[x]).join(", ")}); ` +
        `import one product at a time. Only ${PRODUCT_NAMES[source]} files were read; skipped: ${skipped.join(", ")}.`,
    );
  }

  const work = sniffed
    .map((x, i) => ({ ...x, i }))
    .filter(({ file, s, i }) => {
      if (!s) {
        ctx.error(
          file.name,
          null,
          "Not a recognized QuickBooks Online, Xero or Wave CSV export (chart of accounts, contacts, or journal/transactions)",
        );
        return false;
      }
      if (s.product.source !== source) {
        stats[i]!.kind = s.kind;
        return false;
      }
      return true;
    })
    .sort((a, b) => KIND_ORDER[a.s!.kind] - KIND_ORDER[b.s!.kind] || a.i - b.i);

  let lastLedger = "";
  for (const { file, s, i } of work) {
    const { product, kind, table } = s!;
    const res = product[kind](ctx, file.name, table);
    stats[i] = { name: file.name, kind, rows: res.rows };
    if (kind === "ledger") lastLedger = file.name;
  }
  const product = PRODUCTS.find((p) => p.source === source)!;
  const contacts = ctx.finishContacts(product.warnDerivedContacts, lastLedger);

  const entries = [...ctx.entries]
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const ra = a.reference ?? "";
      const rb = b.reference ?? "";
      if (ra !== rb) return ra < rb ? -1 : 1;
      return a.order - b.order;
    })
    .map(({ order: _order, ...e }) => e);

  let total = 0;
  for (const e of entries) for (const l of e.lines) if (l.amount > 0) total += l.amount;
  const first = entries[0];
  const last = entries[entries.length - 1];

  return {
    source,
    accounts: ctx.accounts,
    contacts,
    entries,
    issues: ctx.issues,
    stats: {
      files: stats,
      date_range: first && last ? { from: first.date, to: last.date } : null,
      total_debits: total,
    },
  };
}
