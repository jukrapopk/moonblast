import { type KeyboardEvent } from "react";
import { CaretDown } from "@phosphor-icons/react";

interface SelectOption {
  label: string;
  value: string;
  /**
   * Render the option as non-selectable. The browser disables click +
   * keyboard selection; the option still appears in the dropdown for
   * visibility but is greyed out. Caller is responsible for not
   * passing a `value` that matches a disabled option.
   */
  disabled?: boolean;
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
        // Explicit tabIndex={0} ensures the LRUD library's getFocusables
        // picks up the select (it queries `[tabindex], a, input, button`
        // and a stray selector-substring bug in some versions could
        // miss the implicit tabindex of native form controls).
        tabIndex={0}
        onKeyDown={(e: KeyboardEvent<HTMLSelectElement>) => {
          // The spatial controller (see useSpatialController.ts) used
          // to early-return on <select> elements so arrows could cycle
          // dropdown options. We removed that — Up/Down now escapes
          // the select via spatial nav, matching the slider pattern.
          // Left/Right are kept free for the OS-native picker to
          // consume (e.g. open/close the dropdown) without our
          // keyboard nav interfering. We block default here so the
          // browser doesn't ALSO try to open the dropdown on Up/Down,
          // which would conflict with the spatial-nav focus move.
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
          }
        }}
        className="h-9 cursor-pointer appearance-none rounded-lg border border-(--color-border) bg-(--color-surface-2) pl-3 pr-9 text-sm text-(--color-text) outline-none transition focus:border-(--color-accent)"
      >
        {options.map((o) => {
          const opt = toOption(o);
          return (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
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
