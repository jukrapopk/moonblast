import { type ReactNode } from "react";

interface SectionProps {
  title: string;
  children: ReactNode;
}

export function Section({ title, children }: SectionProps) {
  return (
    // Plain `<div>` — NOT `lrud-container`. The scrollable `<main>`
    // owns the directional scope (see App.tsx) and Sections stack
    // inside it, so cross-section Up/Down traverses row-by-row across
    // the whole scroll area instead of jumping to a Section's last
    // remembered child (the library's `data-focus` re-entry).
    <div className="rounded-2xl border border-(--color-border) bg-(--color-surface)">
      <div className="border-b border-(--color-border) px-5 py-3 text-base font-semibold text-(--color-text)">
        {title}
      </div>
      <div className="divide-y divide-(--color-border) px-5">{children}</div>
    </div>
  );
}
