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
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.currentTarget.value))}
      className="w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
      style={{ accentColor: "var(--color-accent)" }}
    />
  );
}
