import { type ReactNode } from "react";
import { Check } from "@phosphor-icons/react";

interface SegmentedOption<T extends string> {
  id: T;
  label: ReactNode;
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** "tabs" = pill tab bar; "value" = compact picker with check marks */
  variant?: "tabs" | "value";
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  variant = "tabs",
}: SegmentedProps<T>) {
  const tabs = variant === "tabs";
  return (
    <div
      className={
        tabs
          ? "inline-flex items-center gap-1 rounded-full bg-(--color-surface) p-1 ring-1 ring-(--color-border)"
          : "flex shrink-0 items-center gap-1 rounded-lg bg-(--color-surface-2) p-1"
      }
    >
      {options.map((o) => {
        const active = o.id === value;
        const base = "font-medium transition-colors";
        const style = tabs
          ? `rounded-full px-5 py-1.5 text-base ${base} ${
              active ? "bg-(--color-accent) text-white" : "text-(--color-muted) hover:text-(--color-text)"
            }`
          : `flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${base} ${
              active ? "bg-(--color-accent) text-white" : "text-(--color-muted) hover:text-(--color-text)"
            }`;
        return (
          <button key={o.id} onClick={() => onChange(o.id)} className={style}>
            {!tabs && active && <Check size={14} weight="bold" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
