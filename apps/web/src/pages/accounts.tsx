import { TAX_LINES } from "@cosimo/core/coa";
import { ACCOUNT_SUBTYPES } from "@cosimo/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { api, unwrap } from "../api/client";
import {
  Alert,
  Amount,
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  GroupToggle,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Table,
  Textarea,
  td,
  th,
} from "../components/ui";
import { type Account, displayBalance, TYPE_LABELS, TYPE_ORDER, useAccounts } from "../lib/ledger";
import { useOrgId, useRole } from "../lib/org";

const SUBTYPE_LABEL = (s: string) => s.replace(/_/g, " ");

function depthOf(a: Account, byId: Map<string, Account>) {
  let d = 0;
  let cur = a.parent_id ? byId.get(a.parent_id) : undefined;
  while (cur && d < 10) {
    d++;
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return d;
}

/** Depth-first order under each type so sub-accounts sit beneath their parent. */
function ordered(list: Account[]) {
  const ids = new Set(list.map((a) => a.id));
  const kids = new Map<string | null, Account[]>();
  for (const a of list) {
    const p = a.parent_id && ids.has(a.parent_id) ? a.parent_id : null;
    kids.set(p, [...(kids.get(p) ?? []), a]);
  }
  const out: Account[] = [];
  const walk = (p: string | null) => {
    for (const a of (kids.get(p) ?? []).sort((x, y) =>
      x.code.localeCompare(y.code, undefined, { numeric: true }),
    )) {
      out.push(a);
      walk(a.id);
    }
  };
  walk(null);
  return out;
}

/** The account plus every account beneath it. */
function subtreeIds(id: string, all: Account[]) {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of all)
      if (a.parent_id && out.has(a.parent_id) && !out.has(a.id)) {
        out.add(a.id);
        grew = true;
      }
  }
  return out;
}

type Row =
  | { kind: "account"; a: Account; depth: number; balance: number; parent: boolean }
  | { kind: "other"; a: Account; depth: number; balance: number };

/**
 * Table rows for one type: each parent shows its rolled-up balance (its own plus every
 * sub-account's), then its sub-accounts, then "<name> (Other)" for its own postings when nonzero.
 * Collapsed parents hide everything beneath them.
 */
function tableRows(list: Account[], all: Account[], byId: Map<string, Account>, collapsed: Set<string>) {
  const shown = new Set(list.map((a) => a.id));
  const hasKids = new Set(list.flatMap((a) => (a.parent_id && shown.has(a.parent_id) ? [a.parent_id] : [])));
  const rolled = (a: Account) =>
    [...subtreeIds(a.id, all)].reduce((sum, id) => sum + (byId.get(id)?.balance ?? 0), 0);
  const rows: Row[] = [];
  const open: { a: Account; depth: number }[] = [];
  let hideBelow: number | null = null;
  // Close the groups that end before an account at `depth`, adding their (Other) rows.
  const close = (depth: number) => {
    if (hideBelow !== null && depth <= hideBelow) hideBelow = null;
    while (open.length && open[open.length - 1]!.depth >= depth) {
      const p = open.pop()!;
      if (p.a.balance) rows.push({ kind: "other", a: p.a, depth: p.depth + 1, balance: p.a.balance });
    }
  };
  for (const a of ordered(list)) {
    const depth = depthOf(a, byId);
    close(depth);
    if (hideBelow !== null) continue;
    const parent = hasKids.has(a.id);
    rows.push({ kind: "account", a, depth, balance: parent ? rolled(a) : (a.balance ?? 0), parent });
    if (parent) {
      if (collapsed.has(a.id)) hideBelow = depth;
      else open.push({ a, depth });
    }
  }
  close(0);
  return rows;
}

