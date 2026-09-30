import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api, unwrap } from "../api/client";
import { Alert, Badge, Button, Card, ErrorText, Loading, Modal, Select } from "../components/ui";
import { KIND_LABEL, useBankAccounts } from "../lib/banking";
import { fmtDate } from "../lib/format";
import { useOrgId, useRole } from "../lib/org";
import {
  type Connection,
  clearPendingLink,
  type LinkAccount,
  openLink,
  savePendingLink,
  syncText,
  takePendingLink,
  useConnections,
  usePlaidStatus,
} from "../lib/plaid";

const STATUS: Record<Connection["status"], { label: string; tone: "green" | "amber" | "red" | "zinc" }> = {
  active: { label: "Connected", tone: "green" },
  needs_reauth: { label: "Reconnect needed", tone: "amber" },
  error: { label: "Sync error", tone: "red" },
  disconnected: { label: "Disconnected", tone: "zinc" },
};

async function linkToken(orgId: string, connectionId: string | null, accountSelection = false) {
  return unwrap(
    api.POST("/api/v1/orgs/{orgId}/plaid/link-token", {
      params: { path: { orgId } },
      body: { connection_id: connectionId, ...(accountSelection ? { account_selection: true } : {}) },
    }),
  );
}

/** Accounts Plaid can add to a connection. With none, clears its new-accounts flag and returns null. */
async function newAccounts(orgId: string, connectionId: string): Promise<LinkAccount[] | null> {
  const r = await unwrap(
    api.GET("/api/v1/orgs/{orgId}/bank-connections/{connectionId}/available-accounts", {
      params: { path: { orgId, connectionId } },
    }),
  );
  if (r.data.length)
    return r.data.map((a) => ({
      id: a.account_id,
      name: a.name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
    }));
  await unwrap(
    api.POST("/api/v1/orgs/{orgId}/bank-connections/{connectionId}/accounts", {
      params: { path: { orgId, connectionId } },
      body: { accounts: [] },
    }),
  );
  return null;
}

/** Plaid accounts to map: from a new Link session, or new ones at an existing connection. */
type Linked =
  | { publicToken: string; accounts: LinkAccount[] }
  | { connectionId: string; accounts: LinkAccount[] };

