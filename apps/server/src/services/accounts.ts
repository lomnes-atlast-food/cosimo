/** Chart of accounts (SPEC §5.2, §6.3). */
import { chartOfAccounts } from "@cosimo/core";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { type AccountType, defaultTemplateForEntity } from "@cosimo/shared";
import { and, eq, inArray } from "drizzle-orm";
import { conflict, notFound, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { balances } from "./ledger.ts";
import type { OrgSeeder } from "./orgs.ts";

type Reader = OrgDb | OrgTx;
type AccountRow = typeof org.accounts.$inferSelect;

export interface AccountView {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  parent_id: string | null;
  tax_line: string | null;
  description: string | null;
  is_active: boolean;
  is_system: boolean;
  system_key: string | null;
  currency: string;
  /** Raw posted balance (debit positive). */
  balance?: number;
}

export function accountView(a: AccountRow, balance?: number): AccountView {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    type: a.type,
    subtype: a.subtype,
    parent_id: a.parentId,
    tax_line: a.taxLine,
    description: a.description,
    is_active: a.isActive,
    is_system: a.isSystem,
    system_key: a.systemKey,
    currency: a.currency,
    ...(balance !== undefined ? { balance } : {}),
  };
}

/** Org seeder: install the chart of accounts template chosen at creation. */
export const coaSeeder: OrgSeeder = async (tx, _orgId, input) => {
  const template = input.coaTemplate ?? defaultTemplateForEntity(input.entityType ?? "single_member_llc");
  const currency = input.baseCurrency ?? "USD";
  const rows = chartOfAccounts(template).map((t) => ({
    id: newId(),
    code: t.code,
    name: t.name,
    type: t.type,
    subtype: t.subtype,
    taxLine: t.taxLine ?? null,
    description: t.description ?? null,
    isSystem: Boolean(t.systemKey),
    systemKey: t.systemKey ?? null,
    currency,
  }));
  for (let i = 0; i < rows.length; i += 50) await tx.insert(org.accounts).values(rows.slice(i, i + 50));
};

export async function listAccounts(db: Reader, opts: { withBalances?: boolean; asOf?: string } = {}) {
  const rows = await db.select().from(org.accounts).all();
  const bal = opts.withBalances ? await balances(db, { to: opts.asOf }) : null;
  return rows
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
    .map((a) => accountView(a, bal ? (bal.get(a.id) ?? 0) : undefined));
}

export async function getAccount(db: Reader, id: string) {
  const a = await db.select().from(org.accounts).where(eq(org.accounts.id, id)).get();
  if (!a) throw notFound("Account");
  return a;
}

export interface AccountInput {
  code: string;
  name: string;
  type: AccountType;
  subtype?: string;
  parent_id?: string | null;
  tax_line?: string | null;
  description?: string | null;
  is_active?: boolean;
}

const INHERITED = "Sub-accounts take their type, detail type, and tax line from the parent account.";
const typeLabel = (t: AccountType) => t.charAt(0).toUpperCase() + t.slice(1);

