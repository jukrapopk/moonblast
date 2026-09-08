import { type ReactNode } from "react";

interface SegmentedTabsProps<T extends string> {
  options: { id: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}

/** Pill-style tab bar for switching between views/modes. */
export function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
}: SegmentedTabsProps<T>) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-(--color-surface) p-1 ring-1 ring-(--color-border)">
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={`rounded-full px-5 py-1.5 text-base font-medium transition-colors ${
              active
                ? "bg-(--color-accent) text-white"
                : "text-(--color-muted) hover:text-(--color-text)"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
