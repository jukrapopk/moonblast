import { type ReactNode } from "react";

interface IconTileProps {
  children: ReactNode;
  className?: string;
  /** Highlight to the accent color (used while streaming). */
  active?: boolean;
  /** Background style when not active — defaults to a subtle theme-
   *  aware gradient (lighter tone of the room). Pass any CSS
   *  background to override (e.g. a per-host gradient). */
  background?: string;
}

const DEFAULT_BG = "var(--color-surface-2)";

/**
 * Shared icon tile — the rounded square inside machine / host cards. When
 * `active`, switches to the accent background + text color; otherwise
 * defaults to a flat surface-2 tone that pops against the bg. Pass
 * any CSS background string to override (e.g. a per-host color).
 */
export function IconTile({
  children,
  className,
  active,
  background = DEFAULT_BG,
}: IconTileProps) {
  return (
    <div
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
        active
          ? "bg-(--color-accent-soft) text-(--color-accent)"
          : "bg-(--color-surface-2) text-(--color-muted)"
      } ${className ?? ""}`}
      style={active ? undefined : { background }}
    >
      {children}
    </div>
  );
}
