import type { ReactNode } from "react";

/**
 * Small inline error pill used inside modals. Same look across
 * Wifi / Audio / Battery modals so the user sees a consistent
 * "this failed" surface everywhere.
 */
export function ErrorBanner({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={`mb-3 rounded-lg border border-(--color-danger)/30 bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger) ${className}`}
    >
      {children}
    </p>
  );
}
