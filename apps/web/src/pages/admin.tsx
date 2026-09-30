import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, unwrap } from "../api/client";
import { PlainShell } from "../components/Shell";
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
  Select,
  Table,
  Tabs,
  td,
  th,
} from "../components/ui";
import { fmtDateTime } from "../lib/format";
import { OAuthClients } from "./connect";
import { AdminStatus } from "./operations";

function Users() {
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => unwrap(api.GET("/api/v1/admin/users")),
  });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/api/v1/admin/users", { body: { email, name, is_instance_admin: false } })),
    onSuccess: (r) => {
      setLink(r.claim_link);
      setEmail("");
      setName("");
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });
  const update = useMutation({
    mutationFn: (v: { id: string; disabled?: boolean; is_instance_admin?: boolean }) =>
      unwrap(api.PATCH("/api/v1/admin/users/{userId}", { params: { path: { userId: v.id } }, body: v })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });
  const claim = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST("/api/v1/admin/users/{userId}/claim-link", { params: { path: { userId: id } } })),
    onSuccess: (r) => setLink(r.claim_link),
  });
  if (users.isLoading) return <Loading />;
  return (
    <Card title="Users">
      {link && (
        <Alert kind="success">
          Share this one-time link (valid 24 hours): <code className="break-all">{link}</code>
        </Alert>
      )}
      <form
        className="my-3 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Email">
          {(id) => (
            <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          )}
        </Field>
        <Field label="Name">
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Button type="submit" loading={create.isPending}>
          Add user
        </Button>
      </form>
      <ErrorText error={create.error || update.error} />
      <Table>
        <thead>
          <tr>
            <th className={th}>Email</th>
            <th className={th}>Name</th>
            <th className={th}>Status</th>
            <th className={th}>Created</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody>
          {users.data?.data.map((u) => (
            <tr key={u.id} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className={td}>{u.email}</td>
              <td className={td}>{u.name}</td>
              <td className={`${td} space-x-1`}>
                {u.is_instance_admin && <Badge tone="blue">admin</Badge>}
                {u.totp_enabled && <Badge tone="green">2FA</Badge>}
                {!u.has_password && <Badge tone="amber">unclaimed</Badge>}
                {u.disabled_at && <Badge tone="red">disabled</Badge>}
              </td>
              <td className={td}>{fmtDateTime(u.created_at)}</td>
              <td className={`${td} space-x-1 whitespace-nowrap text-right`}>
                <Button size="sm" variant="secondary" onClick={() => claim.mutate(u.id)}>
                  New link
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => update.mutate({ id: u.id, disabled: !u.disabled_at })}
                >
                  {u.disabled_at ? "Enable" : "Disable"}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

type Settings = Awaited<ReturnType<typeof loadSettings>>;
const loadSettings = () => unwrap(api.GET("/api/v1/admin/settings"));

function InstanceSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-settings"], queryFn: loadSettings });
  const [s, setS] = useState<Settings | null>(null);
  const [smtpPw, setSmtpPw] = useState("");
  const [plaidSecret, setPlaidSecret] = useState("");
  useEffect(() => {
    if (q.data) setS(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/api/v1/admin/settings", {
          body: {
            signup_mode: s!.signup_mode,
            dynamic_client_registration: s!.dynamic_client_registration,
            smtp: { ...s!.smtp, password: smtpPw || undefined },
            plaid: { ...s!.plaid, secret: plaidSecret || undefined },
          },
        }),
      ),
    onSuccess: (r) => {
      setSmtpPw("");
      setPlaidSecret("");
      qc.setQueryData(["admin-settings"], r);
    },
  });
  if (!s) return <Loading />;
  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });
  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {s.warnings.map((w) => (
        <Alert key={w} kind="warn">
          {w}
        </Alert>
      ))}
      <Card title="Access">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Who can create accounts?">
            {(id) => (
              <Select
                id={id}
                value={s.signup_mode}
                onChange={(e) => set({ signup_mode: e.target.value as Settings["signup_mode"] })}
              >
                <option value="single_user">Single user</option>
                <option value="invite_only">Invite only</option>
                <option value="open">Open signup (anyone)</option>
              </Select>
            )}
          </Field>
          <label className="flex items-center gap-2 self-end text-sm">
            <input
              type="checkbox"
              checked={s.dynamic_client_registration}
              onChange={(e) => set({ dynamic_client_registration: e.target.checked })}
            />
            Allow AI clients to register themselves (OAuth dynamic client registration)
          </label>
        </div>
      </Card>
      <Card title="Email (SMTP)">
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm sm:col-span-3">
            <input
              type="checkbox"
              checked={s.smtp.enabled}
              onChange={(e) => set({ smtp: { ...s.smtp, enabled: e.target.checked } })}
            />
            Send email (invoices, invitations, password resets)
          </label>
          <Field label="Host">
            {(id) => (
              <Input
                id={id}
                value={s.smtp.host}
                onChange={(e) => set({ smtp: { ...s.smtp, host: e.target.value } })}
              />
            )}
          </Field>
          <Field label="Port">
            {(id) => (
              <Input
                id={id}
                type="number"
                value={s.smtp.port}
                onChange={(e) => set({ smtp: { ...s.smtp, port: Number(e.target.value) } })}
              />
            )}
          </Field>
          <Field label="From">
            {(id) => (
              <Input
                id={id}
                value={s.smtp.from}
                onChange={(e) => set({ smtp: { ...s.smtp, from: e.target.value } })}
              />
            )}
          </Field>
          <Field label="Username">
            {(id) => (
              <Input
                id={id}
                value={s.smtp.user}
                onChange={(e) => set({ smtp: { ...s.smtp, user: e.target.value } })}
              />
            )}
          </Field>
          <Field label="Password" hint={s.smtp.password_set ? "Saved. Leave blank to keep." : undefined}>
            {(id) => (
              <Input id={id} type="password" value={smtpPw} onChange={(e) => setSmtpPw(e.target.value)} />
            )}
          </Field>
          <label className="flex items-center gap-2 self-end text-sm">
            <input
              type="checkbox"
              checked={s.smtp.secure}
              onChange={(e) => set({ smtp: { ...s.smtp, secure: e.target.checked } })}
            />
            TLS (port 465)
          </label>
        </div>
      </Card>
      <Card title="Plaid (bring your own keys)">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={s.plaid.enabled}
              onChange={(e) => set({ plaid: { ...s.plaid, enabled: e.target.checked } })}
            />
            Enable bank feeds through Plaid
          </label>
          <Field label="Environment">
            {(id) => (
              <Select
                id={id}
                value={s.plaid.env}
                onChange={(e) =>
                  set({ plaid: { ...s.plaid, env: e.target.value as "sandbox" | "production" } })
                }
              >
                <option value="sandbox">Sandbox</option>
                <option value="production">Production</option>
              </Select>
            )}
          </Field>
          <Field label="Client ID">
            {(id) => (
              <Input
                id={id}
                value={s.plaid.client_id}
                onChange={(e) => set({ plaid: { ...s.plaid, client_id: e.target.value } })}
              />
            )}
          </Field>
          <Field label="Secret" hint={s.plaid.secret_set ? "Saved. Leave blank to keep." : undefined}>
            {(id) => (
              <Input
                id={id}
                type="password"
                value={plaidSecret}
                onChange={(e) => setPlaidSecret(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Public URL for webhooks (optional)"
            hint="An HTTPS base URL Plaid can reach, e.g. https://books.example.com. Defaults to the server's public URL when it is HTTPS. Polling runs every 6 hours regardless."
          >
            {(id) => (
              <Input
                id={id}
                value={s.plaid.webhook_url}
                onChange={(e) => set({ plaid: { ...s.plaid, webhook_url: e.target.value } })}
              />
            )}
          </Field>
          <Field
            label="OAuth redirect URI (optional)"
            hint="Some banks sign in through their own site. Register this URI in the Plaid dashboard, e.g. https://books.example.com/plaid/oauth."
          >
            {(id) => (
              <Input
                id={id}
                value={s.plaid.redirect_uri}
                onChange={(e) => set({ plaid: { ...s.plaid, redirect_uri: e.target.value } })}
              />
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={s.plaid.refresh_enabled}
              onChange={(e) => set({ plaid: { ...s.plaid, refresh_enabled: e.target.checked } })}
            />
            Allow AI assistants to ask Plaid for a fresh pull (/transactions/refresh, billed separately by
            Plaid)
          </label>
          <Field
            label="Minimum seconds between assistant-requested syncs"
            hint="Syncs from the app, webhooks, and polling aren't limited."
          >
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                value={s.plaid.sync_cooldown_seconds}
                onChange={(e) =>
                  set({
                    plaid: {
                      ...s.plaid,
                      sync_cooldown_seconds: Math.max(0, Math.round(Number(e.target.value) || 0)),
                    },
                  })
                }
              />
            )}
          </Field>
        </div>
      </Card>
      <ErrorText error={save.error} />
      {save.isSuccess && <Alert kind="success">Saved.</Alert>}
      <Button type="submit" loading={save.isPending}>
        Save settings
      </Button>
      <TestEmail />
    </form>
  );
}

function TestEmail() {
  const [to, setTo] = useState("");
  const send = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/admin/settings/test-email", { body: { to } })),
  });
  return (
    <Card title="Test email">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Send a test email to"
          type="email"
          placeholder="you@example.com"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="max-w-xs"
        />
        <Button variant="secondary" loading={send.isPending} disabled={!to} onClick={() => send.mutate()}>
          Send test email
        </Button>
        {send.isSuccess && <span className="text-sm text-emerald-700 dark:text-emerald-400">Sent.</span>}
      </div>
      <p className="mt-2 text-xs text-zinc-500">Uses the saved settings, so save first.</p>
      <div className="mt-2">
        <ErrorText error={send.error} />
      </div>
    </Card>
  );
}

export function AdminPage() {
  const [tab, setTab] = useState<"users" | "settings" | "status">("users");
  return (
    <PlainShell>
      <PageHeader title="Instance administration" />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "users", label: "Users" },
          { value: "settings", label: "Settings" },
          { value: "status", label: "Status" },
        ]}
      />
      {tab === "users" && <Users />}
      {tab === "settings" && (
        <div className="space-y-6">
          <InstanceSettings />
          <OAuthClients />
        </div>
      )}
      {tab === "status" && <AdminStatus />}
    </PlainShell>
  );
}
