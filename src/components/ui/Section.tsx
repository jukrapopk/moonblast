import { type ReactNode } from "react";

interface SectionProps {
  title: string;
  children: ReactNode;
}

export function Section({ title, children }: SectionProps) {
  return (
    // `lrud-container` opts the section into the LRUD library's container
    // model: the spatial library remembers the last-focused row inside
    // each section and returns to it on re-entry, instead of dumping
    // focus to the first row every time.
    <div className="lrud-container rounded-2xl border border-(--color-border) bg-(--color-surface)">
      <div className="border-b border-(--color-border) px-5 py-3 text-base font-semibold text-(--color-text)">
        {title}
      </div>
      <div className="divide-y divide-(--color-border) px-5">{children}</div>
    </div>
  );
}
