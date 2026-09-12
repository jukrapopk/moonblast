import { ArrowsClockwise } from "@phosphor-icons/react";

interface LoadingChipProps {
  /** Label shown next to the spinner. Defaults to "Loading…". */
  label?: string;
  /** Minimum width so the chip doesn't visibly snap to the right when
   *  the real control loads. Defaults to a value close to a small
   *  `Select`. Pass a tailwind class to override. */
  className?: string;
}

/**
 * Inline loading affordance for `Row` right-slots that show an async
 * value (`Select` / `Toggle`). Matches the height of `Select` (h-9) so
 * the row doesn't reflow when the real control replaces it. Used by
 * the Display modal where monitor / mode / HDR IPC roundtrips each
 * take a few hundred ms and would otherwise leave the dropdown slot
 * as a blank control. Matches the spinner style already used in
 * `WifiModal` and `AudioModal`.
 */
export function LoadingChip({ label = "Loading", className = "" }: LoadingChipProps) {
  return (
    <span
      className={
        "inline-flex h-9 min-w-[120px] items-center justify-center gap-1.5 rounded-lg border border-(--color-border) bg-(--color-surface-2) px-3 text-xs text-(--color-muted) " +
        className
      }
    >
      <ArrowsClockwise size={12} weight="bold" className="animate-spin" />
      <span>{label}</span>
    </span>
  );
}
