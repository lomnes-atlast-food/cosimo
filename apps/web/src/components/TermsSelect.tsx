import { ON_DUE_DATE, TERM_PRESETS } from "@cosimo/shared";
import { Select } from "./ui";

/**
 * Payment terms as a preset dropdown. A saved value that isn't a preset (custom text such as
 * "2/10 Net 30") still shows as an extra option, so opening and saving never loses it.
 * `emptyLabel` adds a first option with no value (for example "Org default"); `allowOnDueDate`
 * is off for defaults, where "On due date" has no meaning.
 */
export function TermsSelect({
  id,
  value,
  onChange,
  emptyLabel,
  allowOnDueDate = true,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  emptyLabel?: string;
  allowOnDueDate?: boolean;
}) {
  const presets = TERM_PRESETS.filter((t) => allowOnDueDate || t !== ON_DUE_DATE);
  const custom = value && !(presets as readonly string[]).includes(value);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {emptyLabel && <option value="">{emptyLabel}</option>}
      {custom && <option value={value}>{value}</option>}
      {presets.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </Select>
  );
}
