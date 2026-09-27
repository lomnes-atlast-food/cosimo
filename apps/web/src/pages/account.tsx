import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
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
  PageHeader,
  Select,
  Table,
  td,
  th,
} from "../components/ui";
import { fmtDateTime } from "../lib/format";
import { useRefreshSession, useSession } from "../lib/session";
import { MyConnections } from "./connect";

function Profile() {
  const { data } = useSession();
  const [name, setName] = useState(data?.user?.name ?? "");
  const refresh = useRefreshSession();
  const m = useMutation({
    mutationFn: () => unwrap(api.PATCH("/api/v1/auth/me", { body: { name } })),
    onSuccess: refresh,
  });
  return (
    <Card title="Profile">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Name" className="min-w-60 flex-1">
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Button type="submit" loading={m.isPending}>
          Save
        </Button>
      </form>
      <p className="mt-2 text-sm text-zinc-500">Email: {data?.user?.email}</p>
    </Card>
  );
}

function Password() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const m = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/api/v1/auth/password", { body: { current_password: cur, new_password: next } })),
    onSuccess: () => {
      setCur("");
      setNext("");
    },
  });
  return (
    <Card title="Password">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Current password">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              value={cur}
              onChange={(e) => setCur(e.target.value)}
            />
          )}
        </Field>
        <Field label="New password" hint="At least 10 characters. Other sessions are signed out.">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          )}
        </Field>
        <div className="sm:col-span-2">
          <ErrorText error={m.error} />
          {m.isSuccess && <Alert kind="success">Password changed.</Alert>}
          <Button type="submit" loading={m.isPending} className="mt-2">
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TwoFactor() {
  const { data } = useSession();
  const refresh = useRefreshSession();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const begin = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/auth/totp/setup")),
    onSuccess: setSetup,
  });
  const enable = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/auth/totp/enable", { body: { code } })),
    onSuccess: async (r) => {
      setCodes(r.recovery_codes);
      setSetup(null);
      setCode("");
      await refresh();
    },
  });
  const disable = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/auth/totp/disable", { body: { code } })),
    onSuccess: async () => {
      setCode("");
      await refresh();
    },
  });
  const enabled = data?.user?.totp_enabled;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Two-factor authentication {enabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}
        </span>
      }
    >
      {codes && (
        <Alert kind="warn">
          <p className="font-medium">Save these recovery codes. Each works once.</p>
          <pre className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">{codes.join("\n")}</pre>
        </Alert>
      )}
      {!enabled && !setup && (
        <Button onClick={() => begin.mutate()} loading={begin.isPending}>
          Set up two-factor
        </Button>
      )}
      {setup && (
        <div className="space-y-3">
          <p className="text-sm">
            Add this account to your authenticator app using the key below, then enter the 6-digit code.
          </p>
          <code className="block break-all rounded bg-zinc-100 p-2 font-mono text-sm dark:bg-zinc-800">
            {setup.secret}
          </code>
          <a className="text-sm text-brand-600 underline" href={setup.uri}>
            Open in authenticator app
          </a>
          <div className="flex items-end gap-2">
            <Field label="Code">
              {(id) => (
                <Input
                  id={id}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                />
              )}
            </Field>
            <Button onClick={() => enable.mutate()} loading={enable.isPending}>
              Enable
            </Button>
          </div>
          <ErrorText error={enable.error} />
        </div>
      )}
      {enabled && (
        <div className="flex items-end gap-2">
          <Field label="Code or recovery code">
            {(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
          <Button variant="danger" onClick={() => disable.mutate()} loading={disable.isPending}>
            Turn off
          </Button>
          <ErrorText error={disable.error} />
        </div>
      )}
    </Card>
  );
}

function Tokens() {
  const { data: session } = useSession();
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => unwrap(api.GET("/api/v1/tokens")) });
  const [orgId, setOrgId] = useState(session?.orgs[0]?.id ?? "");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"viewer" | "accountant" | "bookkeeper" | "owner">("bookkeeper");
  const [proposeOnly, setProposeOnly] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/api/v1/tokens", { body: { org_id: orgId, name, role, propose_only: proposeOnly } })),
    onSuccess: (r) => {
      setCreated(r.token);
      setName("");
      qc.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE("/api/v1/tokens/{tokenId}", { params: { path: { tokenId: id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens"] }),
  });
  const orgName = (id: string) => session?.orgs.find((o) => o.id === id)?.name ?? id;
  return (
    <Card title="Personal API tokens">
      <p className="mb-3 text-sm text-zinc-500">
        Tokens are scoped to one organization and a role no higher than yours. Use them with{" "}
        <code>Authorization: Bearer …</code> for the REST API or the MCP endpoint.
      </p>
      {created && (
        <Alert kind="success">
          Copy this token now; it will not be shown again:
          <code className="mt-1 block break-all font-mono text-xs">{created}</code>
        </Alert>
      )}
      <form
        className="my-3 grid gap-3 sm:grid-cols-5 sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Name" className="sm:col-span-2">
          {(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Organization">
          {(id) => (
            <Select id={id} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {session?.orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Role">
          {(id) => (
            <Select id={id} value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="viewer">Viewer</option>
              <option value="accountant">Accountant</option>
              <option value="bookkeeper">Bookkeeper</option>
              <option value="owner">Owner</option>
            </Select>
          )}
        </Field>
        <Button type="submit" loading={create.isPending} disabled={!orgId}>
          Create
        </Button>
        <label className="flex items-center gap-2 text-sm sm:col-span-5">
          <input type="checkbox" checked={proposeOnly} onChange={(e) => setProposeOnly(e.target.checked)} />
          Propose only: every write goes to the review queue
        </label>
      </form>
      <ErrorText error={create.error} />
      <Table>
        <thead>
          <tr>
            <th className={th}>Name</th>
            <th className={th}>Org</th>
            <th className={th}>Role</th>
            <th className={th}>Last used</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody>
          {tokens.data?.data
            .filter((t) => !t.revoked_at)
            .map((t) => (
              <tr key={t.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className={td}>
                  {t.name} {t.propose_only && <Badge tone="amber">propose only</Badge>}
                </td>
                <td className={td}>{orgName(t.org_id)}</td>
                <td className={td}>{t.role}</td>
                <td className={td}>{fmtDateTime(t.last_used_at) || "never"}</td>
                <td className={`${td} text-right`}>
                  <Button size="sm" variant="secondary" onClick={() => revoke.mutate(t.id)}>
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
        </tbody>
      </Table>
    </Card>
  );
}

export function AccountPage() {
  return (
    <PlainShell>
      <PageHeader title="Your account" />
      <div className="space-y-6">
        <Profile />
        <Password />
        <TwoFactor />
        <Tokens />
        <MyConnections />
      </div>
    </PlainShell>
  );
}
