import type { ReactNode } from "react";

/**
 * Centered muted message used for "Loading…", "Nothing here yet",
 * "No networks found", etc. — a single primitive so all empty
 * states share the same spacing and color.
 */
export function EmptyMessage({ children }: { children: ReactNode }) {
  return (
    <p className="py-4 text-center text-sm text-(--color-muted)">{children}</p>
  );
}
