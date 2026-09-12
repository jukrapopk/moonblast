import { useState } from "react";

interface ToggleProps {
  defaultOn?: boolean;
  /** Controlled value; when provided, the toggle is controlled. */
  checked?: boolean;
  onChange?: (value: boolean) => void;
  disabled?: boolean;
  /**
   * Optional override for the rendered thumb position when `disabled`.
   * The default behavior renders the thumb on the left (off). Pass
   * `displayValue` when the disabled state needs to mirror an external
   * value (e.g. "Follow global" showing the OS-level HDR state).
   * Stored `checked` value is still untouched.
   */
  displayValue?: boolean;
}

export function Toggle({ defaultOn = false, checked, onChange, disabled, displayValue }: ToggleProps) {
  const [internal, setInternal] = useState(defaultOn);
  const on = checked ?? internal;
  // Disabled reads as off — visual only, the stored value is untouched.
  // `displayValue` overrides this for read-only mirrors of an external state.
  const visualOn = disabled ? (displayValue ?? false) : on;

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
        disabled
          ? "cursor-not-allowed bg-(--color-surface-2)"
          : visualOn
            ? "bg-(--color-accent)"
            : "bg-(--color-border)"
      }`}
    >
      <span
        className={`absolute top-1 h-5 w-5 rounded-full transition-all ${
          visualOn ? "left-6" : "left-1"
        } ${disabled ? "bg-(--color-muted)" : "bg-white"}`}
      />
    </button>
  );
}
