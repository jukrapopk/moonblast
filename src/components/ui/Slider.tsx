interface SliderProps {
  /** 0–100. */
  value: number;
  onChange: (value: number) => void;
  label: string;
  disabled?: boolean;
}

/**
 * Shared volume-style slider. Native range input tinted with the accent
 * token — arrows/drag work with keyboard and gamepad focus out of the box.
 */
export function Slider({ value, onChange, label, disabled }: SliderProps) {
  return (
    <input
      type="range"
      min={0}
      max={100}
      value={value}
      aria-label={label}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.currentTarget.value))}
      className="w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
      style={{ accentColor: "var(--color-accent)" }}
    />
  );
}
