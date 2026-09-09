import { type ReactNode } from "react";
import { BRAND_GRADIENT } from "./gradients";

interface IconTileProps {
  children: ReactNode;
  className?: string;
  /** Highlight to the accent color (used while streaming). */
  active?: boolean;
  /** Background style when not active — defaults to the brand gradient. */
  background?: string;
}

/**
 * Shared icon tile — the rounded square inside machine / host cards. When
 * `active`, switches to the accent background + text color; otherwise falls
 * back to the brand gradient.
 */
export function IconTile({
  children,
  className,
  active,
  background = BRAND_GRADIENT,
}: IconTileProps) {
  return (
    <div
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
        active
          ? "bg-(--color-accent-soft) text-(--color-accent)"
          : "text-white/80"
      } ${className ?? ""}`}
      style={active ? undefined : { background }}
    >
      {children}
    </div>
  );
}
