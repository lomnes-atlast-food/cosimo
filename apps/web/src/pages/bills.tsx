import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { api, rawFetch, unwrap } from "../api/client";
import { RecurringList } from "../components/recurring";
import {
  Alert,
  Amount,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  Loading,
  PageHeader,
  Table,
  Tabs,
  Textarea,
  td,
  th,
} from "../components/ui";
import { BILL_STATUS, type Bill, useContacts } from "../lib/documents";
import { centsToDecimal, fmtDate, money, todayIso, tryParseCents } from "../lib/format";
import { useAccounts } from "../lib/ledger";
import { useOrgId, useRole } from "../lib/org";
import { blankLine, ContactPicker, DocStatus, type EditLine, LinesEditor, PaymentModal } from "./invoices";

type Filter = "all" | "open" | "paid" | "draft";

export function BillsPage() {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onRecurring = pathname.endsWith("/recurring");
  const [filter, setFilter] = useState<Filter>("open");
  const query =
    filter === "open"
      ? { status: "open,partial" }
      : filter === "paid"
        ? { status: "paid" }
        : filter === "draft"
          ? { status: "draft" }
          : {};
  const list = useQuery({
    queryKey: ["bills", orgId, filter],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/bills", { params: { path: { orgId }, query } })).then(
        (r) => r.data,
      ),
    enabled: !onRecurring,
  });
  return (
    <>
      <PageHeader
        title="Bills"
        actions={
          canWrite &&
          (onRecurring ? (
            <Link to="/o/$orgId/expenses/bills/recurring/new" params={{ orgId }}>
              <Button>New recurring bill</Button>
            </Link>
          ) : (
            <Link to="/o/$orgId/expenses/bills/new" params={{ orgId }}>
              <Button>Enter bill</Button>
            </Link>
          ))
        }
      />
      <Tabs
        value={onRecurring ? "recurring" : filter}
        onChange={(v) => {
          if (v === "recurring") navigate({ to: "/o/$orgId/expenses/bills/recurring", params: { orgId } });
          else {
            setFilter(v);
            if (onRecurring) navigate({ to: "/o/$orgId/expenses/bills", params: { orgId } });
          }
        }}
        tabs={[
          { value: "open", label: "To pay" },
          { value: "draft", label: "Drafts" },
          { value: "paid", label: "Paid" },
          { value: "all", label: "All" },
          { value: "recurring", label: "Recurring" },
        ]}
      />
      {onRecurring ? (
        <RecurringList kind="bill" />
      ) : (
        <>
          <ErrorText error={list.error} />
          <Card>
            {list.isLoading ? (
              <Loading />
            ) : !list.data?.length ? (
              <p className="text-sm text-zinc-500">No bills here.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Vendor</th>
                    <th className={th}>Bill #</th>
                    <th className={`${th} hidden sm:table-cell`}>Date</th>
                    <th className={th}>Due</th>
                    <th className={th}>Status</th>
                    <th className={`${th} text-right`}>Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {list.data.map((b) => (
                    <tr key={b.id}>
                      <td className={td}>
                        <Link
                          to="/o/$orgId/expenses/bills/$billId"
                          params={{ orgId, billId: b.id }}
                          className="font-medium hover:underline"
                        >
                          {b.vendor_name}
                        </Link>
                      </td>
                      <td className={td}>{b.bill_number}</td>
                      <td className={`${td} hidden sm:table-cell`}>{fmtDate(b.issue_date)}</td>
                      <td className={`${td} ${b.overdue ? "text-red-700 dark:text-red-400" : ""}`}>
                        {fmtDate(b.due_date)}
                      </td>
                      <td className={td}>
                        <DocStatus
                          status={BILL_STATUS[b.status]}
                          pending={b.entry_status === "pending_review"}
                          overdue={b.overdue}
                        />
                      </td>
                      <td className={`${td} text-right`}>
                        <Amount cents={b.balance_due} />
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

function BillEditor({ bill, onDone }: { bill: Bill | null; onDone: (id: string, msg?: string) => void }) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const accounts = useAccounts(orgId);
  const vendors = useContacts(orgId, "vendor");
  const [vendor, setVendor] = useState(bill?.vendor_id ?? "");
  const [number, setNumber] = useState(bill?.bill_number ?? "");
  const [issue, setIssue] = useState(bill?.issue_date ?? todayIso());
  const [due, setDue] = useState(bill?.due_date ?? "");
  const [memo, setMemo] = useState(bill?.memo ?? "");
  const [file, setFile] = useState<File | null>(null);
  let k = 0;
  const [lines, setLines] = useState<EditLine[]>(
    bill?.lines.map((l) => ({
      key: ++k + 1000,
      description: l.description,
      qty: "1",
      price: centsToDecimal(l.amount),
      account_id: l.account_id,
    })) ?? [blankLine()],
  );
  const v = vendors.data?.find((c) => c.id === vendor);
  const defaultExpense = v?.default_account_id ?? "";
  const invalid = lines.some((l) => tryParseCents(l.price || "0") === null);
  const save = useMutation({
    mutationFn: async (draft: boolean) => {
      const body = {
        vendor_id: vendor,
        bill_number: number || null,
        issue_date: issue,
        due_date: due || null,
        memo: memo || null,
        lines: lines
          .filter((l) => l.price)
          .map((l) => ({
            description: l.description || "Item",
            amount: tryParseCents(l.price) ?? 0,
            account_id: l.account_id || defaultExpense,
          })),
      };
      let id: string;
      let msg: string | undefined;
      if (bill) {
        await unwrap(
          api.PATCH("/api/v1/orgs/{orgId}/bills/{billId}", {
            params: { path: { orgId, billId: bill.id } },
            body,
          }),
        );
        id = bill.id;
        if (!draft) {
          const r = await unwrap(
            api.POST("/api/v1/orgs/{orgId}/bills/{billId}/finalize", {
              params: { path: { orgId, billId: id } },
              body: {},
            }),
          );
          if (r.review) msg = `Waiting in the review queue: ${r.review.reason}`;
        }
      } else {
        const r = await unwrap(
          api.POST("/api/v1/orgs/{orgId}/bills", { params: { path: { orgId } }, body: { ...body, draft } }),
        );
        id = r.bill.id;
        if (r.review) msg = `Waiting in the review queue: ${r.review.reason}`;
      }
      if (file) {
        const form = new FormData();
        form.append("file", file);
        form.append("target_type", "bill");
        form.append("target_id", id);
        await rawFetch(`/api/v1/orgs/${orgId}/attachments`, { method: "POST", body: form });
      }
      return { id, msg };
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["bills", orgId] });
      await qc.invalidateQueries({ queryKey: ["bill", orgId] });
      onDone(r.id, r.msg);
    },
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(false);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Vendor" className="sm:col-span-2">
          {() => <ContactPicker kind="vendor" value={vendor} onChange={setVendor} />}
        </Field>
        <Field label="Bill number">
          {(id) => <Input id={id} value={number} onChange={(e) => setNumber(e.target.value)} />}
        </Field>
        <Field label="Bill date">
          {(id) => <Input id={id} type="date" value={issue} onChange={(e) => setIssue(e.target.value)} />}
        </Field>
        <Field label="Due date" hint="Empty: 30 days after the bill date.">
          {(id) => <Input id={id} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}
        </Field>
        <Field label="Attach the bill (PDF or photo)" className="sm:col-span-3">
          {(id) => (
            <input
              id={id}
              type="file"
              accept="application/pdf,image/*"
              capture="environment"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-2 dark:file:bg-zinc-800"
            />
          )}
        </Field>
      </div>
      <LinesEditor
        lines={lines}
        setLines={setLines}
        withQty={false}
        accountTypes={["expense", "asset", "liability"]}
        defaultAccount={
          defaultExpense || (accounts.data?.find((a) => a.type === "expense" && a.is_active)?.id ?? "")
        }
      />
      <Field label="Memo">
        {(id) => <Textarea id={id} rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />}
      </Field>
      {invalid && <Alert kind="error">Check the amounts.</Alert>}
      <ErrorText error={save.error} />
      <div className="flex gap-2">
        <Button
          type="submit"
          loading={save.isPending && save.variables === false}
          disabled={!vendor || invalid}
        >
          Save bill
        </Button>
        <Button
          variant="secondary"
          loading={save.isPending && save.variables === true}
          disabled={!vendor || invalid}
          onClick={() => save.mutate(true)}
        >
          Save as draft
        </Button>
      </div>
    </form>
  );
}

export function NewBillPage() {
  const orgId = useOrgId();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Enter a bill" />
      <Card>
        <BillEditor
          bill={null}
          onDone={(id) => navigate({ to: "/o/$orgId/expenses/bills/$billId", params: { orgId, billId: id } })}
        />
      </Card>
    </>
  );
}

export function BillPage() {
  const orgId = useOrgId();
  const { billId } = useParams({ strict: false }) as { billId: string };
  const { canWrite } = useRole();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["bill", orgId, billId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/bills/{billId}", { params: { path: { orgId, billId } } })),
  });
  const files = useQuery({
    queryKey: ["attachments", orgId, "bill", billId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/attachments", {
          params: { path: { orgId }, query: { target_type: "bill", target_id: billId } },
        }),
      ).then((r) => r.data),
  });
  const accounts = useAccounts(orgId);
  const refresh = () =>
    Promise.all(
      ["bill", "bills", "attachments", "entries", "accounts", "review"].map((k) =>
        qc.invalidateQueries({ queryKey: [k, orgId] }),
      ),
    );
  const voidIt = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/bills/{billId}/void", {
          params: { path: { orgId, billId } },
          body: {},
        }),
      ),
    onSuccess: refresh,
  });
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const form = new FormData();
      form.append("file", f);
      form.append("target_type", "bill");
      form.append("target_id", billId);
      await rawFetch(`/api/v1/orgs/${orgId}/attachments`, { method: "POST", body: form });
    },
    onSuccess: refresh,
  });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorText error={q.error} />;
  const b = q.data;
  const pending = b.entry_status === "pending_review";
  if (editing) {
    return (
      <>
        <PageHeader title="Edit bill" />
        <Card>
          <BillEditor
            bill={b}
            onDone={async (_id, m) => {
              setEditing(false);
              if (m) setMsg(m);
              await refresh();
            }}
          />
        </Card>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={`Bill from ${b.vendor_name}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <DocStatus status={BILL_STATUS[b.status]} pending={pending} overdue={b.overdue} />
            {b.bill_number && `#${b.bill_number} · `}
            {fmtDate(b.issue_date)} · due {fmtDate(b.due_date)}
          </span>
        }
        actions={
          canWrite && (
            <>
              {b.status === "draft" && !pending && (
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
              {(b.status === "open" || b.status === "partial") && (
                <Button onClick={() => setPaying(true)}>Pay bill</Button>
              )}
              <Link to="/o/$orgId/expenses/bills/recurring/new" params={{ orgId }} search={{ from: b.id }}>
                <Button variant="secondary">Make recurring</Button>
              </Link>
            </>
          )
        }
      />
      <div className="space-y-4">
        {msg && <Alert kind="warn">{msg}</Alert>}
        {pending && (
          <Alert kind="warn">
            This bill is waiting in the review queue and does not affect the books yet.
          </Alert>
        )}
        <ErrorText error={voidIt.error ?? upload.error} />
        <Card>
          <Table>
            <thead>
              <tr>
                <th className={th}>Description</th>
                <th className={th}>Account</th>
                <th className={`${th} text-right`}>Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {b.lines.map((l) => (
                <tr key={l.id}>
                  <td className={td}>{l.description}</td>
                  <td className={td}>{accounts.data?.find((a) => a.id === l.account_id)?.name}</td>
                  <td className={`${td} text-right num`}>{money(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <dl className="ml-auto mt-4 grid max-w-xs grid-cols-2 gap-1 text-sm">
            <dt>Total</dt>
            <dd className="text-right num">{money(b.total)}</dd>
            <dt>Paid</dt>
            <dd className="text-right num">{money(b.amount_paid)}</dd>
            <dt className="font-semibold">Balance</dt>
            <dd className="text-right font-semibold num">{money(b.balance_due)}</dd>
          </dl>
        </Card>
        <Card
          title="Attachments"
          actions={
            canWrite && (
              <label className="cursor-pointer text-sm text-brand-700 hover:underline dark:text-gold-400">
                Add file
                <input
                  type="file"
                  className="sr-only"
                  accept="application/pdf,image/*"
                  capture="environment"
                  onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])}
                />
              </label>
            )
          }
        >
          {!files.data?.length ? (
            <p className="text-sm text-zinc-500">No files.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {files.data.map((f) => (
                <li key={f.id}>
                  <a
                    href={`/api/v1/orgs/${orgId}/attachments/${f.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    {f.filename}
                  </a>{" "}
                  <span className="text-zinc-500">({Math.ceil(f.size_bytes / 1024)} KB)</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {canWrite && b.status !== "void" && b.status !== "draft" && (
          <Button
            variant="ghost"
            className="text-red-700"
            loading={voidIt.isPending}
            onClick={() => voidIt.mutate()}
          >
            Void bill
          </Button>
        )}
        {b.entry_id && (
          <Link
            to="/o/$orgId/accounting/entries/$entryId"
            params={{ orgId, entryId: b.entry_id }}
            className="block text-sm underline"
          >
            View journal entry
          </Link>
        )}
        {b.recurring_id && (
          <Link
            to="/o/$orgId/expenses/bills/recurring/$templateId"
            params={{ orgId, templateId: b.recurring_id }}
            className="block text-sm underline"
          >
            From recurring template ›
          </Link>
        )}
      </div>
      {paying && (
        <PaymentModal
          direction="sent"
          contactId={b.vendor_id}
          preselect={{ [b.id]: b.balance_due }}
          onClose={() => setPaying(false)}
          onDone={async () => {
            setPaying(false);
            await refresh();
          }}
        />
      )}
    </>
  );
}
