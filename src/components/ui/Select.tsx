import { CaretDown } from "@phosphor-icons/react";

interface SelectOption {
  label: string;
  value: string;
}
export type SelectOptionInput = string | SelectOption;

interface SelectProps {
  options: SelectOptionInput[];
  value: string;
  onChange: (value: string) => void;
}

function toOption(o: SelectOptionInput): SelectOption {
  return typeof o === "string" ? { label: o, value: o } : o;
}

export function Select({ options, value, onChange }: SelectProps) {
  return (
    <div className="relative inline-block shrink-0">
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="h-9 cursor-pointer appearance-none rounded-lg border border-(--color-border) bg-(--color-surface-2) pl-3 pr-9 text-sm text-(--color-text) outline-none transition focus:border-(--color-accent)"
      >
        {options.map((o) => {
          const opt = toOption(o);
          return (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          );
        })}
      </select>
      <CaretDown
        size={14}
        weight="bold"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-(--color-muted)"
      />
    </div>
  );
}