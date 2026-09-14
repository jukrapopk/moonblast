import { ArrowsClockwise } from "@phosphor-icons/react";

interface SpinnerProps {
  size?: number;
  /** Optional extra class names appended to the default "animate-spin". */
  className?: string;
  /** When false, omit the spinning animation (default true). */
  spinning?: boolean;
}

/**
 * Tiny loading spinner glyph used everywhere a row/button needs a
 * "working…" indicator. Defaults match the most common size (14px)
 * and class (animate-spin); call sites that need a different size or
 * conditional spinning pass `size` / `spinning`.
 */
export function Spinner({ size = 14, className = "", spinning = true }: SpinnerProps) {
  return (
    <ArrowsClockwise
      size={size}
      weight="bold"
      className={`${spinning ? "animate-spin" : ""} ${className}`.trim()}
    />
  );
}
