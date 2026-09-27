import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, unwrap } from "../api/client";
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  Loading,
  PageHeader,
  Table,
  td,
  th,
} from "../components/ui";
import { fmtDate, fmtDateTime, money, tryParseCents } from "../lib/format";
import { TYPE_LABELS, useAccounts } from "../lib/ledger";
import { useOrg, useOrgId, useRole } from "../lib/org";

// ----------------------------------------------------------------------------- lock dates

export function LockDates() {
  const orgId = useOrgId();
  const org = useOrg();
  const qc = useQueryClient();
  const { isOwner } = useRole();
  const [soft, setSoft] = useState("");
  const [hard, setHard] = useState("");
  useEffect(() => {
    if (org.data) {
      setSoft(org.data.settings.soft_lock_date ?? "");
      setHard(org.data.settings.hard_lock_date ?? "");
    }
  }, [org.data]);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/api/v1/orgs/{orgId}/lock-dates", {
          params: { path: { orgId } },
          body: { soft_lock_date: soft || null, hard_lock_date: hard || null },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org", orgId] }),
  });
  if (!org.data) return <Loading />;
  return (
    <Card title="Lock dates">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The <strong>soft lock</strong> stops bookkeepers, API tokens, rules, and AI assistants from posting
          on or before the date. Owners can still post there with a note. The <strong>hard lock</strong> stops
          everyone. A common pattern: soft lock each month after reconciling, hard lock the year once your tax
          return is filed.
        </p>
        <fieldset disabled={!isOwner} className="grid gap-4 sm:grid-cols-2">
          <Field label="Soft lock date">
            {(id) => <Input id={id} type="date" value={soft} onChange={(e) => setSoft(e.target.value)} />}
          </Field>
          <Field label="Hard lock date" hint="Must be on or before the soft lock date.">
            {(id) => <Input id={id} type="date" value={hard} onChange={(e) => setHard(e.target.value)} />}
          </Field>
        </fieldset>
        <ErrorText error={save.error} />
        {save.isSuccess && <Alert kind="success">Lock dates saved and the chain heads checkpointed.</Alert>}
        {isOwner ? (
          <Button type="submit" loading={save.isPending}>
            Save lock dates
          </Button>
        ) : (
          <p className="text-sm text-zinc-500">Only owners can change lock dates.</p>
        )}
      </form>
    </Card>
  );
}

// ----------------------------------------------------------------------------- integrity

