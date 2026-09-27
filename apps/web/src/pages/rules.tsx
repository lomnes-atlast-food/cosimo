import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  Select,
  Table,
  td,
  th,
} from "../components/ui";
import { type Rule, useBankAccounts } from "../lib/banking";
import { centsToDecimal, money, tryParseCents } from "../lib/format";
import { useAccounts } from "../lib/ledger";
import { useOrgId, useRole } from "../lib/org";

function describeConditions(r: Rule, bankName: (id: string) => string) {
  const c = r.conditions;
  const parts: string[] = [];
  if (c.description_contains) parts.push(`contains "${c.description_contains}"`);
  if (c.description_regex) parts.push(`matches /${c.description_regex}/`);
  if (c.direction) parts.push(c.direction === "in" ? "money in" : "money out");
  if (c.amount_eq != null) parts.push(`= ${money(c.amount_eq)}`);
  if (c.amount_min != null) parts.push(`≥ ${money(c.amount_min)}`);
  if (c.amount_max != null) parts.push(`≤ ${money(c.amount_max)}`);
  if (c.bank_account_id) parts.push(`in ${bankName(c.bank_account_id)}`);
  return parts.join(", ");
}

export function RulesPage() {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const rules = useQuery({
    queryKey: ["rules", orgId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/rules", { params: { path: { orgId } } })).then((r) => r.data),
  });
  const accounts = useAccounts(orgId);
  const banks = useBankAccounts(orgId);
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const acctName = (id?: string | null) => (id ? (accounts.data?.find((a) => a.id === id)?.name ?? "?") : "");
  const bankName = (id: string) => banks.data?.find((b) => b.id === id)?.name ?? "?";
  return (
    <>
      <PageHeader
        title="Rules"
        subtitle="Applied to newly imported transactions, lowest priority number first. Rules without auto-post only suggest; their categorizations wait in the review queue."
        actions={canWrite && <Button onClick={() => setEditing("new")}>New rule</Button>}
      />
      <ErrorText error={rules.error} />
      {rules.isLoading ? (
        <Loading />
      ) : !rules.data?.length ? (
        <Card>
          <p className="text-sm text-zinc-500">
            No rules yet. Create one here or tick "Create a rule from this" when categorizing.
          </p>
        </Card>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <th className={th}>#</th>
                <th className={th}>Name</th>
                <th className={th}>When</th>
                <th className={th}>Then</th>
                <th className={`${th} text-right`}>Applied</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rules.data.map((r) => (
                <tr key={r.id} className={r.is_active ? "" : "opacity-60"}>
                  <td className={`${td} num text-zinc-500`}>{r.priority}</td>
                  <td className={td}>
                    {canWrite ? (
                      <button type="button" className="hover:underline" onClick={() => setEditing(r)}>
                        {r.name}
                      </button>
                    ) : (
                      r.name
                    )}{" "}
                    {!r.is_active && (
                      <Badge tone="amber">{r.created_by_actor === "mcp" ? "Awaiting review" : "Off"}</Badge>
                    )}
                  </td>
                  <td className={`${td} text-zinc-600 dark:text-zinc-400`}>
                    {describeConditions(r, bankName)}
                  </td>
                  <td className={td}>
                    {r.actions.transfer_account_id
                      ? `Transfer ↔ ${acctName(r.actions.transfer_account_id)}`
                      : acctName(r.actions.account_id)}
                    {r.actions.memo && <span className="text-zinc-500"> · memo "{r.actions.memo}"</span>}{" "}
                    {r.actions.auto_post ? <Badge tone="green">Auto-post</Badge> : <Badge>Suggest</Badge>}
                  </td>
                  <td className={`${td} text-right num`}>{r.times_applied}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {editing && <RuleForm rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RuleForm({ rule, onClose }: { rule: Rule | null; onClose: () => void }) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const accounts = useAccounts(orgId);
  const banks = useBankAccounts(orgId);
  const c = rule?.conditions ?? {};
  const a = rule?.actions ?? {};
  const [f, setF] = useState({
    name: rule?.name ?? "",
    priority: String(rule?.priority ?? 100),
    is_active: rule?.is_active ?? true,
    match: c.description_regex ? "regex" : "contains",
    text: c.description_regex ?? c.description_contains ?? "",
    direction: c.direction ?? "",
    amount_min: c.amount_min != null ? centsToDecimal(c.amount_min) : "",
    amount_max: c.amount_max != null ? centsToDecimal(c.amount_max) : "",
    bank_account_id: c.bank_account_id ?? "",
    kind: a.transfer_account_id ? "transfer" : "category",
    account_id: a.transfer_account_id ?? a.account_id ?? "",
    memo: a.memo ?? "",
    auto_post: a.auto_post ?? false,
  });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ["rules", orgId] });
    onClose();
  };
  const body = () => ({
    name: f.name,
    priority: Number(f.priority) || 100,
    is_active: f.is_active,
    conditions: {
      description_contains: f.match === "contains" ? f.text || null : null,
      description_regex: f.match === "regex" ? f.text || null : null,
      direction: (f.direction || null) as "in" | "out" | null,
      amount_min: f.amount_min ? tryParseCents(f.amount_min) : null,
      amount_max: f.amount_max ? tryParseCents(f.amount_max) : null,
      bank_account_id: f.bank_account_id || null,
    },
    actions: {
      account_id: f.kind === "category" ? f.account_id || null : null,
      transfer_account_id: f.kind === "transfer" ? f.account_id || null : null,
      memo: f.memo || null,
      auto_post: f.auto_post,
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      await (rule
        ? unwrap(
            api.PATCH("/api/v1/orgs/{orgId}/rules/{ruleId}", {
              params: { path: { orgId, ruleId: rule.id } },
              body: body(),
            }),
          )
        : unwrap(api.POST("/api/v1/orgs/{orgId}/rules", { params: { path: { orgId } }, body: body() })));
    },
    onSuccess: done,
  });
  const del = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/orgs/{orgId}/rules/{ruleId}", { params: { path: { orgId, ruleId: rule!.id } } }),
      ),
    onSuccess: done,
  });
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={rule ? `Edit rule: ${rule.name}` : "New rule"}
      footer={
        <>
          {rule && (
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
          <Button loading={save.isPending} disabled={!f.name} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <Field label="Name">
            {(id) => <Input id={id} value={f.name} onChange={(e) => set({ name: e.target.value })} />}
          </Field>
          <Field label="Priority">
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={f.priority}
                onChange={(e) => set({ priority: e.target.value })}
              />
            )}
          </Field>
        </div>
        <fieldset className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
          <legend className="px-1 text-sm font-medium">When a transaction…</legend>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Select aria-label="Match type" value={f.match} onChange={(e) => set({ match: e.target.value })}>
              <option value="contains">contains</option>
              <option value="regex">matches pattern</option>
            </Select>
            <Input
              aria-label="Text"
              value={f.text}
              onChange={(e) => set({ text: e.target.value })}
              placeholder={f.match === "regex" ? "^UBER\\b" : "uber"}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Direction">
              {(id) => (
                <Select id={id} value={f.direction} onChange={(e) => set({ direction: e.target.value })}>
                  <option value="">Either</option>
                  <option value="out">Money out</option>
                  <option value="in">Money in</option>
                </Select>
              )}
            </Field>
            <Field label="Amount from">
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={f.amount_min}
                  onChange={(e) => set({ amount_min: e.target.value })}
                />
              )}
            </Field>
            <Field label="Amount to">
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={f.amount_max}
                  onChange={(e) => set({ amount_max: e.target.value })}
                />
              )}
            </Field>
            <Field label="Bank account">
              {(id) => (
                <Select
                  id={id}
                  value={f.bank_account_id}
                  onChange={(e) => set({ bank_account_id: e.target.value })}
                >
                  <option value="">Any</option>
                  {(banks.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </fieldset>
        <fieldset className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
          <legend className="px-1 text-sm font-medium">Then…</legend>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Select
              aria-label="Action"
              value={f.kind}
              onChange={(e) => set({ kind: e.target.value, account_id: "" })}
            >
              <option value="category">categorize as</option>
              <option value="transfer">transfer to/from</option>
            </Select>
            <AccountSelect
              aria-label="Account"
              accounts={accounts.data ?? []}
              types={f.kind === "transfer" ? ["asset", "liability"] : undefined}
              value={f.account_id}
              onChange={(id) => set({ account_id: id })}
            />
          </div>
          <Field label="Memo (optional)">
            {(id) => <Input id={id} value={f.memo} onChange={(e) => set({ memo: e.target.value })} />}
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={f.auto_post}
              onChange={(e) => set({ auto_post: e.target.checked })}
            />
            Auto-post (skip the review queue; amounts at or over the review threshold still wait)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={f.is_active}
              onChange={(e) => set({ is_active: e.target.checked })}
            />
            Active
          </label>
        </fieldset>
        <ErrorText error={save.error ?? del.error} />
      </div>
    </Modal>
  );
}
