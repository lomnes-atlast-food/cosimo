import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  ErrorText,
  Field,
  Input,
  Loading,
  Select,
  Table,
  Textarea,
  td,
  th,
} from "../components/ui";
import { fmtDateTime } from "../lib/format";
import { TYPE_LABELS, TYPE_ORDER, useAccounts } from "../lib/ledger";
import { useOrgId, useRole } from "../lib/org";

type Profile = components["schemas"]["BusinessProfile"];
type Note = components["schemas"]["BookkeepingNote"];
type Recurring = { item: string; account_code: string; notes?: string };

const TEXT_FIELDS: {
  key: "description" | "billing" | "customers" | "vendors" | "other";
  label: string;
  hint: string;
}[] = [
  { key: "description", label: "What the business does", hint: "A sentence or two, in plain words." },
  { key: "billing", label: "How it bills", hint: "Retainers, hourly, fixed-fee projects, product sales…" },
  { key: "customers", label: "Typical customers", hint: "Who pays you, and how they usually pay." },
  { key: "vendors", label: "Typical vendors", hint: "Who you pay regularly." },
  { key: "other", label: "Anything else", hint: "Quirks an assistant should know before categorizing." },
];

function ProfileForm() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const { canWrite } = useRole();
  const accounts = useAccounts(orgId);
  const q = useQuery({
    queryKey: ["profile", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/profile", { params: { path: { orgId } } })),
  });
  const [form, setForm] = useState<Profile>({});
  const [recurring, setRecurring] = useState<Recurring[]>([]);
  useEffect(() => {
    if (q.data) {
      setForm(q.data.profile);
      setRecurring(q.data.profile.recurring ?? []);
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/api/v1/orgs/{orgId}/profile", {
          params: { path: { orgId } },
          body: {
            ...form,
            recurring: recurring.filter((r) => r.item.trim() && r.account_code),
          },
        }),
      ),
    onSuccess: (data) => qc.setQueryData(["profile", orgId], data),
  });
  if (!q.data) return <Loading />;
  const setRow = (i: number, patch: Partial<Recurring>) =>
    setRecurring((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const active = (accounts.data ?? []).filter((a) => a.is_active);
  return (
    <Card
      title="Business profile"
      actions={
        q.data.updated_at && (
          <span className="text-xs text-zinc-500">
            Updated {fmtDateTime(q.data.updated_at)}
            {q.data.author_name ? ` by ${q.data.author_name}` : ""}
          </span>
        )
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <fieldset disabled={!canWrite} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {TEXT_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint}>
                {(id) => (
                  <Textarea
                    id={id}
                    rows={3}
                    value={form[f.key] ?? ""}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  />
                )}
              </Field>
            ))}
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Accounts for recurring items
            </h3>
            {recurring.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Item</th>
                    <th className={th}>Account</th>
                    <th className={th}>Notes</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody>
                  {recurring.map((r, i) => (
                    <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className={td}>
                        <Input
                          aria-label="Recurring item"
                          value={r.item}
                          placeholder="e.g. AWS hosting"
                          onChange={(e) => setRow(i, { item: e.target.value })}
                        />
                      </td>
                      <td className={td}>
                        <Select
                          aria-label="Account"
                          value={r.account_code}
                          onChange={(e) => setRow(i, { account_code: e.target.value })}
                        >
                          <option value="">Choose an account…</option>
                          {TYPE_ORDER.map((t) => {
                            const list = active.filter((a) => a.type === t);
                            if (!list.length) return null;
                            return (
                              <optgroup key={t} label={TYPE_LABELS[t]}>
                                {list.map((a) => (
                                  <option key={a.id} value={a.code}>
                                    {a.code} · {a.name}
                                  </option>
                                ))}
                              </optgroup>
                            );
                          })}
                        </Select>
                      </td>
                      <td className={td}>
                        <Input
                          aria-label="Notes"
                          value={r.notes ?? ""}
                          onChange={(e) => setRow(i, { notes: e.target.value })}
                        />
                      </td>
                      <td className={td}>
                        {canWrite && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setRecurring((rows) => rows.filter((_, j) => j !== i))}
                          >
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {canWrite && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setRecurring((rows) => [...rows, { item: "", account_code: "" }])}
              >
                Add recurring item
              </Button>
            )}
          </div>
        </fieldset>
        <ErrorText error={save.error} />
        {save.isSuccess && <Alert kind="success">Business profile saved.</Alert>}
        {canWrite ? (
          <Button type="submit" loading={save.isPending}>
            Save profile
          </Button>
        ) : (
          <p className="text-sm text-zinc-500">Only owners and bookkeepers can change the profile.</p>
        )}
      </form>
    </Card>
  );
}

function NoteItem({ note }: { note: Note }) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note.body_md);
  const refresh = () => qc.invalidateQueries({ queryKey: ["notes", orgId] });
  const update = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/api/v1/orgs/{orgId}/notes/{noteId}", {
          params: { path: { orgId, noteId: note.id } },
          body: { body_md: body },
        }),
      ),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/orgs/{orgId}/notes/{noteId}", { params: { path: { orgId, noteId: note.id } } }),
      ),
    onSuccess: refresh,
  });
  return (
    <li className="space-y-2 py-3" data-testid="note">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{note.author_name}</span>
        {note.author_actor === "mcp" && <Badge tone="blue">AI</Badge>}
        <span>{fmtDateTime(note.created_at)}</span>
        {note.updated_at !== note.created_at && <span>(edited {fmtDateTime(note.updated_at)})</span>}
        {note.can_edit && !editing && (
          <span className="ml-auto flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setBody(note.body_md);
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={remove.isPending}
              onClick={() => {
                if (confirm("Delete this note?")) remove.mutate();
              }}
            >
              Delete
            </Button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea aria-label="Edit note" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" loading={update.isPending} onClick={() => update.mutate()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm">{note.body_md}</p>
      )}
      <ErrorText error={update.error ?? remove.error} />
    </li>
  );
}

function Notes() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const { canWrite } = useRole();
  const [body, setBody] = useState("");
  const q = useQuery({
    queryKey: ["notes", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/notes", { params: { path: { orgId } } })),
  });
  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/notes", { params: { path: { orgId } }, body: { body_md: body } }),
      ),
    onSuccess: () => {
      setBody("");
      qc.invalidateQueries({ queryKey: ["notes", orgId] });
    },
  });
  return (
    <Card title="Bookkeeping notes">
      {canWrite && (
        <form
          className="mb-4 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) add.mutate();
          }}
        >
          <Field label="Add a note" hint="Never put passwords, account numbers, or other secrets here.">
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={body}
                placeholder="e.g. Payments from Acme are retainer billing, account 4010."
                onChange={(e) => setBody(e.target.value)}
              />
            )}
          </Field>
          <ErrorText error={add.error} />
          <Button type="submit" size="sm" loading={add.isPending} disabled={!body.trim()}>
            Add note
          </Button>
        </form>
      )}
      {!q.data ? (
        <Loading />
      ) : q.data.data.length === 0 ? (
        <Empty title="No notes yet">Notes from you, your team, and AI assistants appear here.</Empty>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {q.data.data.map((n) => (
            <NoteItem key={`${n.id}:${n.updated_at}`} note={n} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export function BusinessContext() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        AI assistants read this profile and these notes before categorizing transactions.
      </p>
      <ProfileForm />
      <Notes />
    </div>
  );
}