/** Bank feeds card on the bank accounts page: connect, status, sync, reconnect, disconnect. */
export function BankFeeds() {
  const orgId = useOrgId();
  const { canWrite, isOwner } = useRole();
  const qc = useQueryClient();
  const status = usePlaidStatus(orgId);
  const conns = useConnections(orgId);
  const [linked, setLinked] = useState<Linked | null>(null);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries();

  const connect = useMutation({
    mutationFn: async () => {
      const t = await linkToken(orgId, null);
      savePendingLink({ orgId, token: t.link_token, connectionId: null });
      try {
        return await openLink(t.link_token);
      } finally {
        clearPendingLink();
      }
    },
    onSuccess: (r) => r && setLinked(r),
  });

  const reconnect = useMutation({
    mutationFn: async (c: Connection) => {
      const t = await linkToken(orgId, c.id);
      savePendingLink({ orgId, token: t.link_token, connectionId: c.id });
      let r: Awaited<ReturnType<typeof openLink>>;
      try {
        r = await openLink(t.link_token);
      } finally {
        clearPendingLink();
      }
      if (!r) return null;
      return unwrap(
        api.POST("/api/v1/orgs/{orgId}/bank-connections/{connectionId}/reconnected", {
          params: { path: { orgId, connectionId: c.id } },
        }),
      );
    },
    onSuccess: async (r) => {
      if (r)
        setNote(
          `${r.connection.institution_name ?? "Bank"} reconnected${r.sync ? `: ${syncText(r.sync)}` : ""}.`,
        );
      await refresh();
    },
  });

  const addAccounts = useMutation({
    mutationFn: async (c: Connection) => {
      const t = await linkToken(orgId, c.id, true);
      savePendingLink({ orgId, token: t.link_token, connectionId: c.id, mode: "add_accounts" });
      let r: Awaited<ReturnType<typeof openLink>>;
      try {
        r = await openLink(t.link_token);
      } finally {
        clearPendingLink();
      }
      if (!r) return undefined;
      return { connectionId: c.id, accounts: await newAccounts(orgId, c.id) };
    },
    onSuccess: async (r) => {
      if (!r) return;
      if (r.accounts) setLinked({ connectionId: r.connectionId, accounts: r.accounts });
      else {
        setNote("No new accounts to add.");
        await refresh();
      }
    },
  });

  const sync = useMutation({
    mutationFn: (c: Connection) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/bank-connections/{connectionId}/sync", {
          params: { path: { orgId, connectionId: c.id } },
        }),
      ),
    onSuccess: async (s, c) => {
      if (s) setNote(`${c.institution_name ?? "Bank"}: ${syncText(s)}.`);
      await refresh();
    },
    onError: () => refresh(),
  });

  if (status.isLoading || conns.isLoading) return <Loading />;
  const s = status.data;
  const list = (conns.data ?? []).filter((c) => c.status !== "disconnected");

  return (
    <Card
      title="Bank feeds"
      className="mb-4"
      actions={
        isOwner &&
        s?.configured && (
          <Button size="sm" loading={connect.isPending} onClick={() => connect.mutate()}>
            Connect a bank
          </Button>
        )
      }
    >
      {!s?.configured ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Bank feeds use your own Plaid keys. An instance admin can add them under Admin → Settings (Sandbox
          keys work for trying it out). Until then, statement import works for every bank.
        </p>
      ) : list.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Connect a bank to pull transactions automatically. They sync every 6 hours
          {s.webhooks ? " and whenever the bank reports new activity" : ""}.
          {s.env === "sandbox" && " Plaid Sandbox: sign in with user_good / pass_good."}
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {list.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {c.institution_name ?? "Bank"}
                  <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                </div>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {c.accounts.map((a) => `${a.name}${a.mask ? ` ··${a.mask}` : ""}`).join(", ") ||
                    "No accounts"}
                </p>
                <p className="text-xs text-zinc-500">
                  {c.last_successful_sync_at
                    ? `Last synced ${fmtDate(c.last_successful_sync_at.slice(0, 10))}`
                    : "Not synced yet"}
                </p>
                {c.new_accounts_available && (
                  <p className="text-sm text-sky-700 dark:text-sky-400">
                    New accounts are available at this bank.
                  </p>
                )}
                {c.message && (
                  <p
                    className={
                      c.status === "active"
                        ? "text-sm text-zinc-500"
                        : "text-sm text-amber-700 dark:text-amber-400"
                    }
                  >
                    {c.message}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                {isOwner && (c.status === "needs_reauth" || c.status === "error") && (
                  <Button
                    size="sm"
                    loading={reconnect.isPending && reconnect.variables?.id === c.id}
                    onClick={() => reconnect.mutate(c)}
                  >
                    Reconnect
                  </Button>
                )}
                {isOwner && c.status === "active" && (
                  <Button
                    size="sm"
                    variant={c.new_accounts_available ? "primary" : "secondary"}
                    loading={addAccounts.isPending && addAccounts.variables?.id === c.id}
                    onClick={() => addAccounts.mutate(c)}
                  >
                    Add accounts
                  </Button>
                )}
                {canWrite && c.status !== "needs_reauth" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={sync.isPending && sync.variables?.id === c.id}
                    onClick={() => sync.mutate(c)}
                  >
                    Sync now
                  </Button>
                )}
                {isOwner && (
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(c)}>
                    Disconnect
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {note && (
        <div className="mt-3">
          <Alert kind="success">{note}</Alert>
        </div>
      )}
      <ErrorText error={connect.error ?? reconnect.error ?? addAccounts.error ?? sync.error} />
      {linked && (
        <MapAccounts
          orgId={orgId}
          linked={linked}
          onClose={() => setLinked(null)}
          onDone={(msg) => {
            setLinked(null);
            setNote(msg);
          }}
        />
      )}
      {removing && <Disconnect c={removing} onClose={() => setRemoving(null)} />}
    </Card>
  );
}

function defaultChoice(a: LinkAccount) {
  return a.type === "depository" || a.type === "credit" ? "new" : "skip";
}

/**
 * After Link: choose, per account, a new bank account, an existing one, or skip. Finishes a new
 * connection, or adds accounts to an existing one.
 */
export function MapAccounts({
  orgId,
  linked,
  onClose,
  onDone,
}: {
  orgId: string;
  linked: Linked;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const qc = useQueryClient();
  const existing = (useBankAccounts(orgId).data ?? []).filter((b) => !b.connection_id && b.is_active);
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(linked.accounts.map((a) => [a.id, defaultChoice(a)])),
  );
  const adding = "connectionId" in linked;
  const save = useMutation({
    mutationFn: () => {
      const accounts = linked.accounts.map((a) => {
        const v = choice[a.id] ?? "skip";
        return v.startsWith("link:")
          ? { account_id: a.id, action: "link" as const, bank_account_id: v.slice(5) }
          : { account_id: a.id, action: v as "new" | "skip" };
      });
      return "connectionId" in linked
        ? unwrap(
            api.POST("/api/v1/orgs/{orgId}/bank-connections/{connectionId}/accounts", {
              params: { path: { orgId, connectionId: linked.connectionId } },
              body: { accounts },
            }),
          )
        : unwrap(
            api.POST("/api/v1/orgs/{orgId}/plaid/exchange", {
              params: { path: { orgId } },
              body: { public_token: linked.publicToken, accounts },
            }),
          );
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries();
      const name = r.connection.institution_name ?? "Bank";
      onDone(
        adding
          ? `Accounts added to ${name}${r.sync ? `: ${syncText(r.sync)}` : ". Transactions will arrive shortly."}`
          : `${name} connected${r.sync ? `: ${syncText(r.sync)}` : ". Transactions will arrive shortly."}`,
      );
    },
  });
  const chosen = Object.values(choice).filter((v) => v !== "skip");
  const dupLinks =
    chosen.filter((v) => v.startsWith("link:")).length !==
    new Set(chosen.filter((v) => v.startsWith("link:"))).size;
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Choose accounts to import"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={!chosen.length || dupLinks}
            onClick={() => save.mutate()}
          >
            {adding ? "Add accounts" : "Connect"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-zinc-600 dark:text-zinc-400">
          Link an account to one you already import statements into to keep its history; feed transactions on
          or before its last imported date are skipped so nothing is doubled.
        </p>
        {linked.accounts.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {a.name}
              {a.mask && <span className="ml-1 text-zinc-400">··{a.mask}</span>}
              <span className="ml-2 text-xs text-zinc-500">{a.subtype ?? a.type}</span>
            </span>
            <Select
              aria-label={`Import ${a.name}`}
              className="w-64"
              value={choice[a.id]}
              onChange={(e) => setChoice({ ...choice, [a.id]: e.target.value })}
            >
              <option value="new">New bank account</option>
              {existing.map((b) => (
                <option key={b.id} value={`link:${b.id}`}>
                  Link to {b.name} ({KIND_LABEL[b.kind]})
                </option>
              ))}
              <option value="skip">Don't import</option>
            </Select>
          </div>
        ))}
        {dupLinks && <Alert kind="error">Each existing account can be linked once.</Alert>}
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}

function Disconnect({ c, onClose }: { c: Connection; onClose: () => void }) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/orgs/{orgId}/bank-connections/{connectionId}", {
          params: { path: { orgId, connectionId: c.id } },
        }),
      ),
    onSuccess: async () => {
      await qc.invalidateQueries();
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Disconnect ${c.institution_name ?? "bank"}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={del.isPending} onClick={() => del.mutate()}>
            Disconnect
          </Button>
        </>
      }
    >
      <p className="text-sm">
        Cosimo stops syncing and removes its access at Plaid. Bank accounts and every transaction already
        imported stay; you can keep importing statements or connect again later.
      </p>
      <ErrorText error={del.error} />
    </Modal>
  );
}

