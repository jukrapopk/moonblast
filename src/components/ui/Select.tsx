import { CaretDown } from "@phosphor-icons/react";

interface SelectProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
}

export function Select({ options, value, onChange }: SelectProps) {
  return (
    <div className="relative inline-block shrink-0">
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="h-9 cursor-pointer appearance-none rounded-lg border border-(--color-border) bg-(--color-surface-2) pl-3 pr-9 text-sm text-(--color-text) outline-none transition focus:border-(--color-accent)"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <CaretDown
        size={14}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-(--color-muted)"
      />
    </div>
  );
}
