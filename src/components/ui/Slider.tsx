interface SliderProps {
  /** Current value. */
  value: number;
  onChange: (value: number) => void;
  label: string;
  /** Inclusive lower bound. Defaults to 0. */
  min?: number;
  /** Inclusive upper bound. Defaults to 100. */
  max?: number;
  /** Step granularity. Defaults to 1 (every integer). */
  step?: number;
  disabled?: boolean;
}

/**
 * Shared volume-style slider. Native range input tinted with the accent
 * token — arrows/drag work with keyboard and gamepad focus out of the box.
 *
 * Focus ring lives on the rounded wrapper, not on the <input> itself.
 * Range inputs are replaced elements: their outline ignores
 * border-radius and wraps the full rectangular element, so we draw
 * the ring on the wrapper via `:has(:focus-visible)` instead. The
 * inner <input> gets `outline: none` so the wrapper's ring is the
 * only one rendered.
 */
export function Slider({
  value,
  onChange,
  label,
  min = 0,
  max = 100,
  step = 1,
  disabled,
}: SliderProps) {
  return (
    <div
      className={`rounded-full pt-1 pb-0.5 px-2 transition ${
        disabled
          ? "cursor-not-allowed opacity-40"
          : "focus-within:shadow-[0_0_0_2px_var(--color-accent)]"
      }`}
    >
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="w-full cursor-pointer !outline-none disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:outline-none"
        style={{ accentColor: "var(--color-accent)" }}
      />
    </div>
  );
}
