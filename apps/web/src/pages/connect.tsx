/**
 * AI connections (SPEC §10.4): the OAuth consent screen at /connect, connected apps for the
 * signed-in user and for an org's owners, and manual OAuth clients for instance admins.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
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
  Select,
  Table,
  td,
  th,
} from "../components/ui";
import { fmtDateTime } from "../lib/format";
import { useOrgId } from "../lib/org";
import { useSession } from "../lib/session";

const ROLE_HELP: Record<string, string> = {
  owner: "Owner: everything, but its changes still go to your review queue",
  bookkeeper: "Bookkeeper: proposes categorizations, entries, rules, and invoice drafts for your review",
  accountant: "Accountant: read-only, including reports and the audit log",
  viewer: "Viewer: read-only",
};

/** Only same-site paths may be used as a post-login destination. */
export function safeNext(v: string | null | undefined) {
  return v?.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : "/";
}

export function ConnectPage() {
  const session = useSession();
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(window.location.search)), []);
  const signedIn = Boolean(session.data?.user);
  useEffect(() => {
    if (!session.isLoading && !signedIn)
      window.location.replace(
        `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
      );
  }, [session.isLoading, signedIn]);
  const info = useQuery({
    queryKey: ["oauth-consent", params],
    enabled: signedIn,
    retry: false,
    queryFn: () => unwrap(api.GET("/api/v1/oauth/consent", { params: { query: params as never } })),
  });
  const [orgId, setOrgId] = useState("");
  const [role, setRole] = useState("bookkeeper");
  const org = info.data?.orgs.find((o) => o.id === (orgId || info.data?.orgs[0]?.id));
  useEffect(() => {
    if (org && !org.grantable_roles.includes(role))
      setRole(
        org.grantable_roles.includes("bookkeeper") ? "bookkeeper" : (org.grantable_roles[0] ?? "viewer"),
      );
  }, [org, role]);
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      unwrap(
        api.POST("/api/v1/oauth/consent", {
          body: { ...params, approve, org_id: org?.id, role } as never,
        }),
      ),
    onSuccess: (r) => window.location.assign(r.redirect_to),
  });

  if (session.isLoading || !signedIn || info.isLoading) return <Loading />;
  return (
    <PlainShell>
      <div className="mx-auto max-w-lg">
        <Card title="Connect an AI assistant">
          {!info.data ? (
            <ErrorText error={info.error} />
          ) : info.data.error ? (
            <>
              <Alert kind="error">{info.data.error.message}</Alert>
              <Button className="mt-3" variant="secondary" onClick={() => decide.mutate(false)}>
                Return to the app
              </Button>
            </>
          ) : info.data.orgs.length === 0 ? (
            <Alert kind="warn">You aren't a member of any organization yet.</Alert>
          ) : (
            <div className="space-y-4 text-sm">
              <p>
                <strong>{info.data.client.name}</strong> wants to work with your books. You'll be sent back to{" "}
                <code>{info.data.client.redirect_host}</code>.
              </p>
              <Field label="Organization">
                {(id) => (
                  <Select id={id} value={org?.id ?? ""} onChange={(e) => setOrgId(e.target.value)}>
                    {info.data!.orgs.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Access">
                {(id) => (
                  <Select id={id} value={role} onChange={(e) => setRole(e.target.value)}>
                    {(org?.grantable_roles ?? []).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_HELP[r] ?? r}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <ul className="list-inside list-disc text-zinc-600 dark:text-zinc-400">
                <li>
                  Everything it writes to the books, corrections included, waits in your review queue until
                  you approve it. Only contacts and notes apply directly.
                </li>
                <li>It can't approve its own proposals, void, delete, or change lock dates.</li>
                <li>You can disconnect it at any time from your account page.</li>
              </ul>
              <div className="flex gap-2">
                <Button
                  loading={decide.isPending && decide.variables === true}
                  onClick={() => decide.mutate(true)}
                >
                  Allow
                </Button>
                <Button variant="secondary" onClick={() => decide.mutate(false)}>
                  Deny
                </Button>
              </div>
              <ErrorText error={decide.error} />
            </div>
          )}
        </Card>
      </div>
    </PlainShell>
  );
}

type Connection = {
  id: string;
  client_name: string;
  org_name: string;
  user_email: string;
  role: string;
  created_at: string;
  last_used_at: string | null;
};

function ConnectionsTable({
  rows,
  showUser,
  onRevoke,
}: {
  rows: Connection[];
  showUser?: boolean;
  onRevoke: (id: string) => void;
}) {
  if (!rows.length) return <p className="text-sm text-zinc-500">No connected apps.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <th className={th}>App</th>
          {showUser ? <th className={th}>Connected by</th> : <th className={th}>Organization</th>}
          <th className={th}>Access</th>
          <th className={th}>Last used</th>
          <th className={th} />
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.id}>
            <td className={td}>{c.client_name}</td>
            <td className={td}>{showUser ? c.user_email : c.org_name}</td>
            <td className={td}>
              <Badge>{c.role}</Badge>
            </td>
            <td className={td}>{c.last_used_at ? fmtDateTime(c.last_used_at) : "never"}</td>
            <td className={`${td} text-right`}>
              <Button size="sm" variant="secondary" onClick={() => onRevoke(c.id)}>
                Disconnect
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function useRevoke(keys: string[][]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE("/api/v1/oauth/connections/{grantId}", { params: { path: { grantId: id } } })),
    onSuccess: () => {
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
    },
  });
}

/** Account page: the user's own connected apps. */
export function MyConnections() {
  const q = useQuery({
    queryKey: ["oauth-connections"],
    queryFn: () => unwrap(api.GET("/api/v1/oauth/connections")),
  });
  const revoke = useRevoke([["oauth-connections"]]);
  return (
    <Card title="Connected AI apps">
      <p className="mb-3 text-sm text-zinc-500">
        Apps you connected through “Add connector” (OAuth). Disconnecting stops them at once.
      </p>
      {q.data ? <ConnectionsTable rows={q.data.data} onRevoke={(id) => revoke.mutate(id)} /> : <Loading />}
      <ErrorText error={revoke.error} />
    </Card>
  );
}

/** Org settings: every app connected to this org (owners). */
export function OrgConnections() {
  const orgId = useOrgId();
  const q = useQuery({
    queryKey: ["org-oauth-connections", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/oauth/connections", { params: { path: { orgId } } })),
  });
  const revoke = useRevoke([["org-oauth-connections", orgId], ["oauth-connections"]]);
  return (
    <div className="space-y-6">
      <Card title="Connect an AI assistant">
        <p className="text-sm">
          Add this server as a connector in Claude or another MCP client using this URL; you'll sign in and
          pick an organization:
        </p>
        <code className="mt-2 block break-all rounded bg-zinc-100 px-2 py-1 text-sm dark:bg-zinc-800">
          {`${window.location.origin}/mcp`}
        </code>
        <p className="mt-2 text-xs text-zinc-500">
          Clients without OAuth can use a personal API token (Account → Personal API tokens) as a Bearer
          token.
        </p>
      </Card>
      <Card title="Connected AI apps">
        {q.data ? (
          <ConnectionsTable rows={q.data.data} showUser onRevoke={(id) => revoke.mutate(id)} />
        ) : (
          <ErrorText error={q.error} />
        )}
        <ErrorText error={revoke.error} />
      </Card>
    </div>
  );
}

/** Admin: manually registered OAuth clients. */
export function OAuthClients() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["oauth-clients"],
    queryFn: () => unwrap(api.GET("/api/v1/admin/oauth-clients")),
  });
  const [name, setName] = useState("");
  const [uri, setUri] = useState("");
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/admin/oauth-clients", {
          body: { client_name: name, redirect_uris: uri.split(/\s+/).filter(Boolean), confidential: true },
        }),
      ),
    onSuccess: () => {
      setName("");
      setUri("");
      qc.invalidateQueries({ queryKey: ["oauth-clients"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE("/api/v1/admin/oauth-clients/{clientId}", { params: { path: { clientId: id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["oauth-clients"] }),
  });
  const active = (q.data?.data ?? []).filter((c) => !c.revoked_at);
  return (
    <Card title="OAuth clients">
      <p className="mb-3 text-sm text-zinc-500">
        Register a client by hand when dynamic registration is off. The client secret is shown once.
      </p>
      {create.data && (
        <Alert kind="success">
          Client ID <code className="break-all">{create.data.client_id}</code>
          <br />
          Secret (copy it now): <code className="break-all">{create.data.client_secret}</code>
        </Alert>
      )}
      <form
        className="my-3 grid gap-3 sm:grid-cols-5 sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Client name" className="sm:col-span-2">
          {(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Redirect URI(s)" className="sm:col-span-2">
          {(id) => (
            <Input
              id={id}
              required
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              placeholder="https://…"
            />
          )}
        </Field>
        <Button type="submit" loading={create.isPending}>
          Register
        </Button>
      </form>
      <ErrorText error={create.error ?? revoke.error} />
      {active.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th className={th}>Client</th>
              <th className={th}>Registered</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {active.map((c) => (
              <tr key={c.client_id}>
                <td className={td}>
                  {c.client_name}
                  <div className="text-xs text-zinc-500">{c.redirect_uris.join(", ")}</div>
                </td>
                <td className={td}>
                  <Badge tone={c.registered_via === "manual" ? "blue" : "zinc"}>{c.registered_via}</Badge>{" "}
                  {fmtDateTime(c.created_at)}
                </td>
                <td className={`${td} text-right`}>
                  <Button size="sm" variant="secondary" onClick={() => revoke.mutate(c.client_id)}>
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
