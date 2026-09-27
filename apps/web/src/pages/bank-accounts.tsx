import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { api, unwrap } from "../api/client";
import { AccountSelect } from "../components/AccountSelect";
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
  Select,
  Table,
  td,
  th,
} from "../components/ui";
import {
  type BankAccount,
  type CsvProfile,
  type ImportPreview,
  KIND_LABEL,
  useBankAccounts,
} from "../lib/banking";
import { fmtDate } from "../lib/format";
import { useAccounts } from "../lib/ledger";
import { useOrgId, useRole } from "../lib/org";
import { BankFeeds } from "./bank-feeds";

// ----------------------------------------------------------------------------- accounts

export function BankAccountsPage() {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const list = useBankAccounts(orgId);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader
        title="Bank accounts"
        subtitle="Connect a bank feed, or import CSV, OFX, or QFX statements. Both work side by side."
        actions={canWrite && <Button onClick={() => setAdding(true)}>Add account</Button>}
      />
      <BankFeeds />
      <ErrorText error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : !list.data?.length ? (
        <Card>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Add a checking, savings, or credit card account, then import a CSV, OFX, or QFX statement from
            your bank.
          </p>
        </Card>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <th className={th}>Account</th>
                <th className={th}>Type</th>
                <th className={`${th} text-right`}>Balance</th>
                <th className={th}>To categorize</th>
                <th className={`${th} hidden sm:table-cell`}>Latest</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {list.data.map((b) => (
                <tr key={b.id} className={b.is_active ? "" : "opacity-60"}>
                  <td className={td}>
                    {b.name}
                    {b.mask && <span className="ml-1 text-zinc-400">··{b.mask}</span>}
                  </td>
                  <td className={td}>{KIND_LABEL[b.kind]}</td>
                  <td className={`${td} text-right`}>
                    <Amount cents={b.balance} />
                  </td>
                  <td className={td}>
                    {b.unreviewed > 0 ? (
                      <Link
                        to="/o/$orgId/banking/categorize"
                        params={{ orgId }}
                        search={{ account: b.id, status: "todo" } as never}
                      >
                        <Badge tone="amber">{b.unreviewed}</Badge>
                      </Link>
                    ) : (
                      <span className="text-zinc-400">0</span>
                    )}
                    {b.pending > 0 && (
                      <span className="ml-2 text-xs text-zinc-500">+{b.pending} pending</span>
                    )}
                  </td>
                  <td className={`${td} hidden text-zinc-500 sm:table-cell`}>
                    {fmtDate(b.last_transaction_date)}
                  </td>
                  <td className={`${td} text-right`}>
                    {canWrite && (
                      <Link
                        to="/o/$orgId/banking/import"
                        params={{ orgId }}
                        search={{ account: b.id } as never}
                        className="text-sm text-brand-700 hover:underline dark:text-gold-400"
                      >
                        Import
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {adding && <AddBankAccount onClose={() => setAdding(false)} />}
    </>
  );
}

function AddBankAccount({ onClose }: { onClose: () => void }) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const accounts = useAccounts(orgId);
  const existing = useBankAccounts(orgId);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<BankAccount["kind"]>("checking");
  const [mask, setMask] = useState("");
  const [ledger, setLedger] = useState("");
  const linked = new Set((existing.data ?? []).map((b) => b.ledger_account_id));
  const eligible = (accounts.data ?? []).filter(
    (a) =>
      !linked.has(a.id) &&
      (kind === "credit_card"
        ? a.type === "liability" && a.subtype === "credit_card"
        : a.type === "asset" && a.subtype === "bank"),
  );
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/bank-accounts", {
          params: { path: { orgId } },
          body: { name, kind, mask: mask || null, ledger_account_id: ledger || null },
        }),
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bank-accounts", orgId] });
      await qc.invalidateQueries({ queryKey: ["accounts", orgId] });
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Add bank account"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!name} onClick={() => save.mutate()}>
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          {(id) => (
            <Input
              id={id}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Chase Business Checking"
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            {(id) => (
              <Select
                id={id}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as BankAccount["kind"]);
                  setLedger("");
                }}
              >
                {Object.entries(KIND_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Last 4 digits (optional)">
            {(id) => <Input id={id} maxLength={4} value={mask} onChange={(e) => setMask(e.target.value)} />}
          </Field>
        </div>
        <Field
          label="Ledger account"
          hint="Use an existing account from your chart, or leave empty to create one."
        >
          {(id) => (
            <AccountSelect
              id={id}
              accounts={eligible}
              value={ledger}
              onChange={setLedger}
              placeholder="Create a new account"
            />
          )}
        </Field>
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------------------- import

const DATE_FORMATS = [
  "YYYY-MM-DD",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
  "M/D/YY",
  "D/M/YY",
  "YYYYMMDD",
  "DD.MM.YYYY",
  "MMM D, YYYY",
  "YYYY/MM/DD",
  "MM-DD-YYYY",
  "DD-MM-YYYY",
  "D MMM YYYY",
] as const;

export function ImportPage() {
  const orgId = useOrgId();
  const search = useSearch({ strict: false }) as { account?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const banks = useBankAccounts(orgId);
  const [bankId, setBankId] = useState(search.account ?? "");
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [profile, setProfile] = useState<CsvProfile | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const active = (banks.data ?? []).filter((b) => b.is_active);
  const bank = bankId || active[0]?.id || "";

  const runPreview = useMutation({
    mutationFn: (p: { content: string; name: string; profile: CsvProfile | null }) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/bank-accounts/{bankAccountId}/import/preview", {
          params: { path: { orgId, bankAccountId: bank } },
          body: { filename: p.name, content: p.content, profile: p.profile },
        }),
      ),
    onSuccess: (r) => {
      setPreview(r);
      if (r.profile) setProfile(r.profile);
    },
  });
  const commit = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/bank-accounts/{bankAccountId}/import", {
          params: { path: { orgId, bankAccountId: bank } },
          body: { filename: file!.name, content: file!.content, profile, save_profile: true },
        }),
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bank-accounts", orgId] });
      await qc.invalidateQueries({ queryKey: ["bank-txns", orgId] });
    },
  });

  const onFile = async (f: File | undefined) => {
    commit.reset();
    setPreview(null);
    setProfile(null);
    if (!f) return setFile(null);
    const content = await f.text();
    setFile({ name: f.name, content });
    runPreview.mutate({ name: f.name, content, profile: null });
  };
  const updateProfile = (p: CsvProfile) => {
    setProfile(p);
    if (file) runPreview.mutate({ name: file.name, content: file.content, profile: p });
  };

  if (banks.isLoading) return <Loading />;
  if (!active.length) {
    return (
      <>
        <PageHeader title="Import statements" />
        <Alert kind="info">
          Add a bank account first on the{" "}
          <Link to="/o/$orgId/banking/accounts" params={{ orgId }} className="underline">
            bank accounts
          </Link>{" "}
          page.
        </Alert>
      </>
    );
  }
  const colOptions = preview?.headers.map((h, i) => ({ i, label: h || `Column ${i + 1}` })) ?? [];
  return (
    <>
      <PageHeader
        title="Import statements"
        subtitle="CSV, OFX, or QFX. Importing the same transactions twice never creates duplicates."
      />
      <div className="space-y-4">
        <Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bank account">
              {(id) => (
                <Select id={id} value={bank} onChange={(e) => setBankId(e.target.value)}>
                  {active.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                      {b.mask ? ` ··${b.mask}` : ""}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Statement file">
              {(id) => (
                <input
                  id={id}
                  type="file"
                  accept=".csv,.ofx,.qfx,.txt,text/csv"
                  onChange={(e) => onFile(e.target.files?.[0])}
                  className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm dark:file:bg-zinc-800"
                />
              )}
            </Field>
          </div>
        </Card>
        {runPreview.isPending && <Loading />}
        <ErrorText error={runPreview.error} />
        {preview && profile && preview.format === "csv" && (
          <Card
            title="Column mapping"
            actions={<Badge>{preview.profile_source === "saved" ? "Saved mapping" : "Detected"}</Badge>}
          >
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <Field label="Date column">
                {(id) => (
                  <ColumnSelect
                    id={id}
                    options={colOptions}
                    value={profile.columns.date}
                    onChange={(v) =>
                      updateProfile({ ...profile, columns: { ...profile.columns, date: v ?? 0 } })
                    }
                  />
                )}
              </Field>
              <Field label="Date format">
                {(id) => (
                  <Select
                    id={id}
                    value={profile.dateFormat}
                    onChange={(e) =>
                      updateProfile({ ...profile, dateFormat: e.target.value as CsvProfile["dateFormat"] })
                    }
                  >
                    {DATE_FORMATS.map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Description column">
                {(id) => (
                  <ColumnSelect
                    id={id}
                    options={colOptions}
                    value={profile.columns.description}
                    onChange={(v) =>
                      updateProfile({ ...profile, columns: { ...profile.columns, description: v ?? 0 } })
                    }
                  />
                )}
              </Field>
              <Field label="Amounts">
                {(id) => (
                  <Select
                    id={id}
                    value={profile.amountMode}
                    onChange={(e) =>
                      updateProfile({ ...profile, amountMode: e.target.value as CsvProfile["amountMode"] })
                    }
                  >
                    <option value="signed">One signed amount column</option>
                    <option value="debit_credit">Separate debit and credit columns</option>
                    <option value="amount_type">Amount plus a type column</option>
                  </Select>
                )}
              </Field>
              {profile.amountMode === "debit_credit" ? (
                <>
                  <Field label="Money out (debit) column">
                    {(id) => (
                      <ColumnSelect
                        id={id}
                        options={colOptions}
                        value={profile.columns.debit ?? null}
                        onChange={(v) =>
                          updateProfile({ ...profile, columns: { ...profile.columns, debit: v } })
                        }
                      />
                    )}
                  </Field>
                  <Field label="Money in (credit) column">
                    {(id) => (
                      <ColumnSelect
                        id={id}
                        options={colOptions}
                        value={profile.columns.credit ?? null}
                        onChange={(v) =>
                          updateProfile({ ...profile, columns: { ...profile.columns, credit: v } })
                        }
                      />
                    )}
                  </Field>
                </>
              ) : (
                <Field label="Amount column">
                  {(id) => (
                    <ColumnSelect
                      id={id}
                      options={colOptions}
                      value={profile.columns.amount ?? null}
                      onChange={(v) =>
                        updateProfile({ ...profile, columns: { ...profile.columns, amount: v } })
                      }
                    />
                  )}
                </Field>
              )}
              {profile.amountMode === "amount_type" && (
                <Field label="Type column">
                  {(id) => (
                    <ColumnSelect
                      id={id}
                      options={colOptions}
                      value={profile.columns.type ?? null}
                      onChange={(v) =>
                        updateProfile({ ...profile, columns: { ...profile.columns, type: v } })
                      }
                    />
                  )}
                </Field>
              )}
              {profile.amountMode !== "debit_credit" && (
                <Field label="Positive amounts are">
                  {(id) => (
                    <Select
                      id={id}
                      value={profile.signConvention}
                      onChange={(e) =>
                        updateProfile({
                          ...profile,
                          signConvention: e.target.value as CsvProfile["signConvention"],
                        })
                      }
                    >
                      <option value="positive_is_deposit">Money in (deposits)</option>
                      <option value="positive_is_withdrawal">Money out (charges)</option>
                    </Select>
                  )}
                </Field>
              )}
              <Field label="Payee column (optional)">
                {(id) => (
                  <ColumnSelect
                    id={id}
                    options={colOptions}
                    value={profile.columns.payee ?? null}
                    onChange={(v) => updateProfile({ ...profile, columns: { ...profile.columns, payee: v } })}
                    allowNone
                  />
                )}
              </Field>
            </div>
          </Card>
        )}
        {preview && (
          <Card title="Preview">
            <p className="mb-3 text-sm">
              {preview.summary.rows} rows read · <strong>{preview.summary.new} new</strong> ·{" "}
              {preview.summary.duplicates} duplicates ·{" "}
              <span className={preview.summary.errors ? "text-red-700 dark:text-red-400" : ""}>
                {preview.summary.errors} errors
              </span>
            </p>
            {preview.errors.length > 0 && (
              <Alert kind="warn">
                {preview.errors.slice(0, 5).map((e) => (
                  <div key={e.row}>
                    Row {e.row}: {e.message}
                  </div>
                ))}
                {preview.errors.length > 5 && <div>…and {preview.errors.length - 5} more</div>}
              </Alert>
            )}
            <Table>
              <thead>
                <tr>
                  <th className={th}>Date</th>
                  <th className={th}>Description</th>
                  <th className={`${th} text-right`}>Amount</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {preview.sample.slice(0, 15).map((s, i) => (
                  <tr key={i} className={s.duplicate ? "opacity-50" : ""}>
                    <td className={`${td} whitespace-nowrap`}>{fmtDate(s.date)}</td>
                    <td className={td}>{s.description}</td>
                    <td className={`${td} text-right`}>
                      <Amount cents={s.amount} />
                    </td>
                    <td className={td}>{s.duplicate && <Badge>Duplicate</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                loading={commit.isPending}
                disabled={!preview.summary.new || commit.isSuccess}
                onClick={() => commit.mutate()}
              >
                Import {preview.summary.new} transactions
              </Button>
              <ErrorText error={commit.error} />
            </div>
          </Card>
        )}
        {commit.data && (
          <Alert kind="success">
            Imported {commit.data.imported} ({commit.data.duplicates} duplicates skipped).{" "}
            {commit.data.auto_posted > 0 && `${commit.data.auto_posted} posted by rules. `}
            {commit.data.proposed > 0 && `${commit.data.proposed} waiting in the review queue. `}
            {commit.data.transfers_paired > 0 && `${commit.data.transfers_paired} matched to transfers. `}
            <button
              type="button"
              className="underline"
              onClick={() =>
                navigate({
                  to: "/o/$orgId/banking/categorize",
                  params: { orgId },
                  search: { account: bank } as never,
                })
              }
            >
              Categorize transactions
            </button>
          </Alert>
        )}
      </div>
    </>
  );
}

function ColumnSelect({
  id,
  options,
  value,
  onChange,
  allowNone,
}: {
  id: string;
  options: { i: number; label: string }[];
  value: number | null;
  onChange: (v: number | null) => void;
  allowNone?: boolean;
}) {
  return (
    <Select
      id={id}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    >
      {(allowNone || value == null) && <option value="">None</option>}
      {options.map((o) => (
        <option key={o.i} value={o.i}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}
