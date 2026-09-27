import type { Role } from "@cosimo/shared";
import { ROLES } from "@cosimo/shared";
import { CliError, emit, parse, table, withContext } from "../util.ts";

const USAGE = `cosimo token <command>
  create --user <email> --org <org_id> --name <name> [--role R] [--propose-only]
  list [--user <email>] [--org <org_id>]
  revoke <token_id>`;

export async function tokenCommand(argv: string[]) {
  const [sub, ...rest] = argv;
  const { values, positionals } = parse(rest, {
    user: { type: "string" },
    org: { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
    "propose-only": { type: "boolean", default: false },
  });
  if (!sub || values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const json = Boolean(values.json);
  await withContext(values, async (ctx) => {
    switch (sub) {
      case "create": {
        if (!values.user || !values.org || !values.name)
          throw new CliError("--user, --org and --name are required", 2);
        const user = await ctx.users.byEmail(values.user as string);
        if (!user) throw new CliError(`No user ${values.user}`, 1, "not_found");
        const userRole = await ctx.orgs.membership(user.id, values.org as string);
        if (!userRole) throw new CliError("User is not a member of that org", 1, "not_member");
        const role = ((values.role as string) ?? "bookkeeper") as Role;
        if (!ROLES.includes(role)) throw new CliError(`Unknown role ${role}`, 2);
        const res = await ctx.users.createApiToken({
          userId: user.id,
          orgId: values.org as string,
          name: values.name as string,
          role,
          userRole,
          proposeOnly: Boolean(values["propose-only"]),
        });
        emit(json, { id: res.id, token: res.token, role: res.role }, () =>
          process.stdout.write(`Token (shown once): ${res.token}\nRole: ${res.role}\n`),
        );
        return;
      }
      case "list": {
        const user = values.user ? await ctx.users.byEmail(values.user as string) : null;
        const rows = (
          await ctx.users.listApiTokens({ userId: user?.id, orgId: values.org as string | undefined })
        ).map((t) => ({
          id: t.id,
          name: t.name,
          org: t.orgId,
          role: t.role,
          propose_only: t.proposeOnly,
          last_used: t.lastUsedAt ?? "",
          revoked: Boolean(t.revokedAt),
        }));
        emit(json, rows, () => table(rows));
        return;
      }
      case "revoke": {
        const t = await ctx.users.revokeApiToken(positionals[0] ?? "");
        if (!t) throw new CliError("Unknown token", 1, "not_found");
        emit(json, { ok: true, id: t.id }, () => process.stdout.write(`Revoked ${t.id}\n`));
        return;
      }
      default:
        throw new CliError(`Unknown token command: ${sub}\n${USAGE}`, 2, "unknown_command");
    }
  });
}
