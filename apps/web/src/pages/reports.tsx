import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { api, download, unwrap } from "../api/client";
import {
  Alert,
  Button,
  Card,
  cx,
  ErrorText,
  Field,
  GroupToggle,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
} from "../components/ui";
import { fmtDate, fmtDateTime, money, todayIso } from "../lib/format";
import type { Report } from "../lib/ledger";
import { useOrg, useOrgId, useRole } from "../lib/org";

export const REPORTS = [
  {
    key: "profit_and_loss",
    label: "Profit and loss",
    kind: "period",
    compare: ["none", "prior_period", "prior_year", "monthly"],
  },
  { key: "balance_sheet", label: "Balance sheet", kind: "as_of", compare: ["none", "prior_year"] },
  { key: "cash_flow", label: "Cash flow", kind: "period", compare: [] },
  { key: "trial_balance", label: "Trial balance", kind: "as_of", compare: [] },
  { key: "general_ledger", label: "General ledger", kind: "period", compare: [] },
  { key: "tax_line_summary", label: "Tax line summary", kind: "period", compare: [] },
  { key: "ar_aging", label: "Accounts receivable aging", kind: "as_of", compare: [] },
  { key: "ap_aging", label: "Accounts payable aging", kind: "as_of", compare: [] },
  { key: "vendor_1099", label: "1099 vendor summary", kind: "year", compare: [] },
] as const;
const NO_BASIS = new Set(["general_ledger", "ar_aging", "ap_aging", "vendor_1099"]);
type ReportKey = (typeof REPORTS)[number]["key"];

const COMPARE_LABEL: Record<string, string> = {
  none: "No comparison",
  prior_period: "Previous period",
  prior_year: "Previous year",
  monthly: "By month",
};

export type ReportSearch = {
  report?: ReportKey;
  from?: string;
  to?: string;
  as_of?: string;
  compare?: string;
  basis?: "cash" | "accrual";
};

export function validateReportSearch(s: Record<string, unknown>): ReportSearch {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const report = REPORTS.find((r) => r.key === s.report)?.key;
  const basis = s.basis === "cash" || s.basis === "accrual" ? s.basis : undefined;
  return { report, from: str(s.from), to: str(s.to), as_of: str(s.as_of), compare: str(s.compare), basis };
}

