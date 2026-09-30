import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError, api, rawFetch, unwrap } from "../api/client";
import type { components } from "../api/schema";
import { AccountSelect } from "../components/AccountSelect";
import { TermsSelect } from "../components/TermsSelect";
import {
  Alert,
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
  Tabs,
  Textarea,
  td,
  th,
} from "../components/ui";
import { fmtDateTime, money, tryParseCents } from "../lib/format";
import { useAccounts } from "../lib/ledger";
import { useOrg, useOrgId, useRole } from "../lib/org";
import { useRefreshSession, useSession } from "../lib/session";
import { BusinessContext } from "./business";
import { OrgConnections } from "./connect";
import { Integrity, LockDates, ReviewPolicies } from "./ledger-settings";
import { ImportExport } from "./operations";

type OrgSettings = components["schemas"]["OrgSettings"];

function LogoField({
  id,
  orgId,
  value,
  onChange,
}: {
  id: string;
  orgId: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const upload = async (f: File) => {
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      form.append("file", f);
      form.append("target_type", "org_settings");
      form.append("target_id", orgId);
      const res = await rawFetch(`/api/v1/orgs/${orgId}/attachments`, { method: "POST", body: form });
      const a = (await res.json()) as { id: string; mime_type: string };
      if (a.mime_type !== "image/png" && a.mime_type !== "image/jpeg")
        throw new Error("Use a PNG or JPEG image.");
      onChange(a.id);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-3">
      {value && (
        <img
          src={`/api/v1/orgs/${orgId}/attachments/${value}`}
          alt="Logo"
          className="h-10 max-w-32 rounded object-contain ring-1 ring-zinc-200"
        />
      )}
      <input
        id={id}
        type="file"
        accept="image/png,image/jpeg"
        disabled={busy}
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        className="text-sm"
      />
      {value && (
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          Remove
        </Button>
      )}
      <ErrorText error={err} />
    </div>
  );
}

function General() {
  const orgId = useOrgId();
  const org = useOrg();
  const qc = useQueryClient();
  const refresh = useRefreshSession();
  const { isOwner } = useRole();
  const [s, setS] = useState<OrgSettings | null>(null);
  const [name, setName] = useState("");
  const [threshold, setThreshold] = useState("");
  useEffect(() => {
    if (org.data) {
      setS(org.data.settings);
      setName(org.data.name);
      setThreshold((org.data.settings.review_threshold / 100).toFixed(2));
    }
  }, [org.data]);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/api/v1/orgs/{orgId}", {
          params: { path: { orgId } },
          body: {
            name,
            legal_name: s!.legal_name,
            dba: s!.dba || null,
            entity_type: s!.entity_type as never,
            tax_id_last4: s!.tax_id_last4 || null,
            address: s!.address,
            fiscal_year_start_month: s!.fiscal_year_start_month,
            default_basis: s!.default_basis,
            invoice_prefix: s!.invoice_prefix,
            next_invoice_number: s!.next_invoice_number,
            review_threshold: tryParseCents(threshold) ?? s!.review_threshold,
            invoice_color: s!.invoice_color,
            payment_instructions: s!.payment_instructions || null,
            default_terms: s!.default_terms,
            reminders_enabled: s!.reminders_enabled,
            logo_attachment_id: s!.logo_attachment_id,
          },
        }),
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["org", orgId] });
      await refresh();
    },
  });
  if (!s) return <Loading />;
  const set = (p: Partial<OrgSettings>) => setS({ ...s, ...p });
  const addr = s.address ?? {};
  const setAddr = (k: string, v: string) => set({ address: { ...addr, [k]: v } });
  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <fieldset disabled={!isOwner} className="space-y-6">
        <Card title="Business">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name">
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label="Legal name">
              {(id) => (
                <Input id={id} value={s.legal_name} onChange={(e) => set({ legal_name: e.target.value })} />
              )}
            </Field>
            <Field label="DBA">
              {(id) => <Input id={id} value={s.dba ?? ""} onChange={(e) => set({ dba: e.target.value })} />}
            </Field>
            <Field label="Tax ID (last 4 digits)">
              {(id) => (
                <Input
                  id={id}
                  maxLength={4}
                  value={s.tax_id_last4 ?? ""}
                  onChange={(e) => set({ tax_id_last4: e.target.value })}
                />
              )}
            </Field>
            <Field label="Street">
              {(id) => (
                <Input id={id} value={addr.line1 ?? ""} onChange={(e) => setAddr("line1", e.target.value)} />
              )}
            </Field>
            <Field label="City, state, postal code">
              {(id) => (
                <Input
                  id={id}
                  value={addr.city_line ?? ""}
                  onChange={(e) => setAddr("city_line", e.target.value)}
                />
              )}
            </Field>
            <Field label="Fiscal year starts">
              {(id) => (
                <Select
                  id={id}
                  value={s.fiscal_year_start_month}
                  onChange={(e) => set({ fiscal_year_start_month: Number(e.target.value) })}
                >
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {new Date(2000, i, 1).toLocaleString(undefined, { month: "long" })}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Default report basis">
              {(id) => (
                <Select
                  id={id}
                  value={s.default_basis}
                  onChange={(e) => set({ default_basis: e.target.value as "cash" | "accrual" })}
                >
                  <option value="cash">Cash</option>
                  <option value="accrual">Accrual</option>
                </Select>
              )}
            </Field>
            <Field label="Base currency" hint="Fixed in v1.">
              {(id) => <Input id={id} value={s.base_currency} disabled />}
            </Field>
            <Field
              label="Review threshold"
              hint="Entries at or above this amount always go to the review queue."
            >
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                />
              )}
            </Field>
          </div>
        </Card>
        <Card title="Invoices">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Number prefix">
              {(id) => (
                <Input
                  id={id}
                  value={s.invoice_prefix}
                  onChange={(e) => set({ invoice_prefix: e.target.value })}
                />
              )}
            </Field>
            <Field label="Next number">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  value={s.next_invoice_number}
                  onChange={(e) => set({ next_invoice_number: Number(e.target.value) })}
                />
              )}
            </Field>
            <Field label="Accent color">
              {(id) => (
                <Input
                  id={id}
                  type="color"
                  value={s.invoice_color}
                  onChange={(e) => set({ invoice_color: e.target.value })}
                  className="h-9 p-1"
                />
              )}
            </Field>
            <Field label="Default terms">
              {(id) => (
                <TermsSelect
                  id={id}
                  value={s.default_terms}
                  onChange={(v) => set({ default_terms: v })}
                  allowOnDueDate={false}
                />
              )}
            </Field>
            <Field label="Payment instructions" className="sm:col-span-2">
              {(id) => (
                <Textarea
                  id={id}
                  rows={3}
                  value={s.payment_instructions ?? ""}
                  onChange={(e) => set({ payment_instructions: e.target.value })}
                />
              )}
            </Field>
            <Field label="Logo (PNG or JPEG)" hint="Shown on invoice PDFs. Save to apply.">
              {(id) => (
                <LogoField
                  id={id}
                  orgId={orgId}
                  value={s.logo_attachment_id}
                  onChange={(v) => set({ logo_attachment_id: v })}
                />
              )}
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-3">
              <input
                type="checkbox"
                checked={s.reminders_enabled}
                onChange={(e) => set({ reminders_enabled: e.target.checked })}
              />
              Email reminders for overdue invoices
            </label>
          </div>
        </Card>
      </fieldset>
      <ErrorText error={save.error} />
      {save.isSuccess && <Alert kind="success">Saved.</Alert>}
      {isOwner ? (
        <Button type="submit" loading={save.isPending}>
          Save
        </Button>
      ) : (
        <p className="text-sm text-zinc-500">Only owners can change settings.</p>
      )}
      <p className="text-xs text-zinc-500">Current review threshold: {money(s.review_threshold)}</p>
    </form>
  );
}

