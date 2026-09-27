import { useMemo } from "react";
import { type Account, TYPE_LABELS, TYPE_ORDER } from "../lib/ledger";
import { accountKeywords, type SearchOption } from "../lib/search";
import { SearchSelect } from "./SearchSelect";

const byCode = (x: Account, y: Account) => x.code.localeCompare(y.code, undefined, { numeric: true });

/** Accounts depth-first (sub-accounts under their parent, by code), each with its name path. */
function tree(accounts: Account[]) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const kids = new Map<string | null, Account[]>();
  for (const a of accounts) {
    const p = a.parent_id && byId.has(a.parent_id) ? a.parent_id : null;
    kids.set(p, [...(kids.get(p) ?? []), a]);
  }
  const out: { a: Account; path: string }[] = [];
  const walk = (p: string | null, prefix: string, depth: number) => {
    for (const a of (kids.get(p) ?? []).sort(byCode)) {
      const path = `${prefix}${a.name}`;
      out.push({ a, path });
      if (depth < 10) walk(a.id, `${path} › `, depth + 1);
    }
  };
  walk(null, "", 0);
  return out;
}

/**
 * Account picker grouped by type, searchable by code, name, type, description and everyday synonyms
 * ("coffee" finds Meals). Sub-accounts follow their parent and are labeled with their path
 * ("6124 · Software › Design tools"), so searching the parent's name finds them. Inactive accounts
 * are hidden unless currently selected.
 */
export function AccountSelect({
  accounts,
  value,
  onChange,
  types,
  placeholder = "Choose an account…",
  ...rest
}: {
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
  types?: Account["type"][];
  placeholder?: string;
  id?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  required?: boolean;
  "aria-label"?: string;
}) {
  const options = useMemo<SearchOption[]>(() => {
    const ordered = tree(accounts);
    return TYPE_ORDER.filter((t) => !types || types.includes(t)).flatMap((t) =>
      ordered
        .filter(({ a }) => a.type === t && (a.is_active || a.id === value))
        .map(({ a, path }) => ({
          value: a.id,
          label: `${a.code} · ${path}`,
          group: TYPE_LABELS[t],
          keywords: [
            a.subtype === "other" ? "" : a.subtype.replace(/_/g, " "),
            a.description ?? "",
            accountKeywords(a.name),
          ].join(" "),
        })),
    );
  }, [accounts, types, value]);
  return (
    <SearchSelect
      options={options}
      value={value}
      onChange={onChange}
      emptyLabel={placeholder}
      placeholder={placeholder}
      {...rest}
    />
  );
}
