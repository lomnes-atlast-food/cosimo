/**
 * Reconciliation (SPEC §7.4). Balances are in the account's normal sign as shown on the statement:
 * money in the bank for asset accounts, amount owed for credit cards (liabilities).
 */
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { conflict, forbidden, notFound, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";

type Reader = OrgDb | OrgTx;
type ReconRow = typeof org.reconciliations.$inferSelect;

async function ledgerAccount(db: Reader, id: string) {
  const a = await db.select().from(org.accounts).where(eq(org.accounts.id, id)).get();
  if (!a) throw notFound("Account");
  if (a.type !== "asset" && a.type !== "liability") {
    throw unprocessable(
      "Only bank, card, and other balance sheet accounts can be reconciled.",
      "invalid_account",
    );
  }
  return a;
}

const signFor = (type: string) => (type === "asset" ? 1 : -1);

export async function mustGetRecon(db: Reader, id: string) {
  const r = await db.select().from(org.reconciliations).where(eq(org.reconciliations.id, id)).get();
  if (!r) throw notFound("Reconciliation");
  return r;
}

/** Line ids cleared by completed reconciliations of this account. */
async function clearedElsewhere(db: Reader, accountId: string, exceptRecon?: string) {
  const rows = await db
    .select({ lineId: org.reconciliationItems.journalLineId })
    .from(org.reconciliationItems)
    .innerJoin(org.reconciliations, eq(org.reconciliations.id, org.reconciliationItems.reconciliationId))
    .where(
      and(
        eq(org.reconciliations.bankAccountId, accountId),
        eq(org.reconciliations.status, "completed"),
        exceptRecon ? ne(org.reconciliations.id, exceptRecon) : undefined,
      ),
    )
    .all();
  return new Set(rows.map((r) => r.lineId));
}

export function reconView(r: ReconRow) {
  return {
    id: r.id,
    account_id: r.bankAccountId,
    statement_end_date: r.statementEndDate,
    statement_ending_balance: r.statementEndingBalance,
    beginning_balance: r.beginningBalance,
    cleared_balance: r.clearedBalance,
    difference: r.statementEndingBalance - r.clearedBalance,
    status: r.status,
    created_at: r.createdAt,
    completed_at: r.completedAt,
    undone_at: r.undoneAt,
  };
}

export async function listRecons(db: Reader, accountId?: string) {
  const rows = await db
    .select()
    .from(org.reconciliations)
    .where(accountId ? eq(org.reconciliations.bankAccountId, accountId) : undefined)
    .orderBy(desc(org.reconciliations.statementEndDate), desc(org.reconciliations.createdAt))
    .all();
  return rows.map(reconView);
}

export async function startReconTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: { account_id: string; statement_end_date: string; statement_ending_balance: number },
) {
  await ledgerAccount(tx, input.account_id);
  const open = await tx
    .select({ id: org.reconciliations.id })
    .from(org.reconciliations)
    .where(
      and(
        eq(org.reconciliations.bankAccountId, input.account_id),
        eq(org.reconciliations.status, "in_progress"),
      ),
    )
    .get();
  if (open)
    throw conflict(
      "Finish or discard the reconciliation already in progress for this account.",
      "in_progress",
      { id: open.id },
    );
  const last = await tx
    .select()
    .from(org.reconciliations)
    .where(
      and(
        eq(org.reconciliations.bankAccountId, input.account_id),
        eq(org.reconciliations.status, "completed"),
      ),
    )
    .orderBy(desc(org.reconciliations.statementEndDate))
    .limit(1)
    .get();
  if (last && input.statement_end_date <= last.statementEndDate) {
    throw unprocessable(
      `This account is reconciled through ${last.statementEndDate}. Choose a later statement date.`,
      "already_reconciled",
    );
  }
  const beginning = last?.statementEndingBalance ?? 0;
  const id = newId();
  await tx.insert(org.reconciliations).values({
    id,
    bankAccountId: input.account_id,
    statementEndDate: input.statement_end_date,
    statementEndingBalance: input.statement_ending_balance,
    beginningBalance: beginning,
    clearedBalance: beginning,
    createdBy: a.userId,
  });
  await appendAudit(tx, orgId, a, {
    action: "reconciliation.start",
    targetType: "reconciliation",
    targetId: id,
    after: input,
  });
  return reconView(await mustGetRecon(tx, id));
}

