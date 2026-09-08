import { type ReactNode } from "react";

interface RowProps {
  label: string;
  description?: string;
  children?: ReactNode;
}

export function Row({ label, description, children }: RowProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div>
        <div className="text-base font-medium text-(--color-text)">{label}</div>
        {description && (
          <div className="mt-0.5 text-sm text-(--color-muted)">{description}</div>
        )}
      </div>
      {children}
    </div>
  );
}
