import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { api, download, unwrap } from "../api/client";
import { AccountSelect } from "../components/AccountSelect";
import { RecurringList } from "../components/recurring";
import { SearchSelect } from "../components/SearchSelect";
import {
  Alert,
  Amount,
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
  Tabs,
  Textarea,
  td,
  th,
} from "../components/ui";
import { type Contact, INVOICE_STATUS, type Invoice, parseQty, qtyText, useContacts } from "../lib/documents";
import { centsToDecimal, fmtDate, fmtDateTime, money, todayIso, tryParseCents } from "../lib/format";
import { useAccounts } from "../lib/ledger";
import { useOrg, useOrgId, useRole } from "../lib/org";

// ----------------------------------------------------------------------------- list

type Filter = "all" | "draft" | "open" | "overdue" | "paid";

export function InvoicesPage() {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onRecurring = pathname.endsWith("/recurring");
  const [filter, setFilter] = useState<Filter>("all");
  const query =
    filter === "draft"
      ? { status: "draft" }
      : filter === "open"
        ? { status: "sent,partial" }
        : filter === "paid"
          ? { status: "paid" }
          : filter === "overdue"
            ? { overdue: "true" as const }
            : {};
  const list = useQuery({
    queryKey: ["invoices", orgId, filter],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/invoices", { params: { path: { orgId }, query } })).then(
        (r) => r.data,
      ),
    enabled: !onRecurring,
  });
  const totals = useMemo(() => {
    const open = (list.data ?? []).filter((i) => i.status === "sent" || i.status === "partial");
    return {
      open: open.reduce((s, i) => s + i.balance_due, 0),
      overdue: open.filter((i) => i.overdue).reduce((s, i) => s + i.balance_due, 0),
    };
  }, [list.data]);
  return (
    <>
      <PageHeader
        title="Invoices"
        actions={
          canWrite &&
          (onRecurring ? (
            <Link to="/o/$orgId/sales/invoices/recurring/new" params={{ orgId }}>
              <Button>New recurring invoice</Button>
            </Link>
          ) : (
            <Link to="/o/$orgId/sales/invoices/new" params={{ orgId }}>
              <Button>New invoice</Button>
            </Link>
          ))
        }
      />
      <Tabs
        value={onRecurring ? "recurring" : filter}
        onChange={(v) => {
          if (v === "recurring") navigate({ to: "/o/$orgId/sales/invoices/recurring", params: { orgId } });
          else {
            setFilter(v);
            if (onRecurring) navigate({ to: "/o/$orgId/sales/invoices", params: { orgId } });
          }
        }}
        tabs={[
          { value: "all", label: "All" },
          { value: "draft", label: "Drafts" },
          { value: "open", label: "Open" },
          { value: "overdue", label: "Overdue" },
          { value: "paid", label: "Paid" },
          { value: "recurring", label: "Recurring" },
        ]}
      />
      {onRecurring ? (
        <RecurringList kind="invoice" />
      ) : (
        <>
          {filter === "all" && list.data && (
            <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
              Outstanding {money(totals.open)} · overdue{" "}
              <span className={totals.overdue ? "text-red-700 dark:text-red-400" : ""}>
                {money(totals.overdue)}
              </span>
            </p>
          )}
          <ErrorText error={list.error} />
          <Card>
            {list.isLoading ? (
              <Loading />
            ) : !list.data?.length ? (
              <p className="text-sm text-zinc-500">No invoices here.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Number</th>
                    <th className={th}>Customer</th>
                    <th className={`${th} hidden sm:table-cell`}>Date</th>
                    <th className={th}>Due</th>
                    <th className={th}>Status</th>
                    <th className={`${th} text-right`}>Total</th>
                    <th className={`${th} text-right`}>Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {list.data.map((i) => (
                    <tr key={i.id}>
                      <td className={td}>
                        <Link
                          to="/o/$orgId/sales/invoices/$invoiceId"
                          params={{ orgId, invoiceId: i.id }}
                          className="font-medium hover:underline"
                        >
                          {i.number}
                        </Link>
                      </td>
                      <td className={td}>{i.customer_name}</td>
                      <td className={`${td} hidden whitespace-nowrap sm:table-cell`}>
                        {fmtDate(i.issue_date)}
                      </td>
                      <td
                        className={`${td} whitespace-nowrap ${i.overdue ? "text-red-700 dark:text-red-400" : ""}`}
                      >
                        {fmtDate(i.due_date)}
                      </td>
                      <td className={td}>
                        <DocStatus
                          status={INVOICE_STATUS[i.status]}
                          pending={i.entry_status === "pending_review"}
                          overdue={i.overdue}
                        />
                      </td>
                      <td className={`${td} text-right`}>
                        <Amount cents={i.total} />
                      </td>
                      <td className={`${td} text-right`}>
                        <Amount cents={i.balance_due} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}
    </>
  );
}

export function DocStatus({
  status,
  pending,
  overdue,
}: {
  status: { label: string; tone: "zinc" | "blue" | "amber" | "green" | "red" };
  pending?: boolean;
  overdue?: boolean;
}) {
  if (pending) return <Badge tone="amber">Awaiting review</Badge>;
  return (
    <span className="inline-flex gap-1">
      <Badge tone={status.tone}>{status.label}</Badge>
      {overdue && <Badge tone="red">Overdue</Badge>}
    </span>
  );
}

// ----------------------------------------------------------------------------- line editor (shared with bills)

export interface EditLine {
  key: number;
  description: string;
  qty: string;
  price: string;
  account_id: string;
}
let lk = 0;
export const blankLine = (account_id = ""): EditLine => ({
  key: ++lk,
  description: "",
  qty: "1",
  price: "",
  account_id,
});

export function lineCents(l: EditLine, withQty: boolean): number | null {
  const price = tryParseCents(l.price || "0");
  if (price === null) return null;
  if (!withQty) return price;
  const q = parseQty(l.qty || "1");
  if (q === null) return null;
  const p = q * price;
  return (p < 0 ? -1 : 1) * Math.floor((Math.abs(p) + 500) / 1000);
}

export function LinesEditor({
  lines,
  setLines,
  withQty,
  accountTypes,
  defaultAccount,
}: {
  lines: EditLine[];
  setLines: (f: (ls: EditLine[]) => EditLine[]) => void;
  withQty: boolean;
  accountTypes: ("income" | "expense" | "asset" | "liability")[];
  defaultAccount: string;
}) {
  const orgId = useOrgId();
  const accounts = useAccounts(orgId);
  const upd = (key: number, p: Partial<EditLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const total = lines.reduce((s, l) => s + (lineCents(l, withQty) ?? 0), 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr>
            <th className={`${th} w-[34%]`}>Description</th>
            <th className={th}>Account</th>
            {withQty && <th className={`${th} w-20 text-right`}>Qty</th>}
            <th className={`${th} w-32 text-right`}>{withQty ? "Rate" : "Amount"}</th>
            {withQty && <th className={`${th} w-28 text-right`}>Amount</th>}
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const amt = lineCents(l, withQty);
            return (
              <tr key={l.key}>
                <td className="py-1 pr-1">
                  <Input
                    aria-label={`Line ${i + 1} description`}
                    value={l.description}
                    onChange={(e) => upd(l.key, { description: e.target.value })}
                  />
                </td>
                <td className="px-1 py-1">
                  <AccountSelect
                    aria-label={`Line ${i + 1} account`}
                    accounts={accounts.data ?? []}
                    types={accountTypes}
                    value={l.account_id || defaultAccount}
                    onChange={(v) => upd(l.key, { account_id: v })}
                  />
                </td>
                {withQty && (
                  <td className="px-1 py-1">
                    <Input
                      aria-label={`Line ${i + 1} quantity`}
                      inputMode="decimal"
                      className="text-right num"
                      value={l.qty}
                      onChange={(e) => upd(l.key, { qty: e.target.value })}
                    />
                  </td>
                )}
                <td className="px-1 py-1">
                  <Input
                    aria-label={`Line ${i + 1} ${withQty ? "rate" : "amount"}`}
                    inputMode="decimal"
                    className="text-right num"
                    value={l.price}
                    onChange={(e) => upd(l.key, { price: e.target.value })}
                  />
                </td>
                {withQty && <td className="px-3 py-1 text-right num">{amt === null ? "—" : money(amt)}</td>}
                <td className="text-center">
                  {lines.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove line ${i + 1}`}
                      className="p-1 text-zinc-400 hover:text-red-600"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={withQty ? 2 : 1} className="py-2">
              <Button size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, blankLine()])}>
                + Add line
              </Button>
            </td>
            <td colSpan={withQty ? 2 : 1} className="px-3 py-2 text-right font-semibold">
              Total
            </td>
            <td className="px-3 py-2 text-right font-semibold num">{money(total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * Customer or vendor picker. Typing a name that isn't there offers "+ New customer "…"", which creates
 * the contact with just that name and selects it; details are edited later under Customers or Vendors.
 */
export function ContactPicker({
  kind,
  value,
  onChange,
}: {
  kind: "customer" | "vendor";
  value: string;
  onChange: (id: string) => void;
}) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const contacts = useContacts(orgId, kind);
  const create = useMutation({
    mutationFn: (name: string) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/contacts", { params: { path: { orgId } }, body: { kind, name } }),
      ),
    onSuccess: async (c) => {
      // Add it to the list first so the picker can show its name the moment it's selected.
      qc.setQueryData(["contacts", orgId, kind], (old: Contact[] | undefined) => [...(old ?? []), c]);
      onChange(c.id);
      await qc.invalidateQueries({ queryKey: ["contacts", orgId] });
    },
  });
  return (
    <div>
      <SearchSelect
        aria-label={kind === "customer" ? "Customer" : "Vendor"}
        value={value}
        onChange={onChange}
        emptyLabel={`Choose a ${kind}…`}
        onCreate={(name) => create.mutate(name)}
        createLabel={(name) => `New ${kind} "${name}"`}
        options={(contacts.data ?? []).map((c: Contact) => ({
          value: c.id,
          label: c.name,
          keywords: [c.email, c.phone].filter(Boolean).join(" "),
        }))}
      />
      <ErrorText error={create.error} />
    </div>
  );
}

// ----------------------------------------------------------------------------- invoice editor

function InvoiceEditor({ invoice, onDone }: { invoice: Invoice | null; onDone: (id: string) => void }) {
  const orgId = useOrgId();
  const org = useOrg();
  const qc = useQueryClient();
  const contacts = useContacts(orgId, "customer");
  const [customer, setCustomer] = useState(invoice?.customer_id ?? "");
  const [number, setNumber] = useState(invoice?.number ?? "");
  const [issue, setIssue] = useState(invoice?.issue_date ?? todayIso());
  const [terms, setTerms] = useState(invoice?.terms ?? "");
  const [due, setDue] = useState(invoice?.due_date ?? "");
  const [memo, setMemo] = useState(invoice?.memo ?? "");
  const [lines, setLines] = useState<EditLine[]>(
    invoice?.lines.map((l) => ({
      key: ++lk,
      description: l.description,
      qty: qtyText(l.quantity_milli),
      price: centsToDecimal(l.unit_price),
      account_id: l.account_id,
    })) ?? [blankLine()],
  );
  useEffect(() => {
    if (!invoice && org.data && !terms) setTerms(org.data.settings.default_terms);
  }, [org.data, invoice, terms]);
  const accounts = useAccounts(orgId);
  const cust = contacts.data?.find((c) => c.id === customer);
  const defaultIncome =
    cust?.default_account_id ??
    accounts.data?.find((a) => a.type === "income" && a.is_active && !a.is_system)?.id ??
    "";
  const invalid = lines.some((l) => lineCents(l, true) === null);
  const body = () => ({
    customer_id: customer,
    number: number || null,
    issue_date: issue,
    due_date: due || null,
    terms: terms || null,
    memo: memo || null,
    lines: lines
      .filter((l) => l.description || l.price)
      .map((l) => ({
        description: l.description || "Item",
        quantity_milli: parseQty(l.qty || "1") ?? 1000,
        unit_price: tryParseCents(l.price || "0") ?? 0,
        account_id: l.account_id || defaultIncome,
      })),
  });
  const save = useMutation({
    mutationFn: () =>
      invoice
        ? unwrap(
            api.PATCH("/api/v1/orgs/{orgId}/invoices/{invoiceId}", {
              params: { path: { orgId, invoiceId: invoice.id } },
              body: body(),
            }),
          )
        : unwrap(api.POST("/api/v1/orgs/{orgId}/invoices", { params: { path: { orgId } }, body: body() })),
    onSuccess: async (inv) => {
      await qc.invalidateQueries({ queryKey: ["invoices", orgId] });
      await qc.invalidateQueries({ queryKey: ["invoice", orgId] });
      onDone(inv.id);
    },
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Customer" className="sm:col-span-2">
          {() => <ContactPicker kind="customer" value={customer} onChange={setCustomer} />}
        </Field>
        <Field label="Invoice number" hint={invoice ? undefined : "Leave empty for the next number."}>
          {(id) => <Input id={id} value={number} onChange={(e) => setNumber(e.target.value)} />}
        </Field>
        <Field label="Date">
          {(id) => <Input id={id} type="date" value={issue} onChange={(e) => setIssue(e.target.value)} />}
        </Field>
        <Field label="Terms">
          {(id) => (
            <Input id={id} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Net 30" />
          )}
        </Field>
        <Field label="Due date" hint="Empty: from the terms.">
          {(id) => <Input id={id} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}
        </Field>
      </div>
      <LinesEditor
        lines={lines}
        setLines={setLines}
        withQty
        accountTypes={["income", "liability"]}
        defaultAccount={defaultIncome}
      />
      <Field label="Notes to the customer">
        {(id) => <Textarea id={id} rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />}
      </Field>
      {invalid && <Alert kind="error">Check the quantities and rates.</Alert>}
      <ErrorText error={save.error} />
      <Button type="submit" loading={save.isPending} disabled={!customer || invalid}>
        Save draft
      </Button>
    </form>
  );
}

export function NewInvoicePage() {
  const orgId = useOrgId();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="New invoice" />
      <Card>
        <InvoiceEditor
          invoice={null}
          onDone={(id) =>
            navigate({ to: "/o/$orgId/sales/invoices/$invoiceId", params: { orgId, invoiceId: id } })
          }
        />
      </Card>
    </>
  );
}

// ----------------------------------------------------------------------------- detail

export function InvoicePage() {
  const orgId = useOrgId();
  const { invoiceId } = useParams({ strict: false }) as { invoiceId: string };
  const { canWrite } = useRole();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["invoice", orgId, invoiceId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/invoices/{invoiceId}", { params: { path: { orgId, invoiceId } } }),
      ),
  });
  const payments = useQuery({
    queryKey: ["payments", orgId, "invoice", invoiceId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/payments", {
          params: { path: { orgId }, query: { contact_id: q.data!.customer_id, direction: "received" } },
        }),
      ).then((r) => r.data.filter((p) => p.applications.some((a) => a.document_id === invoiceId))),
    enabled: Boolean(q.data),
  });
  const refresh = async () => {
    await Promise.all(
      ["invoice", "invoices", "payments", "entries", "accounts", "review"].map((k) =>
        qc.invalidateQueries({ queryKey: [k, orgId] }),
      ),
    );
  };
  const act = useMutation({
    mutationFn: async (a: "finalize" | "void" | "delete") => {
      const params = { path: { orgId, invoiceId } };
      if (a === "delete") return unwrap(api.DELETE("/api/v1/orgs/{orgId}/invoices/{invoiceId}", { params }));
      if (a === "void")
        return unwrap(api.POST("/api/v1/orgs/{orgId}/invoices/{invoiceId}/void", { params, body: {} }));
      const r = await unwrap(
        api.POST("/api/v1/orgs/{orgId}/invoices/{invoiceId}/finalize", { params, body: {} }),
      );
      if (r.review) setMsg(`Waiting in the review queue: ${r.review.reason}`);
      return r;
    },
    onSuccess: async (_d, a) => {
      if (a === "delete") return navigate({ to: "/o/$orgId/sales/invoices", params: { orgId } });
      await refresh();
    },
  });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorText error={q.error} />;
  const inv = q.data;
  const pending = inv.entry_status === "pending_review";
  if (editing) {
    return (
      <>
        <PageHeader title={`Edit ${inv.number}`} />
        <Card>
          <InvoiceEditor
            invoice={inv}
            onDone={async () => {
              setEditing(false);
              await refresh();
            }}
          />
          <Button variant="ghost" className="mt-2" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </Card>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={`Invoice ${inv.number}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <DocStatus status={INVOICE_STATUS[inv.status]} pending={pending} overdue={inv.overdue} />
            {inv.customer_name} · {fmtDate(inv.issue_date)} · due {fmtDate(inv.due_date)}
          </span>
        }
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => download(`/api/v1/orgs/${orgId}/invoices/${inv.id}/pdf`, `${inv.number}.pdf`)}
            >
              PDF
            </Button>
            {canWrite && inv.status === "draft" && !pending && (
              <>
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button
                  variant="secondary"
                  loading={act.isPending && act.variables === "finalize"}
                  onClick={() => act.mutate("finalize")}
                >
                  Mark as sent
                </Button>
              </>
            )}
            {canWrite && inv.status !== "void" && !pending && (
              <Button onClick={() => setSending(true)}>{inv.sent_at ? "Resend" : "Send"}</Button>
            )}
            {canWrite && (inv.status === "sent" || inv.status === "partial") && (
              <Button onClick={() => setPaying(true)}>Record payment</Button>
            )}
            {canWrite && (
              <Link to="/o/$orgId/sales/invoices/recurring/new" params={{ orgId }} search={{ from: inv.id }}>
                <Button variant="secondary">Make recurring</Button>
              </Link>
            )}
          </>
        }
      />
      <div className="space-y-4">
        {msg && <Alert kind="warn">{msg}</Alert>}
        {pending && (
          <Alert kind="warn">
            This invoice is waiting in the{" "}
            <Link to="/o/$orgId/accounting/review" params={{ orgId }} className="underline">
              review queue
            </Link>
            . It posts (and can be sent) once approved.
          </Alert>
        )}
        <ErrorText error={act.error} />
        <Card>
          <Table>
            <thead>
              <tr>
                <th className={th}>Description</th>
                <th className={`${th} text-right`}>Qty</th>
                <th className={`${th} text-right`}>Rate</th>
                <th className={`${th} text-right`}>Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {inv.lines.map((l) => (
                <tr key={l.id}>
                  <td className={td}>{l.description}</td>
                  <td className={`${td} text-right num`}>{qtyText(l.quantity_milli)}</td>
                  <td className={`${td} text-right num`}>{money(l.unit_price)}</td>
                  <td className={`${td} text-right num`}>{money(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <dl className="ml-auto mt-4 grid max-w-xs grid-cols-2 gap-1 text-sm">
            <dt>Total</dt>
            <dd className="text-right num">{money(inv.total)}</dd>
            <dt>Paid</dt>
            <dd className="text-right num">{money(inv.amount_paid)}</dd>
            <dt className="font-semibold">Balance due</dt>
            <dd className="text-right font-semibold num">{money(inv.balance_due)}</dd>
          </dl>
          {inv.memo && <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">{inv.memo}</p>}
        </Card>
        {(payments.data?.length ?? 0) > 0 && (
          <Card title="Payments">
            <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
              {payments.data!.map((p) => (
                <li key={p.id} className="flex justify-between py-1.5">
                  <span>
                    {fmtDate(p.date)} {p.method && `· ${p.method}`}{" "}
                    {p.voided_at && <Badge tone="red">Void</Badge>}
                  </span>
                  <span className="num">
                    {money(p.applications.find((a) => a.document_id === inv.id)?.amount ?? 0)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        <Card title="Details">
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase text-zinc-500">Sent</dt>
              <dd>{inv.sent_at ? fmtDateTime(inv.sent_at) : "Not emailed"}</dd>
            </div>
            {inv.entry_id && (
              <div>
                <dt className="text-xs uppercase text-zinc-500">Journal entry</dt>
                <dd>
                  <Link
                    to="/o/$orgId/accounting/entries/$entryId"
                    params={{ orgId, entryId: inv.entry_id }}
                    className="underline"
                  >
                    View entry
                  </Link>
                </dd>
              </div>
            )}
            {inv.recurring_id && (
              <div>
                <dt className="text-xs uppercase text-zinc-500">Recurring</dt>
                <dd>
                  <Link
                    to="/o/$orgId/sales/invoices/recurring/$templateId"
                    params={{ orgId, templateId: inv.recurring_id }}
                    className="underline"
                  >
                    From recurring template ›
                  </Link>
                </dd>
              </div>
            )}
          </dl>
          {canWrite && inv.status !== "void" && (
            <div className="mt-4 flex gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              {inv.status === "draft" && !pending ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-700"
                  loading={act.isPending && act.variables === "delete"}
                  onClick={() => act.mutate("delete")}
                >
                  Delete draft
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-700"
                  loading={act.isPending && act.variables === "void"}
                  onClick={() => act.mutate("void")}
                >
                  Void invoice
                </Button>
              )}
            </div>
          )}
        </Card>
      </div>
      {paying && (
        <PaymentModal
          direction="received"
          contactId={inv.customer_id}
          preselect={{ [inv.id]: inv.balance_due }}
          onClose={() => setPaying(false)}
          onDone={async () => {
            setPaying(false);
            await refresh();
          }}
        />
      )}
      {sending && (
        <SendModal
          invoice={inv}
          onClose={() => setSending(false)}
          onDone={async (m) => {
            setSending(false);
            setMsg(m);
            await refresh();
          }}
        />
      )}
    </>
  );
}

function SendModal({
  invoice,
  onClose,
  onDone,
}: {
  invoice: Invoice;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const orgId = useOrgId();
  const [to, setTo] = useState(invoice.customer_email ?? "");
  const [message, setMessage] = useState("");
  const send = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/invoices/{invoiceId}/send", {
          params: { path: { orgId, invoiceId: invoice.id } },
          body: { to: to || null, message: message || null },
        }),
      ),
    onSuccess: (r) =>
      onDone(
        r.emailed_to
          ? `Emailed to ${r.emailed_to}.`
          : r.review
            ? `Waiting in the review queue: ${r.review.reason}`
            : "Saved.",
      ),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Send ${invoice.number}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={send.isPending} disabled={!to} onClick={() => send.mutate()}>
            Send
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {invoice.status === "draft" && (
          <p className="text-sm">Sending posts the invoice to your books first.</p>
        )}
        <Field label="To">
          {(id) => <Input id={id} type="email" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
        <Field
          label="Message (optional)"
          hint="A standard note with the amount and due date is used if empty."
        >
          {(id) => <Textarea id={id} rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />}
        </Field>
        <ErrorText error={send.error} />
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------------------- payments (shared with bills)

export function PaymentModal({
  direction,
  contactId,
  preselect,
  onClose,
  onDone,
}: {
  direction: "received" | "sent";
  contactId: string;
  preselect: Record<string, number>;
  onClose: () => void;
  onDone: () => void;
}) {
  const orgId = useOrgId();
  const accounts = useAccounts(orgId);
  const kind = direction === "received" ? "invoice" : "bill";
  const open = useQuery({
    queryKey: ["open-docs", orgId, kind, contactId],
    queryFn: async () =>
      kind === "invoice"
        ? (
            await unwrap(
              api.GET("/api/v1/orgs/{orgId}/invoices", {
                params: { path: { orgId }, query: { open: "true", customer_id: contactId } },
              }),
            )
          ).data.map((d) => ({
            id: d.id,
            label: d.number,
            due: d.due_date,
            balance: d.balance_due,
          }))
        : (
            await unwrap(
              api.GET("/api/v1/orgs/{orgId}/bills", {
                params: { path: { orgId }, query: { open: "true", vendor_id: contactId } },
              }),
            )
          ).data.map((d) => ({
            id: d.id,
            label: d.bill_number || fmtDate(d.issue_date),
            due: d.due_date,
            balance: d.balance_due,
          })),
  });
  const [date, setDate] = useState(todayIso());
  const [account, setAccount] = useState("");
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [apply, setApply] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(preselect).map(([k, v]) => [k, centsToDecimal(v)])),
  );
  const applied = Object.values(apply).reduce((s, v) => s + (tryParseCents(v || "0") ?? 0), 0);
  const [amount, setAmount] = useState("");
  const amt = amount ? tryParseCents(amount) : applied;
  const bank = account || accounts.data?.find((a) => a.subtype === "bank" && a.is_active)?.id || "";
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/payments", {
          params: { path: { orgId } },
          body: {
            direction,
            contact_id: contactId,
            date,
            amount: amt ?? 0,
            account_id: bank,
            method: method || null,
            reference: reference || null,
            applications: Object.entries(apply)
              .map(([document_id, v]) => ({ document_id, amount: tryParseCents(v || "0") ?? 0 }))
              .filter((x) => x.amount > 0),
          },
        }),
      ),
    onSuccess: onDone,
  });
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={direction === "received" ? "Record payment received" : "Pay bills"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={!amt || amt <= 0 || applied > (amt ?? 0) || !bank}
            onClick={() => save.mutate()}
          >
            Save payment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date">
            {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
          <Field label="Amount" hint={amount ? undefined : "Defaults to the total applied."}>
            {(id) => (
              <Input
                id={id}
                inputMode="decimal"
                className="num"
                placeholder={centsToDecimal(applied)}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Field label={direction === "received" ? "Deposit to" : "Paid from"}>
            {(id) => (
              <AccountSelect
                id={id}
                accounts={(accounts.data ?? []).filter(
                  (a) => a.type === "asset" || (direction === "sent" && a.subtype === "credit_card"),
                )}
                value={bank}
                onChange={setAccount}
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Method">
              {(id) => (
                <Input
                  id={id}
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  placeholder="ACH, check…"
                />
              )}
            </Field>
            <Field label="Reference">
              {(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} />}
            </Field>
          </div>
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold">Apply to</h3>
          {open.isLoading ? (
            <Loading />
          ) : !open.data?.length ? (
            <p className="text-sm text-zinc-500">
              No open {kind}s. The whole payment will be kept as a credit.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
              {open.data.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span>
                    {d.label}{" "}
                    <span className="text-zinc-500">
                      · due {fmtDate(d.due)} · open {money(d.balance)}
                    </span>
                  </span>
                  <Input
                    aria-label={`Apply to ${d.label}`}
                    inputMode="decimal"
                    className="w-32 text-right num"
                    value={apply[d.id] ?? ""}
                    onChange={(e) => setApply({ ...apply, [d.id]: e.target.value })}
                    onFocus={() => !apply[d.id] && setApply({ ...apply, [d.id]: centsToDecimal(d.balance) })}
                  />
                </li>
              ))}
            </ul>
          )}
          {amt != null && amt > applied && (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              {money(amt - applied)} will be kept as a credit.
            </p>
          )}
          {amt != null && applied > amt && (
            <Alert kind="error">You applied more than the payment amount.</Alert>
          )}
        </div>
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}
