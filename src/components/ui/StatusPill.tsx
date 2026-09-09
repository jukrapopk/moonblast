import { type ReactNode } from "react";

type Tone = "accent" | "muted";

interface StatusPillProps {
  tone?: Tone;
  /** Show a leading animated dot (use for "streaming/active" badges). */
  pulse?: boolean;
  /** Larger padding for pills that carry more text. */
  size?: "sm" | "md";
  children: ReactNode;
}

const toneClasses: Record<Tone, string> = {
  accent: "bg-(--color-accent-soft) text-(--color-accent)",
  muted: "bg-(--color-muted-soft) text-(--color-muted)",
};

/**
 * Shared status pill — used for the streaming / online / offline badges on
 * machine cards. `pulse` adds the animated leading dot.
 */
export function StatusPill({
  tone = "accent",
  pulse = false,
  size = "sm",
  children,
}: StatusPillProps) {
  const padding = size === "md" ? "px-2.5 py-1" : "px-2 py-0.5";
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded-full text-xs font-medium ${padding} ${toneClasses[tone]}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current ${
          pulse ? "animate-pulse" : tone === "muted" ? "opacity-40" : ""
        }`}
      />
      {children}
    </span>
  );
}
