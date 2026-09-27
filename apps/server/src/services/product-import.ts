/**
 * Import from QuickBooks Online, Xero, or Wave (SPEC §14.2). The core importers parse the CSV
 * exports into an ImportBundle; this service plans how the bundle lands in an org (which accounts
 * and contacts match existing ones, which are created, which entries are new) and commits it.
 * Accounts and contacts are created directly. The entries (`source_type: import`) wait in the review
 * queue as one `import_batch` item (SPEC §7.5): approving it posts them all, rejecting it rejects all.
 *
 * Idempotent: every entry carries a source ID (the product's transaction ID, or a content hash), so
 * importing the same files twice creates nothing new.
 */
import {
  type ImportBundle,
  type ImportedAccount,
  type ImportFileInput,
  type ImportSource,
  parseImport,
  sha256Hex,
} from "@cosimo/core";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import type { AccountType } from "@cosimo/shared";
import { and, eq, inArray, like, ne } from "drizzle-orm";
import { unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { createDraftTx, postEntryTx, rejectEntryTx, settingsRow } from "./ledger.ts";
import { finishReviewTx, registerReviewHandler } from "./review.ts";
import type { OrgHandle } from "./types.ts";

type Reader = OrgDb | OrgTx;

export const MAX_PRODUCT_IMPORT_BYTES = 50 * 1024 * 1024;

export interface AccountPlan {
  key: string;
  name: string;
  type: AccountType;
  subtype: string;
  action: "match" | "create";
  /** Existing account ID (match) or the code the new account gets (create). */
  account_id: string | null;
  code: string;
  matched_by?: "system" | "code" | "name";
  synthesized: boolean;
}

export interface ProductImportReport {
  source: ImportSource;
  files: ImportBundle["stats"]["files"];
  date_range: ImportBundle["stats"]["date_range"];
  accounts: { create: number; match: number; items: AccountPlan[] };
  contacts: { create: number; match: number; create_names: string[] };
  entries: { new: number; already_imported: number; total_debits: number };
  errors: { file: string; row: number | null; message: string }[];
  warnings: { file: string; row: number | null; message: string }[];
  /** True when nothing blocks a commit (parse errors skip rows; lock errors block). */
  can_commit: boolean;
}

export interface ProductImportResult extends ProductImportReport {
  committed: boolean;
  created: { accounts: number; contacts: number; entries: number };
  /** The review item holding the new entries (null when there were none). */
  review_item_id: string | null;
}

interface BatchPayload {
  import: {
    source: ImportSource;
    files: string[];
    date_range: ImportBundle["stats"]["date_range"];
    entries: number;
    accounts_created: number;
    contacts_created: number;
    entry_ids: string[];
  };
}

const SYSTEM_BY_SUBTYPE: Record<string, string> = {
  accounts_receivable: "ar",
  accounts_payable: "ap",
  opening_balance: "opening_balance_equity",
  retained_earnings: "retained_earnings",
};

const CODE_BASE: Record<AccountType, number> = {
  asset: 1900,
  liability: 2900,
  equity: 3900,
  income: 4900,
  expense: 6900,
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function nextCode(type: AccountType, used: Set<string>) {
  for (let n = CODE_BASE[type]; ; n++) {
    const c = String(n);
    if (!used.has(c)) {
      used.add(c);
      return c;
    }
  }
}

/** Stable per-entry ID: the product's transaction ID, else a hash of its content (+ occurrence). */
function sourceIds(bundle: ImportBundle) {
  const seen = new Map<string, number>();
  return bundle.entries.map((e) => {
    if (e.external_id) return `${bundle.source}:${e.external_id}`;
    const h = sha256Hex(
      JSON.stringify([e.date, e.reference, e.memo, e.lines.map((l) => [l.account, l.amount, l.contact])]),
    ).slice(0, 32);
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return `${bundle.source}:h:${h}${n > 1 ? `:${n}` : ""}`;
  });
}

async function planAccounts(db: Reader, bundle: ImportBundle): Promise<AccountPlan[]> {
  const existing = await db.select().from(org.accounts).all();
  const bySystem = new Map(existing.filter((a) => a.systemKey).map((a) => [a.systemKey!, a]));
  const byCode = new Map(existing.map((a) => [a.code, a]));
  const byName = new Map<string, (typeof existing)[number]>();
  for (const a of existing) if (!byName.has(norm(a.name))) byName.set(norm(a.name), a);
  const used = new Set(existing.map((a) => a.code));
  const claimedSystem = new Set<string>();

  const plans: AccountPlan[] = [];
  for (const acc of bundle.accounts) {
    const subtype = acc.subtype ?? "other";
    const base = { key: acc.key, name: acc.name, type: acc.type, subtype, synthesized: !!acc.synthesized };
    const sys =
      SYSTEM_BY_SUBTYPE[subtype] ??
      (subtype === "uncategorized" && (acc.type === "income" || acc.type === "expense")
        ? `uncategorized_${acc.type}`
        : undefined);
    const sysAcct = sys && !claimedSystem.has(sys) ? bySystem.get(sys) : undefined;
    if (sysAcct && sysAcct.type === acc.type) {
      claimedSystem.add(sys!);
      plans.push({
        ...base,
        action: "match",
        account_id: sysAcct.id,
        code: sysAcct.code,
        matched_by: "system",
      });
      continue;
    }
    const byC = acc.code ? byCode.get(acc.code) : undefined;
    if (byC && byC.type === acc.type && norm(byC.name) === norm(acc.name)) {
      plans.push({ ...base, action: "match", account_id: byC.id, code: byC.code, matched_by: "code" });
      continue;
    }
    const byN = byName.get(norm(acc.full_name ?? acc.name)) ?? byName.get(norm(acc.name));
    if (byN && byN.type === acc.type) {
      plans.push({ ...base, action: "match", account_id: byN.id, code: byN.code, matched_by: "name" });
      continue;
    }
    const code = acc.code && !used.has(acc.code) ? acc.code : nextCode(acc.type, used);
    used.add(code);
    plans.push({ ...base, action: "create", account_id: null, code });
  }
  return plans;
}

async function existingSourceIds(db: Reader, source: ImportSource) {
  const rows = await db
    .select({ id: org.journalEntries.sourceId })
    .from(org.journalEntries)
    .where(
      and(
        eq(org.journalEntries.sourceType, "import"),
        like(org.journalEntries.sourceId, `${source}:%`),
        ne(org.journalEntries.status, "rejected"),
      ),
    )
    .all();
  return new Set(rows.map((r) => r.id));
}

export function parseProductFiles(files: ImportFileInput[], source?: ImportSource) {
  const bytes = files.reduce((s, f) => s + f.content.length, 0);
  if (bytes > MAX_PRODUCT_IMPORT_BYTES) throw unprocessable("The files are larger than 50 MB.", "too_large");
  if (!files.length) throw unprocessable("Add at least one CSV export.", "no_files");
  return parseImport(files, { source });
}

async function plan(db: Reader, bundle: ImportBundle) {
  const accounts = await planAccounts(db, bundle);
  const contactsExisting = await db
    .select({ id: org.contacts.id, name: org.contacts.name })
    .from(org.contacts)
    .all();
  const contactByName = new Map(contactsExisting.map((c) => [norm(c.name), c.id]));
  const newContacts = bundle.contacts.filter((c) => !contactByName.has(norm(c.name)));
  const ids = sourceIds(bundle);
  const done = await existingSourceIds(db, bundle.source);
  const s = await settingsRow(db);
  const lock = [s.hardLockDate, s.softLockDate].filter(Boolean).sort().at(-1) ?? null;

  const errors = bundle.issues.filter((i) => i.level === "error").map(({ level: _l, ...i }) => i);
  const warnings = bundle.issues.filter((i) => i.level === "warning").map(({ level: _l, ...i }) => i);
  let fresh = 0;
  let lockBlocked = 0;
  bundle.entries.forEach((e, i) => {
    if (done.has(ids[i]!)) return;
    fresh++;
    if (lock && e.date <= lock) {
      lockBlocked++;
      if (lockBlocked <= 20)
        errors.push({
          file: e.file ?? "",
          row: e.row ?? null,
          message: `${e.date} is in a locked period (books locked through ${lock}).`,
        });
    }
  });
  if (lockBlocked > 20)
    errors.push({
      file: "",
      row: null,
      message: `…and ${lockBlocked - 20} more entries in the locked period.`,
    });

  const report: ProductImportReport = {
    source: bundle.source,
    files: bundle.stats.files,
    date_range: bundle.stats.date_range,
    accounts: {
      create: accounts.filter((a) => a.action === "create").length,
      match: accounts.filter((a) => a.action === "match").length,
      items: accounts,
    },
    contacts: {
      create: newContacts.length,
      match: bundle.contacts.length - newContacts.length,
      create_names: newContacts.map((c) => c.name),
    },
    entries: {
      new: fresh,
      already_imported: bundle.entries.length - fresh,
      total_debits: bundle.stats.total_debits,
    },
    errors,
    warnings,
    can_commit:
      lockBlocked === 0 &&
      (fresh > 0 || accounts.some((a) => a.action === "create") || newContacts.length > 0),
  };
  return { report, accounts, contactByName, ids, done };
}

/** Dry run: what an import would do. Reads only. */
export async function previewProductImport(db: Reader, bundle: ImportBundle) {
  return (await plan(db, bundle)).report;
}

/**
 * Commit the bundle in one write transaction: create accounts (parents first) and contacts, then
 * hold every new entry for review under one `import_batch` item. Refuses when any entry falls in a
 * locked period.
 */
export async function commitProductImport(
  handle: OrgHandle,
  orgId: string,
  a: ActorInfo,
  bundle: ImportBundle,
): Promise<ProductImportResult> {
  return handle.write(async (tx) => {
    const { report, accounts, contactByName, ids, done } = await plan(tx, bundle);
    if (!report.can_commit) {
      if (report.errors.some((e) => e.message.includes("locked period")))
        throw unprocessable(
          "Some entries fall in a locked period. Move the lock date or remove those entries first.",
          "locked_period",
        );
      return {
        ...report,
        committed: false,
        created: { accounts: 0, contacts: 0, entries: 0 },
        review_item_id: null,
      };
    }
    const cur = (await settingsRow(tx)).baseCurrency;
    const idByKey = new Map<string, string>();
    for (const p of accounts) if (p.account_id) idByKey.set(p.key, p.account_id);
    const src = new Map<string, ImportedAccount>(bundle.accounts.map((x) => [x.key, x]));

    // Parents before children; a parent of another type is dropped (Cosimo requires the same type).
    // A sub-account takes its parent's detail type and tax line, whether the parent is created here
    // or is an existing account the import maps to.
    const byId = new Map(
      (
        await tx
          .select({
            id: org.accounts.id,
            type: org.accounts.type,
            subtype: org.accounts.subtype,
            taxLine: org.accounts.taxLine,
          })
          .from(org.accounts)
          .all()
      ).map((r) => [r.id, r]),
    );
    const pending = accounts.filter((p) => p.action === "create");
    const createdAccounts = new Set<string>();
    const depth = (k: string, n = 0): number => {
      const parent = src.get(k)?.parent;
      return parent && n < 20 ? depth(parent, n + 1) + 1 : 0;
    };
    pending.sort((x, y) => depth(x.key) - depth(y.key));
    for (const p of pending) {
      const s = src.get(p.key)!;
      const parentKey = s.parent ? idByKey.get(s.parent) : undefined;
      const parent = parentKey ? byId.get(parentKey) : undefined;
      const inherit = parent && parent.type === p.type ? parent : undefined;
      const row = {
        id: newId(),
        type: p.type,
        subtype: inherit?.subtype ?? p.subtype,
        taxLine: inherit?.taxLine ?? null,
      };
      const id = row.id;
      await tx.insert(org.accounts).values({
        ...row,
        code: p.code,
        name: p.name,
        parentId: inherit?.id ?? null,
        description: s.description,
        currency: cur,
      });
      byId.set(id, row);
      idByKey.set(p.key, id);
      p.account_id = id;
      createdAccounts.add(id);
    }

    let contactsCreated = 0;
    for (const c of bundle.contacts) {
      if (contactByName.has(norm(c.name))) continue;
      const id = newId();
      await tx.insert(org.contacts).values({
        id,
        kind: c.kind,
        name: c.name,
        email: c.email,
        phone: c.phone,
        is1099Vendor: c.is_1099_vendor ?? false,
      });
      contactByName.set(norm(c.name), id);
      contactsCreated++;
    }

    const entryIds: string[] = [];
    for (const [i, e] of bundle.entries.entries()) {
      if (done.has(ids[i]!)) continue;
      const memo = [e.source_label, e.reference ? `#${e.reference}` : null, e.memo]
        .filter(Boolean)
        .join(" · ");
      entryIds.push(
        await createDraftTx(tx, orgId, a, {
          date: e.date,
          memo: memo || null,
          sourceType: "import",
          sourceId: ids[i]!,
          lines: e.lines.map((l) => ({
            accountId: idByKey.get(l.account)!,
            amount: l.amount,
            description: l.description,
            contactId: l.contact ? (contactByName.get(norm(l.contact)) ?? null) : null,
          })),
        }),
      );
    }

    const created = { accounts: createdAccounts.size, contacts: contactsCreated, entries: entryIds.length };
    let reviewItemId: string | null = null;
    if (entryIds.length) {
      for (let i = 0; i < entryIds.length; i += 500)
        await tx
          .update(org.journalEntries)
          .set({ status: "pending_review" })
          .where(inArray(org.journalEntries.id, entryIds.slice(i, i + 500)));
      reviewItemId = newId();
      const names = { qbo: "QuickBooks Online", xero: "Xero", wave: "Wave" } as const;
      const payload: BatchPayload = {
        import: {
          source: bundle.source,
          files: bundle.stats.files.map((f) => f.name),
          date_range: bundle.stats.date_range,
          entries: entryIds.length,
          accounts_created: created.accounts,
          contacts_created: created.contacts,
          entry_ids: entryIds,
        },
      };
      await tx.insert(org.reviewItems).values({
        id: reviewItemId,
        itemType: "import_batch",
        itemId: reviewItemId,
        proposedByActor: a.actor,
        proposedById: a.userId ?? a.apiTokenId ?? null,
        reason: "Imported history is reviewed as one batch",
        rationale: `${entryIds.length} entries from ${names[bundle.source]} (${payload.import.files.join(", ")})`,
        payloadJson: JSON.stringify(payload),
        originalPayloadJson: JSON.stringify(payload),
        amount: report.entries.total_debits,
      });
    }

    const result: ProductImportResult = { ...report, committed: true, created, review_item_id: reviewItemId };
    await appendAudit(tx, orgId, a, {
      action: "import.product",
      targetType: "org",
      targetId: orgId,
      after: {
        source: bundle.source,
        files: bundle.stats.files.map((f) => f.name),
        created,
        review_item_id: reviewItemId,
        date_range: bundle.stats.date_range,
      },
    });
    return result;
  });
}

async function batchEntries(tx: OrgTx, payload: string | null) {
  const ids = payload ? (JSON.parse(payload) as BatchPayload).import.entry_ids : [];
  const rows: { id: string; date: string; status: string }[] = [];
  for (let i = 0; i < ids.length; i += 500)
    rows.push(
      ...(await tx
        .select({
          id: org.journalEntries.id,
          date: org.journalEntries.date,
          status: org.journalEntries.status,
        })
        .from(org.journalEntries)
        .where(inArray(org.journalEntries.id, ids.slice(i, i + 500)))
        .all()),
    );
  return rows.filter((r) => r.status === "pending_review").sort((x, y) => (x.date < y.date ? -1 : 1));
}

registerReviewHandler("import_batch", {
  async approve(tx, orgId, a, item, input) {
    if (input.edit)
      throw unprocessable("Imported batches can't be edited; reject it and re-import.", "unsupported");
    const rows = await batchEntries(tx, item.payloadJson);
    for (const r of rows) await postEntryTx(tx, orgId, r.id, a, input.lock_override_note ?? null);
    await finishReviewTx(tx, orgId, a, item, "approved", input.note ?? null);
    return { posted: rows.length };
  },
  async reject(tx, orgId, a, item, note) {
    for (const r of await batchEntries(tx, item.payloadJson)) await rejectEntryTx(tx, orgId, a, r.id, note);
    await finishReviewTx(tx, orgId, a, item, "rejected", note);
  },
});
