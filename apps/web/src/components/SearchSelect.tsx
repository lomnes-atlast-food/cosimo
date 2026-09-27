import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { filterOptions, type SearchOption } from "../lib/search";
import { cx, inputCls } from "./ui";

/**
 * A select you can type into (ARIA combobox). Typing filters by keyword; arrows move, Enter or Tab
 * picks, Esc closes. When the list is closed Enter is left alone, so it still submits the form.
 * `emptyLabel` adds a first option with the value "" (such as "All accounts" or "None").
 * `onCreate` adds a last row while typing, when no option has exactly that label: picking it (click,
 * or Enter when it is highlighted) passes the typed text, e.g. to create a customer with that name.
 * Tab never creates, so tabbing through a form can't add records by accident.
 */
export function SearchSelect({
  options,
  value,
  onChange,
  placeholder,
  emptyLabel,
  id,
  className,
  autoFocus,
  disabled,
  required,
  "aria-label": ariaLabel,
  onCreate,
  createLabel = (q) => `New "${q}"`,
}: {
  options: SearchOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  id?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  required?: boolean;
  "aria-label"?: string;
  onCreate?: (text: string) => void;
  createLabel?: (text: string) => string;
}) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const selected = options.find((o) => o.value === value);
  const typing = query !== null && query.trim() !== "";
  const typed = typing ? (query ?? "").trim() : "";
  const shown = useMemo(() => {
    const matches = filterOptions(options, typed);
    if (!typed) return emptyLabel !== undefined ? [{ value: "", label: emptyLabel }, ...matches] : matches;
    const exact = options.some((o) => o.label.trim().toLowerCase() === typed.toLowerCase());
    return onCreate && !exact ? [...matches, { value: CREATE, label: createLabel(typed) }] : matches;
  }, [options, typed, emptyLabel, onCreate, createLabel]);

  // The list is position: fixed at the input, so tables, scrolling rows and dialogs don't clip it.
  // It opens upward when there is more room above.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 8;
      const up = below < 200 && r.top > below;
      setPlace({
        left: r.left,
        width: r.width,
        maxHeight: Math.min(288, (up ? r.top - 8 : below) - 4),
        ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  useEffect(() => {
    if (open)
      listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const openList = () => {
    setOpen(true);
    setActive(
      Math.max(
        0,
        shown.findIndex((o) => o.value === value),
      ),
    );
  };
  const close = () => {
    setOpen(false);
    setQuery(null);
  };
  const choose = (o: SearchOption | undefined) => {
    if (!o) return;
    if (o.value === CREATE) onCreate?.(typed);
    else onChange(o.value);
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return openList();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.min(Math.max(i + step, 0), shown.length - 1));
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === "Tab" && open && typing && shown[active]?.value !== CREATE) {
      choose(shown[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div className={cx("relative", className)}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={disabled}
        required={required && !value}
        placeholder={selected ? selected.label : (placeholder ?? emptyLabel)}
        value={query ?? (value ? (selected?.label ?? "") : "")}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={(e) => e.target.select()}
        onClick={() => (open ? undefined : openList())}
        onBlur={close}
        onKeyDown={onKeyDown}
        className={cx(inputCls, "pr-8")}
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-zinc-400"
      >
        <path
          fill="currentColor"
          d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4Z"
        />
      </svg>
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          style={place}
          className="fixed z-50 min-w-64 overflow-auto rounded-md bg-white py-1 text-sm shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700"
        >
          {shown.length === 0 && <div className="px-3 py-2 text-zinc-500">No matches</div>}
          {shown.map((o, i) => {
            const heading = !typing && o.group && o.group !== shown[i - 1]?.group;
            return (
              <Row
                key={o.value || "__empty"}
                action={o.value === CREATE}
                o={o}
                i={i}
                id={`${listId}-${i}`}
                heading={heading ? o.group : undefined}
                hint={typing ? o.group : undefined}
                active={i === active}
                selected={o.value === value}
                onPick={() => choose(o)}
                onHover={() => setActive(i)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Value of the "New …" action row; never a real option value. */
const CREATE = "\u0000create";

function Row({
  o,
  action,
  i,
  id,
  heading,
  hint,
  active,
  selected,
  onPick,
  onHover,
}: {
  o: SearchOption;
  action: boolean;
  i: number;
  id: string;
  heading?: string;
  hint?: string;
  active: boolean;
  selected: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    <>
      {heading && (
        <div
          role="presentation"
          className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500"
        >
          {heading}
        </div>
      )}
      {/* The combobox input handles the keyboard; options aren't focused (aria-activedescendant). */}
      <div
        id={id}
        role="option"
        tabIndex={-1}
        aria-selected={active}
        data-index={i}
        // Keep focus in the input so blur doesn't close the list before the click lands.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPick}
        onMouseMove={onHover}
        className={cx(
          "flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5",
          active && "bg-brand-50 dark:bg-brand-600/40",
          selected && "font-medium",
          action && "border-t border-zinc-100 text-brand-700 dark:border-zinc-800 dark:text-gold-400",
        )}
      >
        <span>{action ? `+ ${o.label}` : o.label}</span>
        {hint && (
          <span aria-hidden="true" className="shrink-0 text-xs text-zinc-400">
            {hint}
          </span>
        )}
      </div>
    </>
  );
}