/** Return point for banks that use OAuth: resumes Link with the saved token. */
export function PlaidOAuthPage() {
  const navigate = useNavigate();
  const pending = useRef(takePendingLink());
  const [error, setError] = useState<string | null>(null);
  const [linked, setLinked] = useState<Linked | null>(null);
  const p = pending.current;

  useEffect(() => {
    if (!p) return;
    const back = () => navigate({ to: "/o/$orgId/banking/accounts", params: { orgId: p.orgId } });
    openLink(p.token, window.location.href)
      .then(async (r) => {
        clearPendingLink();
        if (!r) return back();
        if (p.connectionId && p.mode === "add_accounts") {
          const accounts = await newAccounts(p.orgId, p.connectionId);
          if (!accounts) return back();
          return setLinked({ connectionId: p.connectionId, accounts });
        }
        if (p.connectionId) {
          await unwrap(
            api.POST("/api/v1/orgs/{orgId}/bank-connections/{connectionId}/reconnected", {
              params: { path: { orgId: p.orgId, connectionId: p.connectionId } },
            }),
          );
          return back();
        }
        setLinked(r);
      })
      .catch((e: Error) => setError(e.message));
  }, [p, navigate]);

  if (!p)
    return (
      <div className="mx-auto max-w-md p-6">
        <Alert kind="error">This bank sign-in link has expired. Start again from Banking → Accounts.</Alert>
      </div>
    );
  return (
    <div className="mx-auto max-w-md p-6">
      {error ? <Alert kind="error">{error}</Alert> : <Loading />}
      {linked && (
        <MapAccounts
          orgId={p.orgId}
          linked={linked}
          onClose={() => navigate({ to: "/o/$orgId/banking/accounts", params: { orgId: p.orgId } })}
          onDone={() => navigate({ to: "/o/$orgId/banking/accounts", params: { orgId: p.orgId } })}
        />
      )}
    </div>
  );
}
