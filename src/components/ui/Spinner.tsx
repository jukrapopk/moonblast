import { ArrowsClockwise } from "@phosphor-icons/react";
import { useForeground } from "../../hooks/foreground";

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
 *
 * The spin is suspended while the window is backgrounded (the shared
 * `foreground.ts` condition) — a continuous animation has no audience
 * behind a game / stream, and it resumes on return.
 */
export function Spinner({ size = 14, className = "", spinning = true }: SpinnerProps) {
  const foreground = useForeground();
  return (
    <ArrowsClockwise
      size={size}
      weight="bold"
      className={`${spinning && foreground ? "animate-spin" : ""} ${className}`.trim()}
    />
  );
}
