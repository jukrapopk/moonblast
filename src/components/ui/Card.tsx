import { type ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  /** Highlight the border to show "this is the active one" (e.g. streaming host). */
  streaming?: boolean;
  /** Empty-state styling: dashed border. Padding/text styling stays with the caller. */
  dashed?: boolean;
}

/**
 * Shared surface card. Two visual variants:
 * - default: solid surface fill, normal border (or accent border when `streaming`)
 * - dashed: dashed border, no fill (used for empty-state placeholders)
 */
export function Card({ children, className, streaming, dashed }: CardProps) {
  if (dashed) {
    return (
      <div
        className={`rounded-2xl border border-dashed border-(--color-border) ${
          className ?? ""
        }`}
      >
        {children}
      </div>
    );
  }
  return (
    <div
      className={`flex items-center gap-4 rounded-2xl border bg-(--color-surface) p-4 ${
        streaming ? "border-(--color-accent)/40" : "border-(--color-border)"
      } ${className ?? ""}`}
    >
      {children}
    </div>
  );
}
