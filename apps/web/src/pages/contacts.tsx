import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, unwrap } from "../api/client";
import { AccountSelect } from "../components/AccountSelect";
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Table,
  Textarea,
  td,
  th,
} from "../components/ui";
import { type Contact, useContacts } from "../lib/documents";
import { useAccounts } from "../lib/ledger";
import { useOrgId, useRole } from "../lib/org";

export function ContactsPage({ kind }: { kind: "customer" | "vendor" }) {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const list = useContacts(orgId, kind);
  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  const [q, setQ] = useState("");
  const title = kind === "customer" ? "Customers" : "Vendors";
  const rows = (list.data ?? []).filter(
    (c) => !q || `${c.name} ${c.email ?? ""}`.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        title={title}
        actions={canWrite && <Button onClick={() => setEditing("new")}>New {kind}</Button>}
      />
      <Input
        aria-label="Search"
        placeholder="Search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="mb-3 max-w-xs"
      />
      <ErrorText error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : (
        <Card>
          {rows.length === 0 ? (
            <p className="text-sm text-zinc-500">No {title.toLowerCase()} yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Name</th>
                  <th className={th}>Email</th>
                  <th className={`${th} hidden sm:table-cell`}>Phone</th>
                  {kind === "vendor" && <th className={th}>1099</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className={td}>
                      {canWrite ? (
                        <button type="button" className="hover:underline" onClick={() => setEditing(c)}>
                          {c.name}
                        </button>
                      ) : (
                        c.name
                      )}
                      {c.kind === "both" && <Badge>Customer & vendor</Badge>}
                    </td>
                    <td className={`${td} text-zinc-600 dark:text-zinc-400`}>{c.email}</td>
                    <td className={`${td} hidden text-zinc-600 sm:table-cell dark:text-zinc-400`}>
                      {c.phone}
                    </td>
                    {kind === "vendor" && (
                      <td className={td}>{c.is_1099_vendor && <Badge tone="blue">1099</Badge>}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
      {editing && (
        <ContactForm
          contact={editing === "new" ? null : editing}
          kind={kind}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

export function ContactForm({
  contact,
  kind,
  onClose,
  onSaved,
}: {
  contact: Contact | null;
  kind: "customer" | "vendor";
  onClose: () => void;
  onSaved?: (c: Contact) => void;
}) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const accounts = useAccounts(orgId);
  const [f, setF] = useState({
    kind: contact?.kind ?? kind,
    name: contact?.name ?? "",
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    line1: contact?.address?.line1 ?? "",
    line2: contact?.address?.line2 ?? "",
    city_line: contact?.address?.city_line ?? "",
    tax_id_last4: contact?.tax_id_last4 ?? "",
    is_1099_vendor: contact?.is_1099_vendor ?? false,
    default_account_id: contact?.default_account_id ?? "",
    notes: contact?.notes ?? "",
  });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const body = {
    kind: f.kind,
    name: f.name,
    email: f.email || null,
    phone: f.phone || null,
    address: f.line1 || f.city_line ? { line1: f.line1, line2: f.line2, city_line: f.city_line } : null,
    tax_id_last4: f.tax_id_last4 || null,
    is_1099_vendor: f.is_1099_vendor,
    default_account_id: f.default_account_id || null,
    notes: f.notes || null,
  };
  const save = useMutation({
    mutationFn: () =>
      contact
        ? unwrap(
            api.PATCH("/api/v1/orgs/{orgId}/contacts/{contactId}", {
              params: { path: { orgId, contactId: contact.id } },
              body,
            }),
          )
        : unwrap(api.POST("/api/v1/orgs/{orgId}/contacts", { params: { path: { orgId } }, body })),
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ["contacts", orgId] });
      onSaved?.(c);
      onClose();
    },
  });
  const archive = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/api/v1/orgs/{orgId}/contacts/{contactId}", {
          params: { path: { orgId, contactId: contact!.id } },
          body: { archived: true },
        }),
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["contacts", orgId] });
      onClose();
    },
  });
  const isVendor = f.kind !== "customer";
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={contact ? `Edit ${contact.name}` : `New ${kind}`}
      footer={
        <>
          {contact && (
            <Button
              variant="ghost"
              className="mr-auto"
              loading={archive.isPending}
              onClick={() => archive.mutate()}
            >
              Archive
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!f.name} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name">
          {(id) => (
            <Input
              id={id}
              value={f.name}
              onChange={(e) => set({ name: e.target.value })}
              required
              autoFocus
            />
          )}
        </Field>
        <Field label="Type">
          {(id) => (
            <select
              id={id}
              className="rounded-md bg-white px-3 py-2 text-sm ring-1 ring-zinc-300 dark:bg-zinc-900 dark:ring-zinc-700"
              value={f.kind}
              onChange={(e) => set({ kind: e.target.value as Contact["kind"] })}
            >
              <option value="customer">Customer</option>
              <option value="vendor">Vendor</option>
              <option value="both">Both</option>
            </select>
          )}
        </Field>
        <Field label="Email">
          {(id) => (
            <Input id={id} type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} />
          )}
        </Field>
        <Field label="Phone">
          {(id) => <Input id={id} value={f.phone} onChange={(e) => set({ phone: e.target.value })} />}
        </Field>
        <Field label="Street">
          {(id) => <Input id={id} value={f.line1} onChange={(e) => set({ line1: e.target.value })} />}
        </Field>
        <Field label="Street line 2">
          {(id) => <Input id={id} value={f.line2} onChange={(e) => set({ line2: e.target.value })} />}
        </Field>
        <Field label="City, state, postal code" className="sm:col-span-2">
          {(id) => <Input id={id} value={f.city_line} onChange={(e) => set({ city_line: e.target.value })} />}
        </Field>
        {isVendor && (
          <>
            <Field label="Tax ID (last 4 only)">
              {(id) => (
                <Input
                  id={id}
                  maxLength={4}
                  inputMode="numeric"
                  value={f.tax_id_last4}
                  onChange={(e) => set({ tax_id_last4: e.target.value })}
                />
              )}
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                checked={f.is_1099_vendor}
                onChange={(e) => set({ is_1099_vendor: e.target.checked })}
              />
              Needs a 1099 (contractor)
            </label>
          </>
        )}
        <Field
          label={isVendor && f.kind === "vendor" ? "Default expense account" : "Default account"}
          className="sm:col-span-2"
        >
          {(id) => (
            <AccountSelect
              id={id}
              accounts={accounts.data ?? []}
              types={
                f.kind === "customer" ? ["income"] : f.kind === "vendor" ? ["expense", "asset"] : undefined
              }
              value={f.default_account_id}
              onChange={(v) => set({ default_account_id: v })}
              placeholder="None"
            />
          )}
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          {(id) => (
            <Textarea id={id} rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
          )}
        </Field>
        <button type="submit" hidden />
      </form>
      <div className="mt-3">
        <ErrorText error={save.error ?? archive.error} />
      </div>
    </Modal>
  );
}