function Members() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const { isOwner } = useRole();
  const { data: session } = useSession();
  const org = useOrg();
  const members = useQuery({
    queryKey: ["members", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/members", { params: { path: { orgId } } })),
  });
  const invites = useQuery({
    queryKey: ["invites", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/invitations", { params: { path: { orgId } } })),
    enabled: isOwner,
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "accountant" | "bookkeeper" | "owner">("bookkeeper");
  const [link, setLink] = useState<{ link?: string; emailed?: boolean } | null>(null);
  const invite = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/invitations", { params: { path: { orgId } }, body: { email, role } }),
      ),
    onSuccess: (r) => {
      setLink(r);
      setEmail("");
      qc.invalidateQueries({ queryKey: ["invites", orgId] });
    },
  });
  const change = useMutation({
    mutationFn: (v: { userId: string; role: typeof role }) =>
      unwrap(
        api.PATCH("/api/v1/orgs/{orgId}/members/{userId}", {
          params: { path: { orgId, userId: v.userId } },
          body: { role: v.role },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", orgId] }),
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      unwrap(api.DELETE("/api/v1/orgs/{orgId}/members/{userId}", { params: { path: { orgId, userId } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", orgId] }),
  });
  const lastOwnerError = [change.error, remove.error].find(
    (e): e is ApiError => e instanceof ApiError && e.code === "last_owner",
  );
  return (
    <div className="space-y-6">
      <Card title="Members">
        <ErrorText error={change.error || remove.error} />
        {lastOwnerError && org.data?.is_sample && (
          <Alert kind="info">Delete the demo organization instead (Danger zone below).</Alert>
        )}
        <Table>
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Email</th>
              <th className={th}>Role</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {members.data?.data.map((m) => (
              <tr key={m.user_id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className={td}>{m.name}</td>
                <td className={td}>{m.email}</td>
                <td className={td}>
                  {isOwner ? (
                    <Select
                      aria-label={`Role for ${m.email}`}
                      value={m.role}
                      onChange={(e) =>
                        change.mutate({ userId: m.user_id, role: e.target.value as typeof role })
                      }
                      className="w-36"
                    >
                      <option value="owner">Owner</option>
                      <option value="bookkeeper">Bookkeeper</option>
                      <option value="accountant">Accountant</option>
                      <option value="viewer">Viewer</option>
                    </Select>
                  ) : (
                    <Badge>{m.role}</Badge>
                  )}
                </td>
                <td className={`${td} text-right`}>
                  {(isOwner || m.user_id === session?.user?.id) && (
                    <Button size="sm" variant="secondary" onClick={() => remove.mutate(m.user_id)}>
                      {m.user_id === session?.user?.id ? "Leave" : "Remove"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {isOwner && (
        <Card title="Invite">
          <p className="mb-3 text-sm text-zinc-500">
            Bookkeepers can edit the books and approve reviews. Accountants (for your CPA) can read and export
            everything. Viewers see dashboards and reports.
          </p>
          {link?.link && (
            <Alert kind="success">
              {link.emailed ? "Invitation emailed. " : "Share this link (valid 7 days): "}
              <code className="break-all">{link.link}</code>
            </Alert>
          )}
          <form
            className="mt-3 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              invite.mutate();
            }}
          >
            <Field label="Email">
              {(id) => (
                <Input
                  id={id}
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>
            <Field label="Role">
              {(id) => (
                <Select id={id} value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                  <option value="bookkeeper">Bookkeeper</option>
                  <option value="accountant">Accountant</option>
                  <option value="viewer">Viewer</option>
                  <option value="owner">Owner</option>
                </Select>
              )}
            </Field>
            <Button type="submit" loading={invite.isPending}>
              Invite
            </Button>
          </form>
          <ErrorText error={invite.error} />
          {(invites.data?.data.length ?? 0) > 0 && (
            <ul className="mt-4 space-y-1 text-sm">
              {invites.data?.data.map((i) => (
                <li key={i.id}>
                  {i.email} <Badge>{i.role}</Badge>{" "}
                  <span className="text-zinc-500">expires {fmtDateTime(i.expires_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {isOwner && <DangerZone />}
    </div>
  );
}

/** Owner-only: permanently delete a demo org, or archive a real one. */
function DangerZone() {
  const orgId = useOrgId();
  const org = useOrg();
  const refresh = useRefreshSession();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const close = () => {
    setConfirming(false);
    setConfirmName("");
  };
  const deleteSample = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/orgs/{orgId}", { params: { path: { orgId }, query: { permanent: "true" } } }),
      ),
    onSuccess: async () => {
      await refresh();
      navigate({ to: "/" });
    },
  });
  const archive = useMutation({
    mutationFn: () => unwrap(api.DELETE("/api/v1/orgs/{orgId}", { params: { path: { orgId } } })),
    onSuccess: async () => {
      await refresh();
      navigate({ to: "/" });
    },
  });
  if (!org.data) return null;
  const isSample = org.data.is_sample;
  const mutation = isSample ? deleteSample : archive;
  const canConfirm = isSample || confirmName === org.data.name;
  return (
    <Card title="Danger zone">
      {isSample ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            This is a demo organization. Deleting it permanently removes its books; it isn't archived.
          </p>
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Delete demo organization
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Archiving removes this organization from your list. The data is kept; an instance admin can
            restore it from the CLI.
          </p>
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Archive organization
          </Button>
        </div>
      )}
      <Modal
        open={confirming}
        onClose={close}
        title={isSample ? "Delete demo organization" : "Archive organization"}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!canConfirm}
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {isSample ? "Delete permanently" : "Archive"}
            </Button>
          </>
        }
      >
        {isSample ? (
          <p className="text-sm">
            This permanently deletes "{org.data.name}" and all of its demo books. This can't be undone.
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            <p>
              Archiving "{org.data.name}" keeps its data but removes it from every member's list. An instance
              admin can restore it later with the CLI.
            </p>
            <Field label={`Type "${org.data.name}" to confirm`}>
              {(id) => <Input id={id} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />}
            </Field>
          </div>
        )}
        <ErrorText error={mutation.error} />
      </Modal>
    </Card>
  );
}

function AuditLog() {
  const orgId = useOrgId();
  const q = useQuery({
    queryKey: ["audit", orgId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/audit", { params: { path: { orgId }, query: { limit: 200 } } })),
  });
  if (q.isLoading) return <Loading />;
  return (
    <Card title="Audit log">
      <Table>
        <thead>
          <tr>
            <th className={th}>#</th>
            <th className={th}>When</th>
            <th className={th}>Actor</th>
            <th className={th}>Action</th>
            <th className={th}>Target</th>
          </tr>
        </thead>
        <tbody>
          {q.data?.data.map((a) => (
            <tr key={a.id} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className={`${td} num`}>{a.seq}</td>
              <td className={td}>{fmtDateTime(a.at)}</td>
              <td className={td}>{a.actor}</td>
              <td className={td}>
                <code className="text-xs">{a.action}</code>
              </td>
              <td className={`${td} text-xs text-zinc-500`}>
                {a.target_type} {a.target_id}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

/** Org-level Plaid keys (owner) that override the instance keys. The secret is write-only. */
function PlaidKeys() {
  const orgId = useOrgId();
  const org = useOrg();
  const qc = useQueryClient();
  const { isOwner } = useRole();
  const [env, setEnv] = useState<"sandbox" | "production">("sandbox");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const override = org.data?.settings.plaid_override;
  const save = useMutation({
    mutationFn: (plaid: { env: "sandbox" | "production"; client_id: string; secret: string } | null) =>
      unwrap(api.PATCH("/api/v1/orgs/{orgId}", { params: { path: { orgId } }, body: { plaid } })),
    onSuccess: async () => {
      setSecret("");
      setClientId("");
      await qc.invalidateQueries();
    },
  });
  if (!org.data) return <Loading />;
  return (
    <Card title="Plaid keys for this organization">
      <div className="space-y-4 text-sm">
        <p className="text-zinc-600 dark:text-zinc-400">
          Bank feeds normally use the instance's Plaid keys. An owner can use this organization's own Plaid
          account instead. Keys are encrypted and never shown again.
        </p>
        {override ? (
          <div className="flex items-center gap-3">
            <Badge tone="blue">Using this organization's keys ({org.data.settings.plaid_env})</Badge>
            {isOwner && (
              <Button
                size="sm"
                variant="secondary"
                loading={save.isPending}
                onClick={() => save.mutate(null)}
              >
                Remove and use instance keys
              </Button>
            )}
          </div>
        ) : (
          <p>Using the instance keys.</p>
        )}
        {isOwner && (
          <form
            className="grid gap-3 sm:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({ env, client_id: clientId, secret });
            }}
          >
            <Field label="Environment">
              {(id) => (
                <Select
                  id={id}
                  value={env}
                  onChange={(e) => setEnv(e.target.value as "sandbox" | "production")}
                >
                  <option value="sandbox">Sandbox</option>
                  <option value="production">Production</option>
                </Select>
              )}
            </Field>
            <Field label="Client ID">
              {(id) => <Input id={id} value={clientId} onChange={(e) => setClientId(e.target.value)} />}
            </Field>
            <Field label="Secret">
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              )}
            </Field>
            <div className="sm:col-span-3">
              <Button type="submit" disabled={!clientId || !secret} loading={save.isPending}>
                {override ? "Replace keys" : "Use these keys"}
              </Button>
            </div>
          </form>
        )}
        <ErrorText error={save.error} />
      </div>
    </Card>
  );
}

type PaymentMethod = "card" | "us_bank_account" | "customer_balance";
/** Labels are the Stripe dashboard's names (Settings → Payments → Payment methods). */
const PAYMENT_METHODS: { value: PaymentMethod; label: string; hint: string }[] = [
  { value: "card", label: "Cards", hint: "Typically 2.9% + 30¢ per payment." },
  {
    value: "us_bank_account",
    label: "ACH Direct Debit",
    hint: "Typically 0.8%, capped at $5. Takes a few days.",
  },
  {
    value: "customer_balance",
    label: "Bank Transfers",
    hint: "The customer wires or sends ACH to account details Stripe shows. Typically 0.5%, capped at $5.",
  },
];
const methodLabel = (m: PaymentMethod) => PAYMENT_METHODS.find((x) => x.value === m)?.label ?? m;

type SetupCheck = NonNullable<components["schemas"]["OnlinePaymentSettings"]["setup_check"]>;

/** What the last setup check found that needs fixing in Stripe, or null. */
function SetupProblems({ check }: { check: SetupCheck }) {
  const items: string[] = [];
  if (check.missing.length) items.push(`The key is missing permissions: ${check.missing.join(", ")}.`);
  if (check.inactive_methods.length)
    items.push(
      `Not active in Stripe: ${check.inactive_methods.map(methodLabel).join(", ")}. Checkouts leave them out until you activate them and test the connection again.`,
    );
  if (check.missing_events.length)
    items.push(`The webhook endpoint doesn't send: ${check.missing_events.join(", ")}.`);
  if (!items.length) return null;
  return (
    <Alert kind="warn">
      <p className="font-medium">Stripe setup needs attention (checked {fmtDateTime(check.checked_at)})</p>
      <ul className="mt-1 list-disc pl-5">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </Alert>
  );
}

/** Owner-only: online invoice payments through the org's own Stripe account, or a pasted link per invoice. */
function OnlinePayments() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const accounts = useAccounts(orgId);
  const q = useQuery({
    queryKey: ["online-payments", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/online-payments", { params: { path: { orgId } } })),
  });
  const [provider, setProvider] = useState<"off" | "manual_link" | "stripe">("off");
  const [key, setKey] = useState("");
  const [whsec, setWhsec] = useState("");
  const [methods, setMethods] = useState<PaymentMethod[]>(["card"]);
  const [clearing, setClearing] = useState("");
  const [fee, setFee] = useState("");
  const [refundAccount, setRefundAccount] = useState("");
  const [chargebackAccount, setChargebackAccount] = useState("");
  const [byDefault, setByDefault] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setProvider(q.data.provider);
    setMethods(q.data.methods);
    setClearing(q.data.clearing_account_id ?? "");
    setFee(q.data.fee_account_id ?? "");
    setRefundAccount(q.data.refund_account_id ?? "");
    setChargebackAccount(q.data.chargeback_account_id ?? "");
    setByDefault(q.data.online_pay_default);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/api/v1/orgs/{orgId}/online-payments", {
          params: { path: { orgId } },
          body: {
            provider,
            secret_key: key || undefined,
            webhook_secret: whsec || undefined,
            methods,
            clearing_account_id: clearing || null,
            fee_account_id: fee || null,
            refund_account_id: refundAccount || null,
            chargeback_account_id: chargebackAccount || null,
            online_pay_default: byDefault,
          },
        }),
      ),
    onSuccess: async () => {
      setKey("");
      setWhsec("");
      await qc.invalidateQueries({ queryKey: ["online-payments", orgId] });
      await qc.invalidateQueries({ queryKey: ["org", orgId] });
      await qc.invalidateQueries({ queryKey: ["accounts", orgId] });
    },
  });
  const test = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/online-payments/test", {
          params: { path: { orgId } },
          body: { secret_key: key || null },
        }),
      ),
    // Testing the stored key refreshes the stored check.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["online-payments", orgId] }),
  });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorText error={q.error} />;
  const d = q.data;
  const toggle = (m: PaymentMethod, on: boolean) =>
    setMethods((ms) => (on ? [...new Set([...ms, m])] : ms.filter((x) => x !== m)));
  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Card title="Online payments">
        <div className="space-y-4 text-sm">
          <p className="text-zinc-600 dark:text-zinc-400">
            Put a "Pay online" link on invoices. With Stripe, customers pay in your own Stripe account and
            Cosimo records the payment and Stripe's fee. With a payment link, you paste a URL from any payment
            service on each invoice and record payments yourself.
          </p>
          <Field label="Mode">
            {(id) => (
              <Select
                id={id}
                value={provider}
                onChange={(e) => setProvider(e.target.value as typeof provider)}
                className="max-w-xs"
              >
                <option value="off">Off</option>
                <option value="manual_link">Payment link</option>
                <option value="stripe">Stripe</option>
              </Select>
            )}
          </Field>
          {provider !== "off" && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={byDefault} onChange={(e) => setByDefault(e.target.checked)} />
              Accept online payment on new invoices by default
            </label>
          )}
        </div>
      </Card>
      {provider === "stripe" && (
        <Card
          title="Stripe"
          actions={
            d.secret_key_set && d.provider === "stripe" ? (
              <>
                {d.livemode === false && <Badge tone="amber">Test mode</Badge>}
                {d.account_name && <Badge tone="blue">{d.account_name}</Badge>}
              </>
            ) : null
          }
        >
          <div className="grid gap-4 text-sm sm:grid-cols-2">
            {d.provider === "stripe" && (d.setup_check || d.last_pay_error) && (
              <div className="space-y-2 sm:col-span-2">
                {d.setup_check && <SetupProblems check={d.setup_check} />}
                {d.last_pay_error && (
                  <Alert kind="error">
                    A pay link failed{d.last_pay_error.at ? ` ${fmtDateTime(d.last_pay_error.at)}` : ""}{" "}
                    (invoice{" "}
                    <Link
                      to="/o/$orgId/sales/invoices/$invoiceId"
                      params={{ orgId, invoiceId: d.last_pay_error.invoice_id }}
                      className="font-medium underline"
                    >
                      {d.last_pay_error.number}
                    </Link>
                    ): {d.last_pay_error.message}
                  </Alert>
                )}
              </div>
            )}
            <Field
              label="Secret or restricted key"
              hint={
                d.secret_key_set
                  ? "A key is stored. Enter a new one to replace it."
                  : "sk_... or rk_... from the Stripe dashboard. Encrypted, never shown again."
              }
            >
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={d.secret_key_set ? "••••••••" : "rk_live_..."}
                />
              )}
            </Field>
            <div className="flex items-end">
              <Button
                variant="secondary"
                loading={test.isPending}
                disabled={!key && !d.secret_key_set}
                onClick={() => test.mutate()}
              >
                Test connection
              </Button>
            </div>
            {test.data && (
              <div className="space-y-2 sm:col-span-2">
                <Alert kind="success">
                  Connected to {test.data.account_name} ({test.data.livemode ? "live mode" : "test mode"}).
                </Alert>
                <ul className="space-y-1">
                  {test.data.permissions.map((p) => (
                    <li key={p.name} className="flex flex-wrap items-center gap-2">
                      <Badge tone={p.ok ? "green" : p.ok === false ? "red" : "zinc"}>
                        {p.ok ? "OK" : p.ok === false ? "Missing" : "Couldn't check"}
                      </Badge>
                      {p.name}
                      {p.ok !== true && p.detail && (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">{p.detail}</span>
                      )}
                    </li>
                  ))}
                  {test.data.methods.map((m) => (
                    <li key={m.type} className="flex flex-wrap items-center gap-2">
                      <Badge
                        tone={m.status === "active" ? "green" : m.status === "unknown" ? "zinc" : "amber"}
                      >
                        {m.status === "active"
                          ? "Active"
                          : m.status === "inactive"
                            ? "Not active"
                            : m.status === "pending"
                              ? "Pending"
                              : "Unknown"}
                      </Badge>
                      {methodLabel(m.type)}
                      {m.detail && (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">{m.detail}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="sm:col-span-2">
              <ErrorText error={test.error} />
            </div>
            <fieldset className="space-y-2 sm:col-span-2">
              <legend className="mb-1 text-sm font-medium">Payment methods</legend>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Each must be active in Stripe → Settings → Payments → Payment methods, in the same mode as the
                key.
              </p>
              {PAYMENT_METHODS.map((m) => (
                <label key={m.value} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={methods.includes(m.value)}
                    onChange={(e) => toggle(m.value, e.target.checked)}
                  />
                  <span>
                    {m.label}{" "}
                    {d.setup_check?.inactive_methods.includes(m.value) && (
                      <Badge tone="amber">Not active in Stripe</Badge>
                    )}{" "}
                    <span className="text-xs text-zinc-500">{m.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <Field
              label="Clearing account"
              hint="Payments land here until Stripe pays out. Empty: Stripe Clearing."
            >
              {(id) => (
                <AccountSelect
                  id={id}
                  accounts={accounts.data ?? []}
                  types={["asset"]}
                  value={clearing}
                  onChange={setClearing}
                  placeholder="Create Stripe Clearing"
                />
              )}
            </Field>
            <Field label="Fee account" hint="Stripe's fees. Empty: Bank and Merchant Fees.">
              {(id) => (
                <AccountSelect
                  id={id}
                  accounts={accounts.data ?? []}
                  types={["expense"]}
                  value={fee}
                  onChange={setFee}
                  placeholder="Bank and Merchant Fees"
                />
              )}
            </Field>
            <Field
              label="Refunds account"
              hint="Refunds issued in Stripe are proposed against this account. Empty: Refunds and Allowances."
            >
              {(id) => (
                <AccountSelect
                  id={id}
                  accounts={accounts.data ?? []}
                  types={["income", "expense"]}
                  value={refundAccount}
                  onChange={setRefundAccount}
                  placeholder="Refunds and Allowances"
                />
              )}
            </Field>
            <Field
              label="Chargebacks account"
              hint="Amounts Stripe takes back for disputes. Empty: Chargebacks."
            >
              {(id) => (
                <AccountSelect
                  id={id}
                  accounts={accounts.data ?? []}
                  types={["expense"]}
                  value={chargebackAccount}
                  onChange={setChargebackAccount}
                  placeholder="Chargebacks"
                />
              )}
            </Field>
            <div className="space-y-2 sm:col-span-2">
              <p>
                {d.provider !== "stripe" || !d.secret_key_set ? (
                  d.webhook_url ? (
                    "Cosimo will register a webhook in your Stripe account when you save."
                  ) : (
                    "This instance has no public HTTPS address, so Cosimo will check Stripe for payments every 15 minutes."
                  )
                ) : d.webhook_mode === "registered" ? (
                  <Badge tone="green">Webhook registered</Badge>
                ) : d.webhook_mode === "manual" ? (
                  <Badge tone="green">Webhook secret entered</Badge>
                ) : (
                  <Badge tone="zinc">No webhook: checking every 15 minutes</Badge>
                )}{" "}
                {d.last_event_at && (
                  <span className="text-xs text-zinc-500">Last event {fmtDateTime(d.last_event_at)}</span>
                )}
              </p>
              {d.webhook_url && d.webhook_mode !== "registered" && (
                <Field
                  label="Webhook signing secret (optional)"
                  hint={`If Cosimo couldn't register the webhook, add an endpoint for ${d.webhook_url} in the Stripe dashboard with the events ${d.webhook_events.join(", ")}, and paste its signing secret (whsec_...).`}
                >
                  {(id) => (
                    <Input
                      id={id}
                      type="password"
                      autoComplete="off"
                      value={whsec}
                      onChange={(e) => setWhsec(e.target.value)}
                    />
                  )}
                </Field>
              )}
            </div>
          </div>
        </Card>
      )}
      <ErrorText error={save.error} />
      {save.data?.warning && <Alert kind="warn">{save.data.warning}</Alert>}
      {save.isSuccess && !save.data?.warning && <Alert kind="success">Saved.</Alert>}
      <Button
        type="submit"
        loading={save.isPending}
        disabled={provider === "stripe" && !key && !d.secret_key_set}
      >
        Save
      </Button>
    </form>
  );
}

function OrgConnectionsTab() {
  const { isOwner } = useRole();
  return isOwner ? (
    <OrgConnections />
  ) : (
    <p className="text-sm text-zinc-500">Only owners can see connected apps.</p>
  );
}

export const settingsTabs: { value: string; label: string; render: () => ReactNode; ownerOnly?: boolean }[] =
  [
    { value: "general", label: "General", render: () => <General /> },
    { value: "members", label: "Members", render: () => <Members /> },
    { value: "business", label: "Business profile", render: () => <BusinessContext /> },
    { value: "lock", label: "Lock dates", render: () => <LockDates /> },
    { value: "integrity", label: "Integrity", render: () => <Integrity /> },
    { value: "policies", label: "Review policies", render: () => <ReviewPolicies /> },
    { value: "feeds", label: "Bank feeds", render: () => <PlaidKeys /> },
    { value: "payments", label: "Online payments", render: () => <OnlinePayments />, ownerOnly: true },
    { value: "ai", label: "AI connections", render: () => <OrgConnectionsTab /> },
    { value: "audit", label: "Audit log", render: () => <AuditLog /> },
    { value: "import", label: "Import & export", render: () => <ImportExport /> },
  ];

export function SettingsPage() {
  const { isOwner } = useRole();
  const tabs = settingsTabs.filter((t) => isOwner || !t.ownerOnly);
  const [tab, setTab] = useState(settingsTabs[0]!.value);
  const current = tabs.find((t) => t.value === tab) ?? tabs[0]!;
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs
        value={current.value}
        onChange={setTab}
        tabs={tabs.map((t) => ({ value: t.value, label: t.label }))}
      />
      {current.render()}
    </>
  );
}
