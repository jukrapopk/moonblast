import { type ReactNode } from "react";

/**
 * Shared uppercase section label used inside modals (Audio, Battery, etc.).
 * One visual style across the app — small caps, muted color, tight tracking.
 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
      {children}
    </div>
  );
}