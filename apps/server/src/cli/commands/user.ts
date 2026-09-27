import { instanceAudit } from "../../services/instance-audit.ts";
import { CliError, emit, parse, promptHidden, table, withContext } from "../util.ts";

const USAGE = `cosimo user <command>
  create <email> [--name N] [--admin]     Create a user and print a claim link
  list                                    List users
  disable <email> | enable <email>        Disable or re-enable a user
  reset-password <email> [--password-stdin]  Set a password (prompts) or print a reset link
  claim-link <email>                      Issue a new one-time claim link
  make-admin <email> [--revoke]           Grant or revoke instance admin`;

export async function userCommand(argv: string[]) {
  const [sub, ...rest] = argv;
  const { values, positionals } = parse(rest, {
    name: { type: "string" },
    admin: { type: "boolean", default: false },
    revoke: { type: "boolean", default: false },
    "password-stdin": { type: "boolean", default: false },
    link: { type: "boolean", default: false },
  });
  if (!sub || values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const json = Boolean(values.json);
  await withContext(values, async (ctx) => {
    const email = positionals[0];
    const must = async () => {
      if (!email) throw new CliError("Email required", 2, "missing_argument");
      const u = await ctx.users.byEmail(email);
      if (!u) throw new CliError(`No user with email ${email}`, 1, "not_found");
      return u;
    };
    const claimUrl = (t: string) => `${ctx.config.server.public_url}/claim/${t}`;
    switch (sub) {
      case "create": {
        if (!email) throw new CliError("Email required", 2, "missing_argument");
        const u = await ctx.users.create({
          email,
          name: (values.name as string) ?? "",
          isInstanceAdmin: Boolean(values.admin),
        });
        const link = await ctx.users.issueClaimLink(u.id);
        await instanceAudit(ctx.system, {
          userId: null,
          action: "user.create.cli",
          targetType: "user",
          targetId: u.id,
        });
        emit(
          json,
          {
            id: u.id,
            email: u.email,
            claim_link: claimUrl(link.token),
            claim_link_expires_at: link.expiresAt,
          },
          () => process.stdout.write(`Created ${u.email}\nClaim link: ${claimUrl(link.token)}\n`),
        );
        return;
      }
      case "list": {
        const users = (await ctx.users.list()).map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          admin: u.isInstanceAdmin,
          totp: u.totpEnabled,
          disabled: Boolean(u.disabledAt),
        }));
        emit(json, users, () => table(users));
        return;
      }
      case "disable":
      case "enable": {
        const u = await must();
        await ctx.users.setDisabled(u.id, sub === "disable");
        await instanceAudit(ctx.system, { action: `user.${sub}.cli`, targetType: "user", targetId: u.id });
        emit(json, { ok: true, id: u.id, disabled: sub === "disable" }, () =>
          process.stdout.write(`${sub}d ${u.email}\n`),
        );
        return;
      }
      case "reset-password": {
        const u = await must();
        let pw: string | null = null;
        if (values["password-stdin"])
          pw = (await new Response(Bun.stdin.stream()).text()).replace(/\r?\n$/, "");
        else if (process.stdin.isTTY && !json && !values.link)
          pw = await promptHidden(`New password for ${u.email}`);
        if (pw) {
          await ctx.users.setPassword(u.id, pw);
          await instanceAudit(ctx.system, {
            action: "user.reset_password.cli",
            targetType: "user",
            targetId: u.id,
          });
          emit(json, { ok: true, id: u.id }, () => process.stdout.write(`Password updated for ${u.email}\n`));
        } else {
          const link = await ctx.users.issueClaimLink(u.id, "password_reset", 24);
          emit(
            json,
            { ok: true, id: u.id, reset_link: claimUrl(link.token), expires_at: link.expiresAt },
            () => process.stdout.write(`Reset link: ${claimUrl(link.token)}\n`),
          );
        }
        return;
      }
      case "claim-link": {
        const u = await must();
        const link = await ctx.users.issueClaimLink(u.id);
        emit(json, { claim_link: claimUrl(link.token), claim_link_expires_at: link.expiresAt }, () =>
          process.stdout.write(`${claimUrl(link.token)}\n`),
        );
        return;
      }
      case "make-admin": {
        const u = await must();
        await ctx.users.setAdmin(u.id, !values.revoke);
        await instanceAudit(ctx.system, {
          action: "user.admin.cli",
          targetType: "user",
          targetId: u.id,
          detail: { admin: !values.revoke },
        });
        emit(json, { ok: true, id: u.id, is_instance_admin: !values.revoke }, () =>
          process.stdout.write(`${u.email} is ${values.revoke ? "no longer" : "now"} an instance admin\n`),
        );
        return;
      }
      default:
        throw new CliError(`Unknown user command: ${sub}\n${USAGE}`, 2, "unknown_command");
    }
  });
}
