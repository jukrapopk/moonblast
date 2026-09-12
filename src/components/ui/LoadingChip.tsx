import { ArrowsClockwise } from "@phosphor-icons/react";

interface LoadingChipProps {
  /** Label shown next to the spinner. Defaults to "Loading". */
  label?: string;
  /**
   * `default` (chip with border + surface fill — used in `Row` right
   * slots and the Display modal, where the chip replaces a control),
   * or `plain` (just spinner + text, no border or fill — used for
   * centered in-place loaders like the Add app list).
   */
  variant?: "default" | "plain";
  /** Minimum width so the chip doesn't visibly snap to the right when
   *  the real control loads. Defaults to a value close to a small
   *  `Select`. Pass a tailwind class to override. Ignored by `plain`. */
  className?: string;
}

/**
 * Inline loading affordance for `Row` right-slots that show an async
 * value (`Select` / `Toggle`), and for centered in-place loaders. Two
 * variants: `default` (chip with border + surface fill — replaces a
 * control so the row doesn't reflow) and `plain` (just the spinner
 * + text — centered loaders like the Add app list).
 */
export function LoadingChip({
  label = "Loading",
  variant = "default",
  className = "",
}: LoadingChipProps) {
  const base =
    "inline-flex h-9 items-center justify-center gap-1.5 text-xs text-(--color-muted) ";
  const frame =
    variant === "plain"
      ? ""
      : "min-w-[120px] rounded-full border border-(--color-border) bg-(--color-surface-2) px-3 ";
  return (
    <span className={base + frame + className}>
      <ArrowsClockwise size={12} weight="bold" className="animate-spin" />
      <span>{label}</span>
    </span>
  );
}
