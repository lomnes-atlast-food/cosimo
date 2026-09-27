/** Operations UI (SPEC §14): instance status and backups, org export/import, product imports. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api, download, rawFetch, unwrap } from "../api/client";
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
  Select,
  Table,
  td,
  th,
} from "../components/ui";
import { fmtDateTime, money } from "../lib/format";
import { useOrg, useOrgId, useRole } from "../lib/org";
import { useRefreshSession } from "../lib/session";
import { useUpdateStatus } from "../lib/updates";

type ProductImport = components["schemas"]["ProductImport"];

const kb = (b: number) =>
  b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

// ------------------------------------------------------------------ admin status

function UpdatesCard() {
  const qc = useQueryClient();
  const update = useUpdateStatus();
  const refresh = useMutation({
    mutationFn: () => unwrap(api.GET("/api/v1/admin/update", { params: { query: { refresh: "1" } } })),
    onSuccess: (data) => qc.setQueryData(["admin-update"], data),
  });
  const u = update.data;
  if (!u) return null;
  return (
    <Card
      title="Updates"
      actions={
        <Button size="sm" variant="secondary" loading={refresh.isPending} onClick={() => refresh.mutate()}>
          Check now
        </Button>
      }
    >
      {u.status === "available" && (
        <div className="space-y-2 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="amber">v{u.latest!.version} available</Badge>
            {u.latest!.published_at && (
              <span className="text-zinc-500">published {fmtDateTime(u.latest!.published_at)}</span>
            )}
            <a href={u.latest!.url} target="_blank" rel="noreferrer" className="underline">
              Release notes
            </a>
          </p>
          {u.instructions.length > 0 && (
            <ul className="list-inside list-disc space-y-0.5 text-zinc-600 dark:text-zinc-400">
              {u.instructions.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {u.status === "up_to_date" && (
        <p className="text-sm text-zinc-500">
          Up to date{u.checked_at && <> (checked {fmtDateTime(u.checked_at)})</>}.
        </p>
      )}
      {u.status === "disabled" && (
        <p className="text-sm text-zinc-500">The update check is off (updates.check in the config).</p>
      )}
      {u.status === "dev" && (
        <p className="text-sm text-zinc-500">Development build: it never checks for updates.</p>
      )}
      {u.status === "unknown" && (
        <p className="text-sm text-zinc-500">Could not check for updates.{u.error && ` ${u.error}`}</p>
      )}
      <ErrorText error={refresh.error} />
    </Card>
  );
}

export function AdminStatus() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["admin-status"],
    queryFn: () => unwrap(api.GET("/api/v1/admin/status")),
  });
  const backups = useQuery({
    queryKey: ["admin-backups"],
    queryFn: () => unwrap(api.GET("/api/v1/admin/backups")),
  });
  const backup = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/admin/backups")),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-status"] });
      qc.invalidateQueries({ queryKey: ["admin-backups"] });
    },
  });
  if (status.isLoading) return <Loading />;
  if (!status.data) return <ErrorText error={status.error} />;
  const s = status.data;
  return (
    <div className="space-y-6">
      <Card title="Instance">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-zinc-500">Version</dt>
            <dd className="font-medium">
              {s.version}
              {s.commit && <span className="ml-1 font-mono text-xs text-zinc-400">{s.commit}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Deployment</dt>
            <dd className="font-medium">{s.target}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Database</dt>
            <dd className="font-medium">{s.database_mode}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Organizations</dt>
            <dd className="font-medium">{s.orgs}</dd>
          </div>
        </dl>
      </Card>

      <UpdatesCard />

      <Card
        title="Backups"
        actions={
          <Button size="sm" loading={backup.isPending} onClick={() => backup.mutate()}>
            Back up now
          </Button>
        }
      >
        <p className="text-sm">
          {s.backups.mode === "off" ? (
            <Badge tone="amber">Nightly backups are off</Badge>
          ) : (
            <>
              Nightly at {s.backups.time} UTC ({s.backups.mode}).
            </>
          )}{" "}
          {s.backups.last ? (
            <>
              Last backup {fmtDateTime(s.backups.last.at)} ({kb(s.backups.last.bytes)},{" "}
              {s.backups.last.reason}).
            </>
          ) : (
            <Badge tone="amber">No backup yet</Badge>
          )}
        </p>
        {backup.isSuccess && (
          <div className="mt-3">
            <Alert kind="success">
              Backup written: {backup.data.name} ({kb(backup.data.bytes)}).
              {backup.data.secrets_omitted &&
                " Secrets are not included; keep the master key backed up separately."}
            </Alert>
          </div>
        )}
        <ErrorText error={backup.error} />
        {(backups.data?.data.length ?? 0) > 0 && (
          <Table className="mt-3">
            <thead>
              <tr>
                <th className={th}>File</th>
                <th className={th}>Created</th>
                <th className={`${th} text-right`}>Size</th>
              </tr>
            </thead>
            <tbody>
              {backups.data!.data.slice(0, 10).map((b) => (
                <tr key={b.name}>
                  <td className={`${td} font-mono text-xs`}>{b.name}</td>
                  <td className={td}>{fmtDateTime(b.created_at)}</td>
                  <td className={`${td} text-right`}>{kb(b.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Bank feeds">
        {s.bank_connections.length === 0 ? (
          <p className="text-sm text-zinc-500">No bank connections.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Organization</th>
                <th className={th}>Institution</th>
                <th className={th}>Status</th>
                <th className={th}>Last sync</th>
              </tr>
            </thead>
            <tbody>
              {s.bank_connections.map((b) => (
                <tr key={b.id}>
                  <td className={td}>{b.org_name}</td>
                  <td className={td}>{b.institution ?? "—"}</td>
                  <td className={td}>
                    <Badge tone={b.status === "active" ? "green" : "amber"}>{b.status}</Badge>
                  </td>
                  <td className={td}>{b.last_synced_at ? fmtDateTime(b.last_synced_at) : "never"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Recent job errors">
        {s.recent_job_errors.length === 0 ? (
          <p className="text-sm text-zinc-500">None.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {s.recent_job_errors.map((e) => (
              <li key={`${e.job}-${e.started_at}-${e.org_id}`}>
                <span className="font-medium">{e.job}</span>{" "}
                <span className="text-zinc-500">{fmtDateTime(e.started_at)}</span>
                {e.detail && <div className="text-xs text-red-700 dark:text-red-400">{e.detail}</div>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ org settings: import / export

function ImportReport({ r }: { r: ProductImport }) {
  const names = { qbo: "QuickBooks Online", xero: "Xero", wave: "Wave" } as const;
  const created = r.accounts.items.filter((a) => a.action === "create");
  return (
    <div className="space-y-3 text-sm" data-testid="import-report">
      <p>
        <span className="font-medium">{names[r.source]}</span>
        {r.date_range && (
          <>
            {" "}
            · {r.date_range.from} to {r.date_range.to}
          </>
        )}
      </p>
      <ul className="list-inside list-disc">
        <li>
          Accounts: {r.accounts.create} new, {r.accounts.match} matched to existing accounts
        </li>
        <li>
          Contacts: {r.contacts.create} new, {r.contacts.match} matched
        </li>
        <li>
          Entries: {r.entries.new} new
          {r.entries.already_imported > 0 && `, ${r.entries.already_imported} already imported`} (debits{" "}
          {money(r.entries.total_debits)})
        </li>
      </ul>
      {created.length > 0 && (
        <details>
          <summary className="cursor-pointer">New accounts</summary>
          <ul className="mt-1 space-y-0.5">
            {created.map((a) => (
              <li key={a.key}>
                {a.code} {a.name}{" "}
                <span className="text-zinc-500">
                  ({a.type}/{a.subtype})
                </span>
                {a.synthesized && (
                  <>
                    {" "}
                    <Badge tone="amber">type guessed</Badge>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {r.errors.length > 0 && (
        <Alert kind="error">
          <ul>
            {r.errors.map((e) => (
              <li key={`${e.file}-${e.row}-${e.message}`}>
                {e.file}
                {e.row ? `:${e.row}` : ""} {e.message}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {r.warnings.length > 0 && (
        <details>
          <summary className="cursor-pointer">{r.warnings.length} warning(s)</summary>
          <ul className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            {r.warnings.map((w) => (
              <li key={`${w.file}-${w.row}-${w.message}`}>
                {w.file}
                {w.row ? `:${w.row}` : ""} {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ProductImporter() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [source, setSource] = useState<"" | "qbo" | "xero" | "wave">("");
  const [report, setReport] = useState<ProductImport | null>(null);
  const run = useMutation({
    mutationFn: (dry: boolean) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/imports/product", {
          params: { path: { orgId } },
          body: { files, source: source || undefined, dry_run: dry },
        }),
      ),
    onSuccess: (r) => {
      setReport(r);
      if (r.committed) qc.invalidateQueries();
    },
  });
  const r = report;
  const committing = run.isPending && run.variables === false;
  return (
    <Card title="Import from QuickBooks Online, Xero, or Wave">
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
        Export your chart of accounts, customers and vendors, and journal from the other product as CSV files,
        then add them all here. You see what will happen before anything is imported, and importing the same
        files again adds nothing.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="CSV files">
          {(id) => (
            <Input
              id={id}
              type="file"
              multiple
              accept=".csv,text/csv"
              onChange={async (e) => {
                const list = Array.from(e.target.files ?? []);
                setFiles(
                  await Promise.all(list.map(async (f) => ({ name: f.name, content: await f.text() }))),
                );
                run.reset();
                setReport(null);
              }}
            />
          )}
        </Field>
        <Field label="Product">
          {(id) => (
            <Select id={id} value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
              <option value="">Detect</option>
              <option value="qbo">QuickBooks Online</option>
              <option value="xero">Xero</option>
              <option value="wave">Wave</option>
            </Select>
          )}
        </Field>
        <Button
          variant="secondary"
          disabled={!files.length}
          loading={run.isPending && run.variables === true}
          onClick={() => run.mutate(true)}
        >
          Preview
        </Button>
      </div>
      <div className="mt-4">
        <ErrorText error={run.error} />
        {r && <ImportReport r={r} />}
        {r && !r.committed && r.can_commit && (
          <Button className="mt-3" loading={committing} onClick={() => run.mutate(false)}>
            Import {r.entries.new} entries
          </Button>
        )}
        {r?.committed && (
          <div className="mt-3">
            <Alert kind="success">
              Created {r.created.accounts} account(s) and {r.created.contacts} contact(s).
              {r.review_item_id && (
                <>
                  {" "}
                  The {r.created.entries} entries wait in{" "}
                  <Link to="/o/$orgId/accounting/review" params={{ orgId }} className="underline">
                    Review
                  </Link>{" "}
                  as one batch. Approving it posts them all.
                </>
              )}
            </Alert>
          </div>
        )}
        {r && !r.committed && !r.can_commit && r.entries.new === 0 && (
          <p className="mt-3 text-sm text-zinc-500">Nothing new to import.</p>
        )}
      </div>
    </Card>
  );
}

export function ImportExport() {
  const orgId = useOrgId();
  const org = useOrg();
  const { isOwner } = useRole();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (!isOwner) return <p className="text-sm text-zinc-500">Only owners can import and export.</p>;
  const slug = (org.data?.name ?? orgId).replace(/[^A-Za-z0-9._-]+/g, "-");
  return (
    <div className="space-y-6">
      <Card title="Export">
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          Download these books in Cosimo's open format: every table as JSON Lines, attachments, and a manifest
          with the hash-chain heads. It can be imported into another Cosimo instance, or read by any tool.
          Stored secrets (bank connection tokens, keys) are not included.
        </p>
        <Button
          variant="secondary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await download(
                `/api/v1/orgs/${orgId}/export`,
                `${slug}-${new Date().toISOString().slice(0, 10)}.zip`,
              );
            } catch (e) {
              setErr(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Download export
        </Button>
        <ErrorText error={err} />
      </Card>
      <ProductImporter />
    </div>
  );
}

// ------------------------------------------------------------------ orgs page: import an export

export function ImportOrgCard() {
  const navigate = useNavigate();
  const refresh = useRefreshSession();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const m = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.set("file", file!);
      if (name.trim()) form.set("name", name.trim());
      const res = await rawFetch("/api/v1/imports/org", { method: "POST", body: form });
      return (await res.json()) as { org_id: string; name: string; members_skipped: string[] };
    },
    onSuccess: async (r) => {
      await refresh();
      navigate({ to: "/o/$orgId", params: { orgId: r.org_id } });
    },
  });
  return (
    <Card title="Import an organization">
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
        Restore books exported from Cosimo (Settings → Import &amp; export). The organization keeps its ID and
        its hash chains are verified.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Export file (.zip)">
          {(id) => (
            <Input
              id={id}
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          )}
        </Field>
        <Field label="New name (optional)">
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Button variant="secondary" disabled={!file} loading={m.isPending} onClick={() => m.mutate()}>
          Import
        </Button>
      </div>
      <ErrorText error={m.error} />
    </Card>
  );
}
