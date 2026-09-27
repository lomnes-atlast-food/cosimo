/**
 * Cash-basis derivation (SPEC §6.2). The ledger is accrual; cash-basis balances are the accrual
 * balances plus an adjustment that
 *   1. removes every invoice and bill entry (and their void reversals), and
 *   2. for each live payment application, recognizes its amount on the application date across the
 *      document's non-control lines in proportion to their amounts, and releases the matching part of
 *      the payment's AR/AP line.
 * Every adjustment is balanced, so cash-basis reports still tie out. Entries without a source document
 * are identical on both bases.
 */
import { type OrgDb, type OrgTx, org } from "@cosimo/db";
import { and, eq, gte, inArray, isNull, lte, type SQL, sql } from "drizzle-orm";
import { systemAccountId } from "./ledger.ts";

type Reader = OrgDb | OrgTx;

/** Split `total` across signed `weights` (summing to a non-zero W) by largest remainder, exactly. */
export function allocateSigned(total: number, weights: number[]): number[] {
  const W = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) return [];
  if (W === 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const T = BigInt(total);
  const Wb = BigInt(W);
  const parts = weights.map((w, i) => {
    const num = T * BigInt(w);
    // floor division for BigInt with possibly negative operands
    let q = num / Wb;
    if (num % Wb !== 0n && num < 0n !== Wb < 0n) q -= 1n;
    const rem = num - q * Wb; // 0 <= rem < |W| in W's sign convention
    return { i, q, rem: rem < 0n ? -rem : rem };
  });
  let left = T - parts.reduce((s, p) => s + p.q, 0n);
  const order = [...parts].sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
  const step = left < 0n ? -1n : 1n;
  for (let k = 0; left !== 0n; k++) {
    order[k % order.length]!.q += step;
    left -= step;
  }
  return parts.map((p) => Number(p.q));
}

function add(m: Map<string, number>, id: string, v: number) {
  if (v) m.set(id, (m.get(id) ?? 0) + v);
}

export async function cashAdjustments(db: Reader, range: { from?: string | null; to?: string | null }) {
  const adj = new Map<string, number>();

  // 1. Remove document entries dated in range.
  const conds: SQL[] = [
    eq(org.journalEntries.status, "posted"),
    inArray(org.journalEntries.sourceType, ["invoice", "bill"]),
  ];
  if (range.from) conds.push(gte(org.journalEntries.date, range.from));
  if (range.to) conds.push(lte(org.journalEntries.date, range.to));
  const docLines = await db
    .select({ accountId: org.journalLines.accountId, total: sql<number>`sum(${org.journalLines.amount})` })
    .from(org.journalLines)
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
    .where(and(...conds))
    .groupBy(org.journalLines.accountId)
    .all();
  for (const r of docLines) add(adj, r.accountId, -Number(r.total));

  // 2. Recognize live applications on their applied date.
  const appliedOn = sql<string>`coalesce(${org.paymentApplications.appliedDate}, ${org.payments.date})`;
  const aconds: SQL[] = [isNull(org.payments.voidedAt), eq(org.journalEntries.status, "posted")];
  if (range.from) aconds.push(gte(appliedOn, range.from));
  if (range.to) aconds.push(lte(appliedOn, range.to));
  const apps = await db
    .select({
      type: org.paymentApplications.documentType,
      docId: org.paymentApplications.documentId,
      amount: org.paymentApplications.amount,
    })
    .from(org.paymentApplications)
    .innerJoin(org.payments, eq(org.payments.id, org.paymentApplications.paymentId))
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.payments.entryId))
    .where(and(...aconds))
    .all();
  if (!apps.length) return adj;

  const ar = await systemAccountId(db, "ar");
  const ap = await systemAccountId(db, "ap");
  const docEntry = new Map<string, string | null>();
  for (const x of apps) {
    const key = `${x.type}:${x.docId}`;
    if (docEntry.has(key)) continue;
    const row =
      x.type === "invoice"
        ? await db
            .select({ e: org.invoices.entryId })
            .from(org.invoices)
            .where(eq(org.invoices.id, x.docId))
            .get()
        : await db.select({ e: org.bills.entryId }).from(org.bills).where(eq(org.bills.id, x.docId)).get();
    docEntry.set(key, row?.e ?? null);
  }
  const entryIds = [...new Set([...docEntry.values()].filter((e): e is string => Boolean(e)))];
  const lines = entryIds.length
    ? await db
        .select({
          entryId: org.journalLines.entryId,
          accountId: org.journalLines.accountId,
          amount: org.journalLines.amount,
        })
        .from(org.journalLines)
        .where(inArray(org.journalLines.entryId, entryIds))
        .all()
    : [];
  const byEntry = new Map<string, { accountId: string; amount: number }[]>();
  for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);

  for (const x of apps) {
    const entryId = docEntry.get(`${x.type}:${x.docId}`);
    if (!entryId) continue;
    const control = x.type === "invoice" ? ar : ap;
    const revenue = (byEntry.get(entryId) ?? []).filter((l) => l.accountId !== control);
    if (!revenue.length) continue;
    // Invoice revenue lines are credits (negative); bill expense lines debits (positive).
    const sign = x.type === "invoice" ? -1 : 1;
    const shares = allocateSigned(
      x.amount,
      revenue.map((l) => sign * l.amount),
    );
    revenue.forEach((l, i) => {
      add(adj, l.accountId, sign * shares[i]!);
    });
    add(adj, control, -sign * x.amount);
  }
  return adj;
}

/** Accrual balances turned into cash-basis balances. */
export function applyAdjustments(accrual: Map<string, number>, adj: Map<string, number>) {
  const out = new Map(accrual);
  for (const [k, v] of adj) out.set(k, (out.get(k) ?? 0) + v);
  return out;
}
