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
  /**
   * Wrapper class passthrough so callers can size the slider (e.g.
   * `w-44`) without prop drilling. Defaults to `w-full`.
   */
  className?: string;
}

/**
 * Shared chrome-free range slider. Native `<input type="range">` with
 * the accent-color tinted track and a focus ring on a rounded wrapper.
 *
 * Range inputs are replaced elements: their outline ignores
 * border-radius and wraps the full rectangular element, so we draw
 * the ring on the rounded wrapper via `:focus-within` instead. The
 * inner `<input>` gets `outline: none` so the wrapper's ring is the
 * only one rendered.
 *
 * Use this when the slider is the sole focusable control on its row.
 * For combined controls (e.g. mute + slider), wrap in your own
 * focusable element and use a raw `<input type="range">` underneath.
 */
export function Slider({
  value,
  onChange,
  label,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  className = "w-full",
}: SliderProps) {
  return (
    <div
      className={`rounded-full transition focus-within:shadow-[0_0_0_2px_var(--color-accent)] ${
        disabled ? "cursor-not-allowed opacity-40" : ""
      } ${className}`}
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
        className="w-full cursor-pointer appearance-none bg-transparent !outline-none focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        style={{ accentColor: "var(--color-accent)" }}
      />
    </div>
  );
}