export function Integrity() {
  const orgId = useOrgId();
  const { isOwner } = useRole();
  const qc = useQueryClient();
  const cps = useQuery({
    queryKey: ["checkpoints", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/checkpoints", { params: { path: { orgId } } })),
  });
  const verify = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/orgs/{orgId}/verify", { params: { path: { orgId } } })),
  });
  const checkpoint = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/orgs/{orgId}/checkpoints", { params: { path: { orgId } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["checkpoints", orgId] }),
  });
  const v = verify.data;
  return (
    <div className="space-y-4">
      <Card
        title="Tamper-evident ledger"
        actions={
          <>
            {isOwner && (
              <Button
                size="sm"
                variant="secondary"
                loading={checkpoint.isPending}
                onClick={() => checkpoint.mutate()}
              >
                Checkpoint now
              </Button>
            )}
            <Button size="sm" loading={verify.isPending} onClick={() => verify.mutate()}>
              Verify now
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Every posted entry and every audit log row is linked to the one before it by a SHA-256 hash.
          Verification recomputes both chains and names the first broken link. This makes changes to past
          records detectable, not impossible: someone with full database access could rewrite the whole chain,
          which shows up against any checkpoint or printed report kept elsewhere.
        </p>
        {cps.data && (
          <p className="mt-3 text-sm">
            Current ledger head: <span className="num">#{cps.data.ledger_head.seq}</span>{" "}
            <code className="break-all text-xs">{cps.data.ledger_head.hash}</code>
          </p>
        )}
        <div className="mt-3">
          <ErrorText error={verify.error ?? checkpoint.error} />
          {v &&
            (v.ok ? (
              <Alert kind="success">
                Both chains verified: {v.ledger.checked} ledger links and {v.audit.checked} audit links. All
                checkpoints match.
              </Alert>
            ) : (
              <Alert kind="error">
                Verification failed.{" "}
                {v.first_break
                  ? `First broken link: ${v.first_break.chain} #${v.first_break.seq} (${v.first_break.reason}).`
                  : ""}
                {v.checkpoints.mismatches.length > 0 &&
                  ` ${v.checkpoints.mismatches.length} checkpoint(s) no longer match.`}
              </Alert>
            ))}
        </div>
      </Card>
      <Card title="Checkpoints">
        {cps.isLoading ? (
          <Loading />
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>When</th>
                <th className={th}>Chain</th>
                <th className={th}>Seq</th>
                <th className={th}>Reason</th>
                <th className={th}>Head hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {cps.data?.data.map((c) => (
                <tr key={c.id}>
                  <td className={`${td} whitespace-nowrap`}>{fmtDateTime(c.created_at)}</td>
                  <td className={td}>
                    <Badge tone={c.chain === "ledger" ? "blue" : "zinc"}>{c.chain}</Badge>
                  </td>
                  <td className={`${td} num`}>{c.seq}</td>
                  <td className={td}>{c.reason}</td>
                  <td className={td}>
                    <code className="text-xs">{c.head_hash.slice(0, 16)}…</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ----------------------------------------------------------------------------- opening balances

export function OpeningBalancesPage() {
  const orgId = useOrgId();
  const org = useOrg();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const accounts = useAccounts(orgId);
  const [date, setDate] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (org.data && !date) {
      const start = org.data.settings.books_start_date;
      if (start) {
        const d = new Date(`${start}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        setDate(d.toISOString().slice(0, 10));
      }
    }
  }, [org.data, date]);

  const bsAccounts = (accounts.data ?? []).filter(
    (a) =>
      a.is_active &&
      (a.type === "asset" || a.type === "liability" || a.type === "equity") &&
      a.system_key !== "opening_balance_equity",
  );
  // Users enter balances the way a balance sheet shows them (positive numbers); convert to debit/credit.
  const rows = bsAccounts.map((a) => {
    const v = amounts[a.id]?.trim() ? tryParseCents(amounts[a.id]!) : 0;
    const raw = v === null ? null : a.type === "asset" ? v : -v;
    return { a, raw };
  });
  const invalid = rows.some((r) => r.raw === null);
  const totals = { asset: 0, liability: 0, equity: 0 };
  for (const r of rows)
    if (r.raw) totals[r.a.type as "asset" | "liability" | "equity"] += r.a.type === "asset" ? r.raw : -r.raw;
  const obe = totals.asset - totals.liability - totals.equity;

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/opening-balances", {
          params: { path: { orgId } },
          body: {
            date,
            balances: rows.filter((r) => r.raw).map((r) => ({ account_id: r.a.id, amount: r.raw! })),
          },
        }),
      ),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["accounts", orgId] });
      await qc.invalidateQueries({ queryKey: ["org", orgId] });
      navigate({
        to: "/o/$orgId/accounting/entries/$entryId",
        params: { orgId, entryId: r.entry.id },
        search: { msg: r.review ? `Sent to the review queue: ${r.review.reason}` : undefined } as never,
      });
    },
  });

  if (accounts.isLoading) return <Loading />;
  return (
    <>
      <PageHeader
        title="Opening balances"
        subtitle="Copy the balances from your last balance sheet in your previous system. The difference goes to Opening Balance Equity."
      />
      <Card>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Balances as of" hint="Usually the day before your books start in Cosimo.">
            {(id) => (
              <Input
                id={id}
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                className="max-w-xs"
              />
            )}
          </Field>
          {(["asset", "liability", "equity"] as const).map((t) => (
            <div key={t}>
              <h3 className="mb-1 text-sm font-semibold">{TYPE_LABELS[t]}</h3>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows
                  .filter((r) => r.a.type === t)
                  .map(({ a }) => (
                    <label key={a.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                      <span>
                        <span className="mr-2 text-zinc-400 num">{a.code}</span>
                        {a.name}
                        {a.subtype === "accumulated_depreciation" && (
                          <span className="ml-1 text-xs text-zinc-500">(enter as a negative number)</span>
                        )}
                      </span>
                      <Input
                        inputMode="decimal"
                        className="w-40 text-right num"
                        value={amounts[a.id] ?? ""}
                        onChange={(e) => setAmounts({ ...amounts, [a.id]: e.target.value })}
                        placeholder="0.00"
                      />
                    </label>
                  ))}
              </div>
            </div>
          ))}
          <dl className="grid max-w-md grid-cols-2 gap-1 text-sm">
            <dt>Total assets</dt>
            <dd className="text-right num">{money(totals.asset)}</dd>
            <dt>Total liabilities</dt>
            <dd className="text-right num">{money(totals.liability)}</dd>
            <dt>Other equity</dt>
            <dd className="text-right num">{money(totals.equity)}</dd>
            <dt className="font-semibold">Opening Balance Equity</dt>
            <dd className="text-right font-semibold num">{money(obe)}</dd>
          </dl>
          {invalid && <Alert kind="error">Amounts must be numbers with at most two decimal places.</Alert>}
          <ErrorText error={save.error} />
          <Button
            type="submit"
            loading={save.isPending}
            disabled={invalid || !date || rows.every((r) => !r.raw)}
          >
            Record opening balances
          </Button>
          {org.data?.settings.books_start_date && (
            <p className="text-xs text-zinc-500">
              Books start {fmtDate(org.data.settings.books_start_date)}.
            </p>
          )}
        </form>
      </Card>
    </>
  );
}

// ----------------------------------------------------------------------------- review policies

const ACTOR_OPTIONS = [
  ["mcp", "AI assistant (MCP)"],
  ["api_token", "API token"],
  ["rule", "Rule"],
  ["user", "Person"],
  ["*", "Anyone"],
] as const;

export function ReviewPolicies() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const { isOwner } = useRole();
  const org = useOrg();
  const q = useQuery({
    queryKey: ["policies", orgId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/review-policies", { params: { path: { orgId } } })).then(
        (r) => r.data,
      ),
  });
  const [actor, setActor] = useState<(typeof ACTOR_OPTIONS)[number][0]>("mcp");
  const [action, setAction] = useState<"auto_approve" | "require_review">("auto_approve");
  const [under, setUnder] = useState("100.00");
  const [knownOnly, setKnownOnly] = useState(true);
  const [catsOnly, setCatsOnly] = useState(true);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["policies", orgId] });
  const create = useMutation({
    mutationFn: () => {
      const amt = under.trim() ? tryParseCents(under) : null;
      return unwrap(
        api.POST("/api/v1/orgs/{orgId}/review-policies", {
          params: { path: { orgId } },
          body: {
            actor,
            action,
            priority: 100,
            name: null,
            condition: {
              ...(amt ? { amount_lt: amt } : {}),
              ...(catsOnly ? { item_types: ["bank_categorization" as const] } : {}),
              ...(knownOnly ? { account_used_for_payee: true } : {}),
            },
          },
        }),
      );
    },
    onSuccess: invalidate,
  });
  const del = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE("/api/v1/orgs/{orgId}/review-policies/{policyId}", {
          params: { path: { orgId, policyId: id } },
        }),
      ),
    onSuccess: invalidate,
  });
  const describe = (c: Record<string, unknown>) => {
    const parts: string[] = [];
    if (typeof c.amount_lt === "number") parts.push(`under ${money(c.amount_lt)}`);
    if (typeof c.amount_gte === "number") parts.push(`at least ${money(c.amount_gte)}`);
    if (Array.isArray(c.item_types))
      parts.push((c.item_types as string[]).map((t) => t.replace("_", " ")).join(", "));
    if (c.account_used_for_payee) parts.push("to accounts used for this payee before");
    return parts.join(", ") || "everything";
  };
  return (
    <Card title="Review policies">
      <div className="space-y-4 text-sm">
        <p className="text-zinc-600 dark:text-zinc-400">
          Built-in defaults: people and API tokens auto-approve; rules auto-approve only with auto-post on; AI
          assistants always need review. Anything at or over{" "}
          {money(org.data?.settings.review_threshold ?? 250000)} (the review threshold in General) needs
          review from anyone, and policies below cannot override that.
        </p>
        {q.isLoading ? (
          <Loading />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {(q.data ?? []).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <span>
                  <Badge tone={p.action === "auto_approve" ? "green" : "amber"}>
                    {p.action === "auto_approve" ? "Auto-approve" : "Require review"}
                  </Badge>{" "}
                  {ACTOR_OPTIONS.find(([k]) => k === p.actor)?.[1] ?? p.actor}: {describe(p.condition)}
                </span>
                {isOwner && (
                  <Button size="sm" variant="ghost" onClick={() => del.mutate(p.id)}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
            {!q.data?.length && <li className="py-2 text-zinc-500">No custom policies.</li>}
          </ul>
        )}
        {isOwner && (
          <form
            className="grid gap-3 rounded-md border border-zinc-200 p-3 sm:grid-cols-2 dark:border-zinc-700"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Who">
              {(id) => (
                <select
                  id={id}
                  className="rounded-md bg-white px-3 py-2 ring-1 ring-zinc-300 dark:bg-zinc-900 dark:ring-zinc-700"
                  value={actor}
                  onChange={(e) => setActor(e.target.value as typeof actor)}
                >
                  {ACTOR_OPTIONS.map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Decision">
              {(id) => (
                <select
                  id={id}
                  className="rounded-md bg-white px-3 py-2 ring-1 ring-zinc-300 dark:bg-zinc-900 dark:ring-zinc-700"
                  value={action}
                  onChange={(e) => setAction(e.target.value as typeof action)}
                >
                  <option value="auto_approve">Auto-approve</option>
                  <option value="require_review">Require review</option>
                </select>
              )}
            </Field>
            <Field label="When the amount is under (optional)">
              {(id) => (
                <Input id={id} inputMode="decimal" value={under} onChange={(e) => setUnder(e.target.value)} />
              )}
            </Field>
            <div className="space-y-1 self-end">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={catsOnly} onChange={(e) => setCatsOnly(e.target.checked)} />{" "}
                Bank categorizations only
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={knownOnly} onChange={(e) => setKnownOnly(e.target.checked)} />{" "}
                Only to accounts used for this payee before
              </label>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" size="sm" loading={create.isPending}>
                Add policy
              </Button>
              <ErrorText error={create.error ?? del.error} />
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
