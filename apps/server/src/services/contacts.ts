/** Customers and vendors (SPEC §5.2, §8). */
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { and, asc, eq, inArray, isNull, like, or, type SQL, sql } from "drizzle-orm";
import { notFound, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";

type Reader = OrgDb | OrgTx;
type ContactRow = typeof org.contacts.$inferSelect;

export interface ContactInput {
  kind: ContactRow["kind"];
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: Record<string, string> | null;
  tax_id_last4?: string | null;
  is_1099_vendor?: boolean;
  default_account_id?: string | null;
  notes?: string | null;
}

export function contactView(c: ContactRow) {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    email: c.email,
    phone: c.phone,
    address: c.addressJson ? (JSON.parse(c.addressJson) as Record<string, string>) : null,
    tax_id_last4: c.taxIdLast4,
    is_1099_vendor: c.is1099Vendor,
    default_account_id: c.defaultAccountId,
    notes: c.notes,
    created_at: c.createdAt,
    archived_at: c.archivedAt,
  };
}

export async function mustGetContact(db: Reader, id: string) {
  const c = await db.select().from(org.contacts).where(eq(org.contacts.id, id)).get();
  if (!c) throw notFound("Contact");
  return c;
}

export async function listContacts(
  db: Reader,
  f: { kind?: "customer" | "vendor"; q?: string; includeArchived?: boolean },
) {
  const conds: SQL[] = [];
  if (f.kind) conds.push(inArray(org.contacts.kind, [f.kind, "both"]));
  if (!f.includeArchived) conds.push(isNull(org.contacts.archivedAt));
  if (f.q) {
    const q = `%${f.q.replace(/[%_]/g, "")}%`;
    conds.push(or(like(org.contacts.name, q), like(org.contacts.email, q))!);
  }
  const rows = await db
    .select()
    .from(org.contacts)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(sql`lower(${org.contacts.name})`))
    .all();
  return rows.map(contactView);
}

function validate(input: Partial<ContactInput>) {
  if (input.tax_id_last4 && !/^\d{4}$/.test(input.tax_id_last4))
    throw unprocessable("Tax ID must be the last 4 digits only.", "invalid_tax_id");
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))
    throw unprocessable("That email address looks wrong.", "invalid_email");
}

export async function createContactTx(tx: OrgTx, orgId: string, a: ActorInfo, input: ContactInput) {
  validate(input);
  const id = newId();
  await tx.insert(org.contacts).values({
    id,
    kind: input.kind,
    name: input.name.trim(),
    email: input.email ?? null,
    phone: input.phone ?? null,
    addressJson: input.address ? JSON.stringify(input.address) : null,
    taxIdLast4: input.tax_id_last4 ?? null,
    is1099Vendor: input.is_1099_vendor ?? false,
    defaultAccountId: input.default_account_id ?? null,
    notes: input.notes ?? null,
  });
  const c = await mustGetContact(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "contact.create",
    targetType: "contact",
    targetId: id,
    after: contactView(c),
  });
  return c;
}

export async function updateContactTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  input: Partial<ContactInput> & { archived?: boolean },
) {
  validate(input);
  const before = await mustGetContact(tx, id);
  const patch: Partial<typeof org.contacts.$inferInsert> = {};
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.email !== undefined) patch.email = input.email;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.address !== undefined) patch.addressJson = input.address ? JSON.stringify(input.address) : null;
  if (input.tax_id_last4 !== undefined) patch.taxIdLast4 = input.tax_id_last4;
  if (input.is_1099_vendor !== undefined) patch.is1099Vendor = input.is_1099_vendor;
  if (input.default_account_id !== undefined) patch.defaultAccountId = input.default_account_id;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.archived !== undefined)
    patch.archivedAt = input.archived ? (before.archivedAt ?? new Date().toISOString()) : null;
  if (Object.keys(patch).length) await tx.update(org.contacts).set(patch).where(eq(org.contacts.id, id));
  const after = await mustGetContact(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "contact.update",
    targetType: "contact",
    targetId: id,
    before: contactView(before),
    after: contactView(after),
  });
  return after;
}