/** Search hits plus their ancestors, so a match never appears indented with no parent above it. */
function withAncestors(hits: Account[], byId: Map<string, Account>) {
  const out = new Map(hits.map((a) => [a.id, a]));
  for (const a of hits) {
    let cur = a.parent_id ? byId.get(a.parent_id) : undefined;
    for (let i = 0; cur && !out.has(cur.id) && i < 10; i++) {
      out.set(cur.id, cur);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
  }
  return [...out.values()];
}

export function AccountsPage() {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const accounts = useAccounts(orgId, { balances: true });
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const byId = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (accounts.isLoading) return <Loading />;
  const all = accounts.data ?? [];
  const filtered = withAncestors(
    all.filter(
      (a) =>
        (showInactive || a.is_active) &&
        (!q || `${a.code} ${a.name}`.toLowerCase().includes(q.toLowerCase())),
    ),
    byId,
  );
  return (
    <>
      <PageHeader
        title="Chart of accounts"
        subtitle="Balances include posted entries only."
        actions={
          <>
            <Link
              to="/o/$orgId/accounting/opening-balances"
              params={{ orgId }}
              className="text-sm text-brand-700 hover:underline dark:text-gold-400"
            >
              Opening balances
            </Link>
            {canWrite && <Button onClick={() => setEditing("new")}>New account</Button>}
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input
          aria-label="Search accounts"
          placeholder="Search by code or name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>
      <ErrorText error={accounts.error} />
      <div className="space-y-4">
        {TYPE_ORDER.map((t) => {
          const rows = tableRows(
            filtered.filter((a) => a.type === t),
            all,
            byId,
            collapsed,
          );
          if (!rows.length) return null;
          return (
            <Card key={t} title={TYPE_LABELS[t]}>
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Code</th>
                    <th className={th}>Name</th>
                    <th className={`${th} hidden md:table-cell`}>Detail type</th>
                    <th className={`${th} hidden lg:table-cell`}>Tax line</th>
                    <th className={`${th} text-right`}>Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {rows.map((r) => {
                    const a = r.a;
                    const balance = (
                      <Link
                        to="/o/$orgId/accounting/entries"
                        params={{ orgId }}
                        search={{ account: a.id }}
                        className="hover:underline"
                        title="Show entries"
                      >
                        <Amount cents={displayBalance(a, r.balance)} />
                      </Link>
                    );
                    if (r.kind === "other")
                      return (
                        <tr key={`${a.id}-other`} className={a.is_active ? "" : "opacity-60"}>
                          <td className={`${td} num`} />
                          <td className={td}>
                            <span
                              style={{ paddingLeft: `${r.depth * 1.25}rem` }}
                              className="text-zinc-600 dark:text-zinc-400"
                            >
                              {a.name} (Other)
                            </span>
                          </td>
                          <td className={`${td} hidden md:table-cell`} />
                          <td className={`${td} hidden lg:table-cell`} />
                          <td className={`${td} text-right`}>{balance}</td>
                        </tr>
                      );
                    return (
                      <tr key={a.id} className={a.is_active ? "" : "opacity-60"}>
                        <td className={`${td} num`}>{a.code}</td>
                        <td className={td}>
                          <span
                            style={{ paddingLeft: `${r.depth * 1.25}rem` }}
                            className="inline-flex flex-wrap items-center gap-2"
                          >
                            <span className="inline-flex items-center">
                              {r.parent && (
                                <GroupToggle
                                  open={!collapsed.has(a.id)}
                                  label={a.name}
                                  onClick={() => toggle(a.id)}
                                />
                              )}
                              {canWrite ? (
                                <button
                                  type="button"
                                  className="text-left hover:underline"
                                  onClick={() => setEditing(a)}
                                >
                                  {a.name}
                                </button>
                              ) : (
                                a.name
                              )}
                            </span>
                            {a.is_system && <Badge>System</Badge>}
                            {!a.is_active && <Badge tone="amber">Inactive</Badge>}
                          </span>
                        </td>
                        <td className={`${td} hidden capitalize text-zinc-500 md:table-cell`}>
                          {SUBTYPE_LABEL(a.subtype)}
                        </td>
                        <td className={`${td} hidden text-zinc-500 lg:table-cell`}>{a.tax_line ?? ""}</td>
                        <td className={`${td} text-right ${r.parent ? "font-semibold" : ""}`}>{balance}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </Card>
          );
        })}
      </div>
      {editing && (
        <AccountForm
          account={editing === "new" ? null : editing}
          accounts={all}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function AccountForm({
  account,
  accounts,
  onClose,
}: {
  account: Account | null;
  accounts: Account[];
  onClose: () => void;
}) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const byId = new Map(accounts.map((a) => [a.id, a]));
  // A sub-account's type, detail type, and tax line always come from its parent.
  const inherited = (p: Account | undefined) =>
    p ? { type: p.type, subtype: p.subtype, tax_line: p.tax_line ?? "" } : {};
  const [f, setF] = useState({
    code: account?.code ?? "",
    name: account?.name ?? "",
    type: account?.type ?? ("expense" as Account["type"]),
    subtype: account?.subtype ?? "other",
    parent_id: account?.parent_id ?? "",
    tax_line: account?.tax_line ?? "",
    description: account?.description ?? "",
    is_active: account?.is_active ?? true,
    ...inherited(account?.parent_id ? byId.get(account.parent_id) : undefined),
  });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const hasParent = Boolean(f.parent_id);
  const body = {
    code: f.code,
    name: f.name,
    type: f.type,
    subtype: f.subtype as (typeof ACCOUNT_SUBTYPES)[number],
    parent_id: f.parent_id || null,
    tax_line: f.tax_line || null,
    description: f.description || null,
    is_active: f.is_active,
  };
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ["accounts", orgId] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () =>
      account
        ? unwrap(
            api.PATCH("/api/v1/orgs/{orgId}/accounts/{accountId}", {
              params: { path: { orgId, accountId: account.id } },
              body,
            }),
          )
        : unwrap(api.POST("/api/v1/orgs/{orgId}/accounts", { params: { path: { orgId } }, body })),
    onSuccess: done,
  });
  const del = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/orgs/{orgId}/accounts/{accountId}", {
          params: { path: { orgId, accountId: account!.id } },
        }),
      ),
    onSuccess: done,
  });
  // Any active, non-system account can be a parent, except this account and its sub-accounts.
  const own = account ? subtreeIds(account.id, accounts) : new Set<string>();
  const parents = accounts.filter(
    (a) => (a.is_active && !a.is_system && !own.has(a.id)) || a.id === account?.parent_id,
  );
  const taxPrefix = Object.keys(TAX_LINES);
  return (
    <Modal
      open
      onClose={onClose}
      title={account ? `Edit ${account.code} ${account.name}` : "New account"}
      footer={
        <>
          {account && !account.is_system && (
            <Button
              variant="ghost"
              className="mr-auto text-red-700"
              loading={del.isPending}
              onClick={() => del.mutate()}
            >
              Delete
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()} disabled={!f.code || !f.name}>
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
        <Field label="Code">
          {(id) => <Input id={id} value={f.code} onChange={(e) => set({ code: e.target.value })} required />}
        </Field>
        <Field label="Name">
          {(id) => <Input id={id} value={f.name} onChange={(e) => set({ name: e.target.value })} required />}
        </Field>
        <Field
          label="Type"
          hint={
            account?.is_system
              ? "System accounts keep their type."
              : hasParent
                ? "Set by the parent account."
                : "Cannot change once the account has posted entries."
          }
        >
          {(id) => (
            <Select
              id={id}
              value={f.type}
              disabled={account?.is_system || hasParent}
              onChange={(e) => set({ type: e.target.value as Account["type"] })}
            >
              {TYPE_ORDER.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Detail type" hint={hasParent ? "Set by the parent account." : undefined}>
          {(id) => (
            <Select
              id={id}
              value={f.subtype}
              disabled={hasParent}
              onChange={(e) => set({ subtype: e.target.value })}
            >
              {ACCOUNT_SUBTYPES.map((s) => (
                <option key={s} value={s} className="capitalize">
                  {SUBTYPE_LABEL(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {!account?.is_system && (
          <Field
            label="Parent account"
            hint="Sub-accounts roll up into the parent in reports and share its type, detail type, and tax line. You can still post to the parent."
          >
            {(id) => (
              <Select
                id={id}
                value={f.parent_id}
                onChange={(e) => set({ parent_id: e.target.value, ...inherited(byId.get(e.target.value)) })}
              >
                <option value="">None</option>
                {TYPE_ORDER.map((t) => {
                  const list = ordered(parents.filter((a) => a.type === t));
                  if (!list.length) return null;
                  return (
                    <optgroup key={t} label={TYPE_LABELS[t]}>
                      {list.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </Select>
            )}
          </Field>
        )}
        <Field label="Tax line" hint={hasParent ? "Set by the parent account." : undefined}>
          {(id) => (
            <Select
              id={id}
              value={f.tax_line}
              disabled={hasParent}
              onChange={(e) => set({ tax_line: e.target.value })}
            >
              <option value="">Not mapped</option>
              {taxPrefix.map((k) => (
                <option key={k} value={k}>
                  {TAX_LINES[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Description" className="sm:col-span-2">
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              value={f.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          )}
        </Field>
        {!account?.is_system && (
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={f.is_active}
              onChange={(e) => set({ is_active: e.target.checked })}
            />
            Active (inactive accounts are hidden from pickers; they must have a zero balance)
          </label>
        )}
        <button type="submit" hidden />
      </form>
      <div className="mt-3 space-y-2">
        <ErrorText error={save.error ?? del.error} />
        {account && account.balance !== undefined && account.balance !== 0 && !f.is_active && (
          <Alert kind="warn">
            This account has a balance. Move it to another account before deactivating.
          </Alert>
        )}
      </div>
    </Modal>
  );
}