/** Posted lines on the account through the statement date that no completed reconciliation cleared. */
export async function reconLines(db: Reader, id: string) {
  const r = await mustGetRecon(db, id);
  const acct = await ledgerAccount(db, r.bankAccountId);
  const sign = signFor(acct.type);
  const done = await clearedElsewhere(db, r.bankAccountId, r.id);
  const mine = new Set(
    (
      await db
        .select({ lineId: org.reconciliationItems.journalLineId })
        .from(org.reconciliationItems)
        .where(eq(org.reconciliationItems.reconciliationId, id))
        .all()
    ).map((x) => x.lineId),
  );
  const lines = await db
    .select({
      id: org.journalLines.id,
      entryId: org.journalEntries.id,
      date: org.journalEntries.date,
      memo: org.journalEntries.memo,
      description: org.journalLines.description,
      amount: org.journalLines.amount,
    })
    .from(org.journalLines)
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
    .where(
      and(
        eq(org.journalLines.accountId, r.bankAccountId),
        eq(org.journalEntries.status, "posted"),
        r.status === "in_progress" ? lte(org.journalEntries.date, r.statementEndDate) : undefined,
      ),
    )
    .orderBy(asc(org.journalEntries.date), asc(org.journalEntries.chainSeq))
    .all();
  return {
    reconciliation: reconView(r),
    lines: lines
      .filter(
        (l) =>
          !done.has(l.id) && (r.status === "in_progress" || mine.has(l.id) || l.date <= r.statementEndDate),
      )
      .map((l) => ({
        id: l.id,
        entry_id: l.entryId,
        date: l.date,
        memo: l.memo,
        description: l.description,
        amount: l.amount * sign,
        cleared: mine.has(l.id),
      })),
  };
}

async function recompute(tx: OrgTx, r: ReconRow, sign: number) {
  const sum = await tx
    .select({ total: sql<number>`coalesce(sum(${org.journalLines.amount}), 0)` })
    .from(org.reconciliationItems)
    .innerJoin(org.journalLines, eq(org.journalLines.id, org.reconciliationItems.journalLineId))
    .where(eq(org.reconciliationItems.reconciliationId, r.id))
    .get();
  const cleared = r.beginningBalance + Number(sum?.total ?? 0) * sign;
  await tx
    .update(org.reconciliations)
    .set({ clearedBalance: cleared })
    .where(eq(org.reconciliations.id, r.id));
}

export async function toggleLinesTx(tx: OrgTx, id: string, lineIds: string[], cleared: boolean) {
  const r = await mustGetRecon(tx, id);
  if (r.status !== "in_progress") throw conflict("This reconciliation is locked.", "locked");
  const acct = await ledgerAccount(tx, r.bankAccountId);
  if (lineIds.length) {
    const valid = await tx
      .select({ id: org.journalLines.id })
      .from(org.journalLines)
      .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
      .where(
        and(
          inArray(org.journalLines.id, lineIds),
          eq(org.journalLines.accountId, r.bankAccountId),
          eq(org.journalEntries.status, "posted"),
          lte(org.journalEntries.date, r.statementEndDate),
        ),
      )
      .all();
    const done = await clearedElsewhere(tx, r.bankAccountId, r.id);
    const ok = valid.map((v) => v.id).filter((x) => !done.has(x));
    if (ok.length !== new Set(lineIds).size)
      throw unprocessable("Some lines do not belong to this reconciliation.", "invalid_lines");
    if (cleared) {
      await tx
        .insert(org.reconciliationItems)
        .values(ok.map((journalLineId) => ({ reconciliationId: id, journalLineId })))
        .onConflictDoNothing();
    } else {
      await tx
        .delete(org.reconciliationItems)
        .where(
          and(
            eq(org.reconciliationItems.reconciliationId, id),
            inArray(org.reconciliationItems.journalLineId, ok),
          ),
        );
    }
  }
  await recompute(tx, r, signFor(acct.type));
  return reconView(await mustGetRecon(tx, id));
}

