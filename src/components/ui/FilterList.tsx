import { Fragment, useMemo, useState, type ReactNode } from "react";
import { MagnifyingGlass, SortAscending, SortDescending } from "@phosphor-icons/react";
import { Input } from "./Input";
import { EmptyMessage } from "./EmptyMessage";

interface FilterListOptions<T> {
  /** Stable identity key (e.g. path). */
  getKey: (i: T) => string;
  /** Display name — used for search and A↔Z sorting. */
  getLabel: (i: T) => string;
  /** Source tag ("", "Store", "Steam", …). Empty maps to the label in `sourceLabels`. */
  getSource: (i: T) => string;
  /** Skip items (e.g. already-added). */
  exclude?: (i: T) => boolean;
  /** Custom labels for source tags; default maps "" → "Desktop". */
  sourceLabels?: Record<string, string>;
}

interface FilterListProps<T> {
  items: T[];
  options: FilterListOptions<T>;
  render: (item: T) => ReactNode;
  empty: ReactNode;
  /** While true, render `loading` instead of the list/empty state. */
  loading?: boolean;
  loadingPlaceholder?: ReactNode;
  searchPlaceholder?: string;
  /** Right-aligned control in the header row (e.g. a "Browse" button).
   *  Rendered next to the sort toggle so the header stays in one line. */
  headerAction?: ReactNode;
}

/**
 * Reusable search + source-filter + A↔Z-sorted list.
 * Renders a scrollable list; callers supply item rendering and the empty state.
 */
export function FilterList<T>({
  items,
  options,
  render,
  empty,
  loading,
  loadingPlaceholder,
  searchPlaceholder = "Search",
  headerAction,
}: FilterListProps<T>) {
  const { getKey, getLabel, getSource, exclude, sourceLabels = { "": "Desktop" } } = options;
  const [q, setQ] = useState("");
  const [source, setSource] = useState<string | null>(null); // null = all sources
  const [desc, setDesc] = useState(false);

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (!exclude?.(i)) set.add(getSource(i));
    const nonEmpty = [...set].filter((s) => s !== "").sort();
    return { nonEmpty, hasDesktop: set.has("") };
  }, [items, exclude, getSource]);

  const chips = useMemo(() => {
    const list: { value: string | null; label: string }[] = [{ value: null, label: "All" }];
    if (sources.hasDesktop) list.push({ value: "", label: sourceLabels[""] ?? "Desktop" });
    for (const s of sources.nonEmpty) list.push({ value: s, label: sourceLabels[s] ?? s });
    return list;
  }, [sources, sourceLabels]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const arr = items.filter((i) => {
      if (exclude?.(i)) return false;
      if (source !== null && getSource(i) !== source) return false;
      if (ql && !getLabel(i).toLowerCase().includes(ql)) return false;
      return true;
    });
    const byName = (a: T, b: T) =>
      getLabel(a).toLowerCase().localeCompare(getLabel(b).toLowerCase());
    return [...arr].sort(desc ? (a, b) => byName(b, a) : byName);
  }, [items, q, source, desc, exclude, getLabel, getSource]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex-1">
          <Input
            icon={<MagnifyingGlass size={16} weight="bold" />}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder={searchPlaceholder}
            autoFocus
          />
        </div>
        {headerAction}
        <button
          onClick={() => setDesc((d) => !d)}
          title={desc ? "Sort A→Z" : "Sort Z→A"}
          aria-label={desc ? "Sort A→Z" : "Sort Z→A"}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-(--color-border) text-(--color-muted) transition hover:text-(--color-text)"
        >
          {desc ? <SortDescending size={18} weight="bold" /> : <SortAscending size={18} weight="bold" />}
        </button>
      </div>

      {chips.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button
              key={c.value ?? "all"}
              onClick={() => setSource(c.value)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                source === c.value
                  ? "bg-(--color-accent) text-white"
                  : "border border-(--color-border) text-(--color-muted) hover:text-(--color-text)"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <div className="lrud-container max-h-80 space-y-1 overflow-y-auto p-1">
        {loading ? (
          loadingPlaceholder ?? <EmptyMessage>Loading</EmptyMessage>
        ) : filtered.length === 0 ? (
          empty
        ) : (
          filtered.map((i) => <Fragment key={getKey(i)}>{render(i)}</Fragment>)
        )}
      </div>
    </div>
  );
}