/** Every account, indexed for walking the parent tree. */
async function accountTree(tx: Reader) {
  const all = await tx.select().from(org.accounts).all();
  const byId = new Map(all.map((a) => [a.id, a]));
  const kids = new Map<string, AccountRow[]>();
  for (const a of all) if (a.parentId) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a]);
  const code = (x: AccountRow, y: AccountRow) => x.code.localeCompare(y.code, undefined, { numeric: true });
  /** The account's descendants, depth-first in code order (not the account itself). */
  const descendants = (id: string) => {
    const out: AccountRow[] = [];
    const seen = new Set([id]);
    const walk = (p: string) => {
      for (const c of (kids.get(p) ?? []).sort(code)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  };
  return { byId, descendants };
}

/**
 * Resolve the parent a sub-account will sit under. Children always carry the parent's type,
 * subtype, and tax line; an explicit value that differs is an API misuse (the web form sends the
 * parent's values).
 */
function resolveParent(
  byId: Map<string, AccountRow>,
  selfId: string | null,
  parentId: string,
  input: Partial<AccountInput>,
) {
  const p = byId.get(parentId);
  if (!p) throw unprocessable("Parent account not found.", "invalid_parent");
  let cur: string | null = parentId;
  for (let i = 0; cur && i < 100; i++) {
    if (cur === selfId) throw unprocessable("An account cannot be its own ancestor.", "invalid_parent");
    cur = byId.get(cur)?.parentId ?? null;
  }
  if (
    (input.type !== undefined && input.type !== p.type) ||
    (input.subtype !== undefined && input.subtype !== p.subtype) ||
    (input.tax_line !== undefined && (input.tax_line ?? null) !== p.taxLine)
  )
    throw unprocessable(INHERITED, "invalid_parent");
  return p;
}

export async function createAccountTx(tx: OrgTx, orgId: string, a: ActorInfo, input: AccountInput) {
  const parent = input.parent_id
    ? resolveParent((await accountTree(tx)).byId, null, input.parent_id, input)
    : null;
  if (parent && !parent.isActive && (input.is_active ?? true))
    throw conflict("The parent account is inactive. Reactivate it first.", "parent_inactive");
  const s = await tx.select({ c: org.orgSettings.baseCurrency }).from(org.orgSettings).get();
  const row = {
    id: newId(),
    code: input.code.trim(),
    name: input.name.trim(),
    type: parent?.type ?? input.type,
    subtype: parent?.subtype ?? input.subtype ?? "other",
    parentId: parent?.id ?? null,
    taxLine: parent ? parent.taxLine : (input.tax_line ?? null),
    description: input.description ?? null,
    isActive: input.is_active ?? true,
    currency: s?.c ?? "USD",
  };
  const clash = await tx
    .select({ id: org.accounts.id })
    .from(org.accounts)
    .where(eq(org.accounts.code, row.code))
    .get();
  if (clash) throw conflict(`Account code ${row.code} is already used.`, "duplicate_code");
  await tx.insert(org.accounts).values(row);
  const created = await getAccount(tx, row.id);
  await appendAudit(tx, orgId, a, {
    action: "account.create",
    targetType: "account",
    targetId: row.id,
    after: accountView(created),
  });
  return created;
}

/**
 * Update an account. A sub-account takes its parent's type, subtype, and tax line, and whatever
 * this account ends up with cascades to its whole subtree (one audit entry per changed account).
 * Deactivating deactivates the subtree. All checks run before any write.
 */
export async function updateAccountTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  input: Partial<AccountInput>,
) {
  const before = await getAccount(tx, id);
  if (before.isSystem && input.type && input.type !== before.type) {
    throw conflict("System accounts cannot change type.", "system_account");
  }
  if (before.isSystem && input.is_active === false)
    throw conflict("System accounts cannot be deactivated.", "system_account");
  const { byId, descendants } = await accountTree(tx);
  const parentId = input.parent_id !== undefined ? input.parent_id : before.parentId;
  let parent: AccountRow | null = null;
  if (parentId) {
    if (before.isSystem) throw unprocessable("System accounts cannot be sub-accounts.", "invalid_parent");
    parent = resolveParent(byId, id, parentId, input);
  }
  const type = parent ? parent.type : (input.type ?? before.type);
  const subtype = parent ? parent.subtype : (input.subtype ?? before.subtype);
  const taxLine = parent ? parent.taxLine : input.tax_line !== undefined ? input.tax_line : before.taxLine;
  const isActive = input.is_active ?? before.isActive;
  if (isActive && parent && !parent.isActive && (!before.isActive || parentId !== before.parentId))
    throw conflict("The parent account is inactive. Reactivate it first.", "parent_inactive");

  const subtree = [before, ...descendants(id)];
  const retyped = subtree.filter((x) => x.type !== type);
  if (retyped.some((x) => x.isSystem))
    throw conflict("System accounts cannot change type.", "system_account");
  if (retyped.length) {
    const posted = await tx
      .selectDistinct({ id: org.journalLines.accountId })
      .from(org.journalLines)
      .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
      .where(
        and(
          eq(org.journalEntries.status, "posted"),
          inArray(
            org.journalLines.accountId,
            retyped.map((x) => x.id),
          ),
        ),
      )
      .all();
    const ids = new Set(posted.map((p) => p.id));
    const hit = retyped.find((x) => ids.has(x.id));
    if (hit)
      throw conflict(
        `${hit.code} ${hit.name} has posted entries, so its type can't change.` +
          (parent ? ` Choose a parent of type ${typeLabel(hit.type)}.` : ""),
        "account_in_use",
      );
  }
  const deactivate = input.is_active === false && before.isActive;
  if (deactivate) {
    const bal = await balances(tx);
    const held = subtree.find((x) => (bal.get(x.id) ?? 0) !== 0);
    if (held)
      throw conflict(
        held.id === id
          ? "Only accounts with a zero balance can be deactivated."
          : `Sub-account ${held.code} ${held.name} has a balance. Only accounts with a zero balance can be deactivated.`,
        "nonzero_balance",
      );
    if (subtree.some((x) => x.isSystem))
      throw conflict("System accounts cannot be deactivated.", "system_account");
  }
  if (input.code && input.code.trim() !== before.code) {
    const clash = await tx
      .select({ id: org.accounts.id })
      .from(org.accounts)
      .where(eq(org.accounts.code, input.code.trim()))
      .get();
    if (clash) throw conflict(`Account code ${input.code} is already used.`, "duplicate_code");
  }
  const patch: Partial<typeof org.accounts.$inferInsert> = {};
  if (input.code !== undefined) patch.code = input.code.trim();
  if (input.name !== undefined) patch.name = input.name.trim();
  if (type !== before.type) patch.type = type;
  if (subtype !== before.subtype) patch.subtype = subtype;
  if (input.parent_id !== undefined) patch.parentId = input.parent_id;
  if (taxLine !== before.taxLine) patch.taxLine = taxLine;
  if (input.description !== undefined) patch.description = input.description;
  if (input.is_active !== undefined) patch.isActive = input.is_active;
  if (Object.keys(patch).length) await tx.update(org.accounts).set(patch).where(eq(org.accounts.id, id));
  const after = await getAccount(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "account.update",
    targetType: "account",
    targetId: id,
    before: accountView(before),
    after: accountView(after),
  });
  for (const d of subtree.slice(1)) {
    const p: Partial<typeof org.accounts.$inferInsert> = {};
    if (d.type !== type) p.type = type;
    if (d.subtype !== subtype) p.subtype = subtype;
    if (d.taxLine !== taxLine) p.taxLine = taxLine;
    if (deactivate && d.isActive) p.isActive = false;
    if (!Object.keys(p).length) continue;
    await tx.update(org.accounts).set(p).where(eq(org.accounts.id, d.id));
    await appendAudit(tx, orgId, a, {
      action: "account.update",
      targetType: "account",
      targetId: d.id,
      before: accountView(d),
      after: accountView(await getAccount(tx, d.id)),
    });
  }
  return after;
}

export async function deleteAccountTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const before = await getAccount(tx, id);
  if (before.isSystem) throw conflict("System accounts cannot be deleted.", "system_account");
  const used = await tx
    .select({ id: org.journalLines.id })
    .from(org.journalLines)
    .where(eq(org.journalLines.accountId, id))
    .limit(1)
    .get();
  if (used) throw conflict("This account has journal lines. Deactivate it instead.", "account_in_use");
  const child = await tx
    .select({ id: org.accounts.id })
    .from(org.accounts)
    .where(eq(org.accounts.parentId, id))
    .limit(1)
    .get();
  if (child) throw conflict("Move or delete this account's sub-accounts first.", "account_in_use");
  await tx.delete(org.accounts).where(eq(org.accounts.id, id));
  await appendAudit(tx, orgId, a, {
    action: "account.delete",
    targetType: "account",
    targetId: id,
    before: accountView(before),
  });
}
