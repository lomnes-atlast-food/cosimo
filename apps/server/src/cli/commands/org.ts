import { COA_TEMPLATES, type CoaTemplate, defaultTemplateForEntity, type EntityType } from "@cosimo/shared";
import { systemActor } from "../../services/actor.ts";
import { CliError, emit, parse, table, withContext } from "../util.ts";

const USAGE = `cosimo org <command>
  create <name> --owner <email> [--entity-type T] [--template T] [--fiscal-start M] [--start-date D]
  list [--all]
  archive <org_id>
  delete <org_id> --yes          Permanently delete the org database`;

export async function orgCommand(argv: string[]) {
  const [sub, ...rest] = argv;
  const { values, positionals } = parse(rest, {
    owner: { type: "string" },
    "entity-type": { type: "string" },
    template: { type: "string" },
    "fiscal-start": { type: "string" },
    "start-date": { type: "string" },
    all: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  });
  if (!sub || values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const json = Boolean(values.json);
  await withContext(values, async (ctx) => {
    switch (sub) {
      case "create": {
        const name = positionals.join(" ");
        if (!name || !values.owner)
          throw new CliError("Name and --owner are required", 2, "missing_argument");
        const owner = await ctx.users.byEmail(values.owner as string);
        if (!owner) throw new CliError(`No user with email ${values.owner}`, 1, "not_found");
        const entityType = ((values["entity-type"] as string) ?? "single_member_llc") as EntityType;
        const template = ((values.template as string) ?? defaultTemplateForEntity(entityType)) as CoaTemplate;
        if (!COA_TEMPLATES.includes(template))
          throw new CliError(`Unknown template ${template}`, 2, "invalid_argument");
        const res = await ctx.orgs.create({
          name,
          createdBy: owner.id,
          entityType,
          coaTemplate: template,
          fiscalYearStartMonth: Number(values["fiscal-start"] ?? 1),
          booksStartDate: (values["start-date"] as string) ?? `${new Date().getUTCFullYear()}-01-01`,
        });
        emit(json, { id: res.id, name }, () => process.stdout.write(`Created org ${name} (${res.id})\n`));
        return;
      }
      case "list": {
        const rows = (await ctx.orgs.list({ includeArchived: Boolean(values.all) })).map((o) => ({
          id: o.id,
          name: o.name,
          created_at: o.createdAt,
          archived: Boolean(o.archivedAt),
        }));
        emit(json, rows, () => table(rows));
        return;
      }
      case "archive": {
        const id = positionals[0];
        if (!id || !(await ctx.orgs.get(id))) throw new CliError("Unknown org id", 1, "not_found");
        await ctx.orgs.archive(id, systemActor());
        emit(json, { ok: true, id }, () => process.stdout.write(`Archived ${id}\n`));
        return;
      }
      case "delete": {
        const id = positionals[0];
        if (!id || !(await ctx.orgs.get(id))) throw new CliError("Unknown org id", 1, "not_found");
        if (!values.yes) throw new CliError("Refusing to delete without --yes", 2, "confirmation_required");
        await ctx.orgs.destroy(id);
        emit(json, { ok: true, id }, () => process.stdout.write(`Deleted ${id}\n`));
        return;
      }
      default:
        throw new CliError(`Unknown org command: ${sub}\n${USAGE}`, 2, "unknown_command");
    }
  });
}
