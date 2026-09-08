import { useState } from "react";

interface ToggleProps {
  defaultOn?: boolean;
  /** Controlled value; when provided, the toggle is controlled. */
  checked?: boolean;
  onChange?: (value: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ defaultOn = false, checked, onChange, disabled }: ToggleProps) {
  const [internal, setInternal] = useState(defaultOn);
  const on = checked ?? internal;

  function toggle() {
    if (disabled) return;
    setInternal(!on);
    onChange?.(!on);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      disabled={disabled}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
        disabled ? "opacity-40" : on ? "bg-(--color-accent)" : "bg-(--color-border)"
      }`}
    >
      <span
        className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${
          on ? "left-6" : "left-1"
        }`}
      />
    </button>
  );
}
