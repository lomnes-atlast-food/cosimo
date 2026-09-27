import { getKey, listKeys, loadConfig, SECRET_KEYS, saveConfig, setKey } from "../../config.ts";
import { SecretBox } from "../../crypto.ts";
import { CliError, emit, parse, table } from "../util.ts";

const USAGE = `cosimo config <command>
  list                 Show all keys (secrets masked)
  get <section.key>    Print one value (secrets masked unless --reveal)
  set <section.key> <value>
  path                 Print the config file path`;

export async function configCommand(argv: string[]) {
  const [sub, ...rest] = argv;
  const { values, positionals } = parse(rest, { reveal: { type: "boolean", default: false } });
  if (!sub || values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const json = Boolean(values.json);
  const loaded = loadConfig(values.config);
  if (sub === "path") {
    emit(json, { path: loaded.path, exists: loaded.exists }, () => process.stdout.write(`${loaded.path}\n`));
    return;
  }
  if (!loaded.exists) throw new CliError(`No config at ${loaded.path}`, 1, "no_instance");
  switch (sub) {
    case "list": {
      const rows = listKeys(loaded.effective);
      emit(json, rows, () => table(rows.map((r) => ({ key: r.key, value: String(r.value) }))));
      return;
    }
    case "get": {
      const key = positionals[0] ?? "";
      let v = getKey(loaded.effective, key);
      if (SECRET_KEYS.has(key) && v) {
        if (values.reveal) {
          const box = new SecretBox(loaded.effective.security.master_key);
          v = key === "security.master_key" ? v : box.reveal(String(v));
        } else v = "********";
      }
      emit(json, { key, value: v }, () => process.stdout.write(`${v}\n`));
      return;
    }
    case "set": {
      const [key, value] = positionals;
      if (!key || value === undefined)
        throw new CliError("Usage: cosimo config set <section.key> <value>", 2);
      if (key === "security.master_key") {
        throw new CliError("Changing the master key would make encrypted secrets unreadable.", 2, "refused");
      }
      let stored = value;
      if (SECRET_KEYS.has(key) && value)
        stored = new SecretBox(loaded.effective.security.master_key).encrypt(value);
      saveConfig(
        loaded.path,
        setKey(loaded.file, key, stored),
        loaded.file.instance.target === "local" ? undefined : { mode: 0o644, secretsInFile: false },
      );
      emit(json, { ok: true, key }, () => process.stdout.write(`Set ${key}. Restart the server to apply.\n`));
      return;
    }
    default:
      throw new CliError(`Unknown config command: ${sub}\n${USAGE}`, 2, "unknown_command");
  }
}
