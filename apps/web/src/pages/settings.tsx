import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError, api, rawFetch, unwrap } from "../api/client";
import type { components } from "../api/schema";
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
                <Input
                  id={id}
                  value={s.default_terms}
                  onChange={(e) => set({ default_terms: e.target.value })}
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

function OrgConnectionsTab() {
  const { isOwner } = useRole();
  return isOwner ? (
    <OrgConnections />
  ) : (
    <p className="text-sm text-zinc-500">Only owners can see connected apps.</p>
  );
}

export const settingsTabs: { value: string; label: string; render: () => ReactNode }[] = [
  { value: "general", label: "General", render: () => <General /> },
  { value: "members", label: "Members", render: () => <Members /> },
  { value: "business", label: "Business profile", render: () => <BusinessContext /> },
  { value: "lock", label: "Lock dates", render: () => <LockDates /> },
  { value: "integrity", label: "Integrity", render: () => <Integrity /> },
  { value: "policies", label: "Review policies", render: () => <ReviewPolicies /> },
  { value: "feeds", label: "Bank feeds", render: () => <PlaidKeys /> },
  { value: "ai", label: "AI connections", render: () => <OrgConnectionsTab /> },
  { value: "audit", label: "Audit log", render: () => <AuditLog /> },
  { value: "import", label: "Import & export", render: () => <ImportExport /> },
];

export function SettingsPage() {
  const [tab, setTab] = useState(settingsTabs[0]!.value);
  const current = settingsTabs.find((t) => t.value === tab) ?? settingsTabs[0]!;
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={settingsTabs.map((t) => ({ value: t.value, label: t.label }))}
      />
      {current.render()}
    </>
  );
}
