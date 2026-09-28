import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api, unwrap } from "../api/client";
import { PlainShell } from "../components/Shell";
import { Badge, Button, Card, ErrorText, Field, Input, PageHeader, Select } from "../components/ui";
import { useRefreshSession, useSession } from "../lib/session";
import { ImportOrgCard } from "./operations";

const ENTITY = [
  ["single_member_llc", "Single-member LLC"],
  ["sole_prop", "Sole proprietor"],
  ["multi_member_llc", "Multi-member LLC / partnership"],
  ["s_corp", "S corporation"],
  ["other", "Other"],
] as const;
const TEMPLATES = [
  ["", "Recommended for the business type"],
  ["schedule_c", "Schedule C (sole prop / single-member LLC)"],
  ["form_1065", "Form 1065 (partnership)"],
  ["form_1120s", "Form 1120-S (S corp)"],
  ["minimal", "Minimal"],
] as const;

export function CreateOrgForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [entity, setEntity] = useState<(typeof ENTITY)[number][0]>("single_member_llc");
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number][0]>("");
  const [fy, setFy] = useState(1);
  const [start, setStart] = useState(`${new Date().getFullYear()}-01-01`);
  const refresh = useRefreshSession();
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs", {
          body: {
            name,
            entity_type: entity,
            coa_template: template || undefined,
            fiscal_year_start_month: fy,
            books_start_date: start,
            basis: "cash",
          },
        }),
      ),
    onSuccess: async (r) => {
      await refresh();
      onCreated(r.id);
    },
  });
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        m.mutate();
      }}
      className="grid gap-4 sm:grid-cols-2"
    >
      <Field label="Business name" className="sm:col-span-2">
        {(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Business type">
        {(id) => (
          <Select id={id} value={entity} onChange={(e) => setEntity(e.target.value as typeof entity)}>
            {ENTITY.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Chart of accounts">
        {(id) => (
          <Select id={id} value={template} onChange={(e) => setTemplate(e.target.value as typeof template)}>
            {TEMPLATES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Fiscal year starts">
        {(id) => (
          <Select id={id} value={fy} onChange={(e) => setFy(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {new Date(2000, i, 1).toLocaleString(undefined, { month: "long" })}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Books start date">
        {(id) => (
          <Input id={id} type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
        )}
      </Field>
      <div className="sm:col-span-2">
        <ErrorText error={m.error} />
        <Button type="submit" loading={m.isPending} className="mt-2">
          Create organization
        </Button>
      </div>
    </form>
  );
}

function LoadSampleCard() {
  const navigate = useNavigate();
  const refresh = useRefreshSession();
  const load = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/sample-org")),
    onSuccess: async (r) => {
      await refresh();
      navigate({ to: "/o/$orgId", params: { orgId: r.id } });
    },
  });
  return (
    <Card title="Load a demo organization" className="mb-6">
      <p className="mb-3 text-sm text-zinc-500">
        Get a copy of Demo Studio, a sample business with three months of bank activity, an invoice, and work
        waiting in Categorize, so you can try Cosimo before setting up your own books.
      </p>
      <ErrorText error={load.error} />
      <Button loading={load.isPending} onClick={() => load.mutate()}>
        Load demo organization
      </Button>
    </Card>
  );
}

export function OrgsPage() {
  const { data } = useSession();
  const navigate = useNavigate();
  const orgs = data?.orgs ?? [];
  const hasSample = orgs.some((o) => o.is_sample);
  return (
    <PlainShell>
      <PageHeader title="Your organizations" subtitle="Each organization is a separate set of books." />
      {orgs.length > 0 && (
        <Card className="mb-6">
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {orgs.map((o) => (
              <li key={o.id} className="flex items-center justify-between py-2">
                <Link to="/o/$orgId" params={{ orgId: o.id }} className="font-medium hover:underline">
                  {o.name}
                </Link>
                <div className="flex items-center gap-2">
                  {o.is_sample && <Badge tone="blue">Demo</Badge>}
                  <Badge>{o.role}</Badge>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {!hasSample && <LoadSampleCard />}
      <Card title="New organization">
        <CreateOrgForm onCreated={(id) => navigate({ to: "/o/$orgId", params: { orgId: id } })} />
      </Card>
      <div className="mt-6">
        <ImportOrgCard />
      </div>
    </PlainShell>
  );
}