export async function completeReconTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const r = await mustGetRecon(tx, id);
  if (r.status !== "in_progress") throw conflict(`This reconciliation is ${r.status}.`, "invalid_state");
  if (r.clearedBalance !== r.statementEndingBalance) {
    throw unprocessable(
      `The cleared balance differs from the statement by ${((r.statementEndingBalance - r.clearedBalance) / 100).toFixed(2)}.`,
      "not_balanced",
    );
  }
  const completedAt = new Date().toISOString();
  await tx
    .update(org.reconciliations)
    .set({ status: "completed", completedBy: a.userId, completedAt })
    .where(eq(org.reconciliations.id, id));
  await appendAudit(tx, orgId, a, {
    action: "reconciliation.complete",
    targetType: "reconciliation",
    targetId: id,
    after: reconView({ ...r, status: "completed" }),
  });
  return reconView(await mustGetRecon(tx, id));
}

export async function discardReconTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const r = await mustGetRecon(tx, id);
  if (r.status !== "in_progress")
    throw conflict("Only a reconciliation in progress can be discarded.", "invalid_state");
  await tx.delete(org.reconciliationItems).where(eq(org.reconciliationItems.reconciliationId, id));
  await tx.delete(org.reconciliations).where(eq(org.reconciliations.id, id));
  await appendAudit(tx, orgId, a, {
    action: "reconciliation.discard",
    targetType: "reconciliation",
    targetId: id,
    before: reconView(r),
  });
}

/** Undo the latest completed reconciliation of an account (owners only; audit logged). */
export async function undoReconTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  if (a.role !== "owner" || a.actor === "mcp")
    throw forbidden("Only owners can undo a completed reconciliation.");
  const r = await mustGetRecon(tx, id);
  if (r.status !== "completed")
    throw conflict("Only completed reconciliations can be undone.", "invalid_state");
  const later = await tx
    .select({ id: org.reconciliations.id })
    .from(org.reconciliations)
    .where(
      and(
        eq(org.reconciliations.bankAccountId, r.bankAccountId),
        eq(org.reconciliations.status, "completed"),
        sql`${org.reconciliations.statementEndDate} > ${r.statementEndDate}`,
      ),
    )
    .get();
  if (later) throw conflict("Undo the later reconciliations of this account first.", "not_latest");
  const undoneAt = new Date().toISOString();
  await tx
    .update(org.reconciliations)
    .set({ status: "undone", undoneBy: a.userId, undoneAt })
    .where(eq(org.reconciliations.id, id));
  await appendAudit(tx, orgId, a, {
    action: "reconciliation.undo",
    targetType: "reconciliation",
    targetId: id,
    before: reconView(r),
  });
  return reconView(await mustGetRecon(tx, id));
}

/** Unreconciled posted lines of an account (as of a date). */
export async function unreconciled(db: Reader, accountId: string, asOf?: string) {
  const acct = await ledgerAccount(db, accountId);
  const done = await clearedElsewhere(db, accountId);
  const rows = await db
    .select({
      id: org.journalLines.id,
      entryId: org.journalEntries.id,
      date: org.journalEntries.date,
      memo: org.journalEntries.memo,
      amount: org.journalLines.amount,
    })
    .from(org.journalLines)
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
    .where(
      and(
        eq(org.journalLines.accountId, accountId),
        eq(org.journalEntries.status, "posted"),
        asOf ? lte(org.journalEntries.date, asOf) : undefined,
      ),
    )
    .orderBy(asc(org.journalEntries.date))
    .all();
  const sign = signFor(acct.type);
  return rows
    .filter((r) => !done.has(r.id))
    .map((r) => ({ id: r.id, entry_id: r.entryId, date: r.date, memo: r.memo, amount: r.amount * sign }));
}