function fyStart(date: string, startMonth: number) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const year = m >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, "0")}-01`;
}

export function ReportsPage() {
  const orgId = useOrgId();
  const org = useOrg();
  const search = useSearch({ strict: false }) as ReportSearch;
  const navigate = useNavigate();
  const key: ReportKey = search.report ?? "profit_and_loss";
  const def = REPORTS.find((r) => r.key === key)!;
  const today = todayIso();
  const from = search.from ?? fyStart(today, org.data?.settings.fiscal_year_start_month ?? 1);
  const to = search.to ?? today;
  const asOf = search.as_of ?? today;
  const compare =
    search.compare && (def.compare as readonly string[]).includes(search.compare) ? search.compare : "none";
  const set = (p: Partial<ReportSearch>) =>
    navigate({ to: ".", search: { ...search, ...p } as never, replace: true });

  const basis = search.basis ?? org.data?.settings.default_basis ?? "accrual";
  const year = (search.to ?? today).slice(0, 4);
  const query: Record<string, string> =
    def.kind === "period" ? { from, to } : def.kind === "year" ? { to: `${year}-12-31` } : { as_of: asOf };
  if (!NO_BASIS.has(key)) query.basis = basis;
  const q = useQuery({
    queryKey: ["report", orgId, key, query, compare],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/reports/{report}", {
          params: { path: { orgId, report: key }, query: { ...query, compare: compare as never } as never },
          parseAs: "json",
        }),
      ) as Promise<Report>,
    enabled: Boolean(org.data),
  });

  const csvUrl = () => {
    const p = new URLSearchParams(
      Object.entries({ ...query, compare, format: "csv" }).filter((kv): kv is [string, string] =>
        Boolean(kv[1]),
      ),
    );
    return `/api/v1/orgs/${orgId}/reports/${key}?${p}`;
  };

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Every report shows the ledger chain head, so a saved copy can be checked against the books later."
        actions={
          <>
            <Button variant="secondary" onClick={() => download(csvUrl(), `${key}.csv`)} disabled={!q.data}>
              CSV
            </Button>
            <Button
              variant="secondary"
              onClick={() => download(csvUrl().replace("format=csv", "format=pdf"), `${key}.pdf`)}
              disabled={!q.data}
            >
              PDF
            </Button>
            <Button variant="secondary" onClick={() => window.print()} disabled={!q.data}>
              Print
            </Button>
            <YearEndButton />
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
        <Field label="Report">
          {(id) => (
            <Select
              id={id}
              value={key}
              onChange={(e) => set({ report: e.target.value as ReportKey, compare: undefined })}
            >
              {REPORTS.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {def.kind === "year" ? (
          <Field label="Year">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) => set({ to: `${e.target.value}-12-31` })}
                className="w-28"
              />
            )}
          </Field>
        ) : def.kind === "period" ? (
          <>
            <Field label="From">
              {(id) => (
                <Input id={id} type="date" value={from} onChange={(e) => set({ from: e.target.value })} />
              )}
            </Field>
            <Field label="To">
              {(id) => <Input id={id} type="date" value={to} onChange={(e) => set({ to: e.target.value })} />}
            </Field>
          </>
        ) : (
          <Field label="As of">
            {(id) => (
              <Input id={id} type="date" value={asOf} onChange={(e) => set({ as_of: e.target.value })} />
            )}
          </Field>
        )}
        {!NO_BASIS.has(key) && (
          <Field label="Basis">
            {(id) => (
              <Select
                id={id}
                value={basis}
                onChange={(e) => set({ basis: e.target.value as "cash" | "accrual" })}
              >
                <option value="accrual">Accrual</option>
                <option value="cash">Cash</option>
              </Select>
            )}
          </Field>
        )}
        {def.compare.length > 0 && (
          <Field label="Compare">
            {(id) => (
              <Select id={id} value={compare} onChange={(e) => set({ compare: e.target.value })}>
                {def.compare.map((c) => (
                  <option key={c} value={c}>
                    {COMPARE_LABEL[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      <ErrorText error={q.error} />
      {q.isLoading || !q.data ? (
        <Loading />
      ) : (
        <ReportView
          report={q.data}
          orgId={orgId}
          period={def.kind === "period" ? { from, to } : { from: undefined, to: asOf }}
        />
      )}
    </>
  );
}

export function ReportView({
  report,
  orgId,
  period,
}: {
  report: Report;
  orgId: string;
  period: { from?: string; to?: string };
}) {
  const failed = Object.entries(report.checks).filter(([, v]) => v !== 0);
  const cols = report.columns;
  // Parent accounts with sub-accounts arrive as header … "Total <name>" groups keyed by accountId.
  // A collapsed group shows its subtotal on the header row and hides everything through the subtotal.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const rows: { l: Report["lines"][number]; i: number; values: number[]; group: "open" | "closed" | null }[] =
    [];
  let hideThrough: string | null = null;
  for (const [i, l] of report.lines.entries()) {
    if (hideThrough) {
      if (l.kind === "subtotal" && l.accountId === hideThrough) hideThrough = null;
      continue;
    }
    const group =
      l.kind === "header" && l.accountId ? (collapsed.has(l.accountId) ? "closed" : "open") : null;
    if (group !== "closed") {
      rows.push({ l, i, values: l.values, group });
      continue;
    }
    const total = report.lines.find((x, j) => j > i && x.kind === "subtotal" && x.accountId === l.accountId);
    rows.push({ l, i, values: total?.values ?? l.values, group });
    hideThrough = l.accountId!;
  }
  return (
    <Card className="print:ring-0">
      <div className="mb-4 text-center">
        <p className="text-sm text-zinc-500">{report.meta.org_name}</p>
        <h2 className="text-lg font-semibold">{report.title}</h2>
        <p className="text-sm text-zinc-500">
          {cols[0]?.from && cols[0]?.to
            ? `${fmtDate(cols[0].from)} to ${fmtDate(cols[0].to)}`
            : cols[0]?.asOf
              ? `As of ${fmtDate(cols[0].asOf)}`
              : ""}
        </p>
      </div>
      {failed.length > 0 && (
        <Alert kind="error">
          This report does not tie out ({failed.map(([k]) => k).join(", ")}). Run a chain verification in
          Settings.
        </Alert>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {cols.length > 1 && (
            <thead>
              <tr>
                <th />
                {cols.map((c) => (
                  <th key={c.label} className="px-3 py-2 text-right text-xs font-semibold text-zinc-500">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {report.lines.length === 0 && (
              <tr>
                <td className="py-6 text-center text-zinc-500" colSpan={cols.length + 1}>
                  No activity.
                </td>
              </tr>
            )}
            {rows.map(({ l, i, values, group }) => {
              const strong = l.kind === "subtotal" || l.kind === "total" || l.kind === "header";
              return (
                <tr
                  key={`${i}-${l.label}`}
                  className={cx(
                    l.kind === "total" && "border-t-2 border-double border-zinc-400",
                    l.kind === "subtotal" && "border-t border-zinc-200 dark:border-zinc-800",
                  )}
                >
                  <td
                    className={cx("py-1.5 pr-3", strong && "font-semibold")}
                    style={{ paddingLeft: `${l.depth * 1.25}rem` }}
                  >
                    {l.kind === "account" && l.accountId && !NO_BASIS.has(report.key) ? (
                      <Link
                        to="/o/$orgId/accounting/entries"
                        params={{ orgId }}
                        search={{ account: l.accountId, from: period.from, to: period.to } as never}
                        className="hover:underline"
                      >
                        {l.code ? <span className="mr-2 text-zinc-400 num">{l.code}</span> : null}
                        {l.label}
                      </Link>
                    ) : group ? (
                      <span className="inline-flex items-center">
                        <GroupToggle
                          open={group === "open"}
                          label={l.label}
                          onClick={() => toggle(l.accountId!)}
                        />
                        {l.code ? <span className="mr-2 font-normal text-zinc-400 num">{l.code}</span> : null}
                        {l.label}
                      </span>
                    ) : (
                      l.label
                    )}
                  </td>
                  {values.map((v, j) => (
                    <td
                      key={j}
                      className={cx(
                        "px-3 py-1.5 text-right num whitespace-nowrap",
                        strong && "font-semibold",
                      )}
                    >
                      {l.kind === "header" && group !== "closed" && v === 0 ? "" : money(v, "USD", true)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-6 border-t border-zinc-200 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
        Generated {fmtDateTime(report.meta.generated_at)} · {report.meta.basis} basis · Ledger chain head #
        {report.meta.chain_head.seq} <code className="break-all">{report.meta.chain_head.hash}</code>
      </p>
      {!report.meta.chain_intact && (
        <Alert kind="error">
          The ledger chain doesn't verify: stored records were changed outside Cosimo. Run Settings →
          Integrity to find the first altered entry.
        </Alert>
      )}
    </Card>
  );
}

/** Year-end package (SPEC §9.1): every report for a fiscal year as PDF and CSV in one ZIP. */
function YearEndButton() {
  const orgId = useOrgId();
  const org = useOrg();
  const { role } = useRole();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const startMonth = org.data?.settings.fiscal_year_start_month ?? 1;
  // A fiscal year is named by the calendar year it ends in.
  const start = fyStart(todayIso(), startMonth);
  const current = Number(start.slice(0, 4)) + (startMonth === 1 ? 0 : 1);
  const [year, setYear] = useState<number | null>(null);
  const selected = year ?? current - 1;
  if (role === "viewer" || !org.data) return null;
  const label = (y: number) => {
    if (startMonth === 1) return String(y);
    const from = new Date(Date.UTC(y - 1, startMonth - 1, 1));
    const to = new Date(Date.UTC(y, startMonth - 1, 0));
    const f = (d: Date) =>
      d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
    return `FY${y} (${f(from)} to ${f(to)})`;
  };
  const slug =
    org.data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || orgId;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await download(`/api/v1/orgs/${orgId}/year-end?year=${selected}`, `${slug}-${selected}-year-end.zip`);
      setOpen(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Year-end package
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Year-end package"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={run} loading={busy}>
              Download
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            One ZIP with the profit and loss, balance sheet, trial balance, general ledger, tax line summary,
            1099 summary, AR and AP aging, and the final month&apos;s reconciliations, each as PDF and CSV. It
            uses your default basis ({org.data.settings.default_basis}) and includes the ledger and audit
            chain heads so the books can be checked later.
          </p>
          <Field label="Fiscal year">
            {(id) => (
              <Select id={id} value={selected} onChange={(e) => setYear(Number(e.target.value))}>
                {Array.from({ length: 7 }, (_, i) => current - i).map((y) => (
                  <option key={y} value={y}>
                    {label(y)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ErrorText error={error} />
        </div>
      </Modal>
    </>
  );
}
