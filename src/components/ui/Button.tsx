import { type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "outline-accent" | "outline" | "ghost" | "danger";
type Size = "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /**
   * Built-in size shortcuts. `md` is the default pill button (small padding
   * + text-sm); `lg` is for modal footers (larger padding). Pass an extra
   * `className` to override padding, font-weight, height, etc. per-call-site.
   */
  size?: Size;
  icon?: ReactNode;
}

const base =
  "inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition disabled:opacity-40 disabled:cursor-not-allowed";

const sizeClasses: Record<Size, string> = {
  md: "px-3 py-1.5 text-sm",
  lg: "px-5 py-2 text-sm",
};

const variantClasses: Record<Variant, string> = {
  primary: "bg-(--color-accent) text-white enabled:hover:brightness-110",
  "outline-accent":
    "border border-(--color-accent) text-(--color-accent) enabled:hover:bg-(--color-accent-soft)",
  outline:
    "border border-(--color-border) text-(--color-muted) enabled:hover:text-(--color-text)",
  ghost: "text-(--color-muted) enabled:hover:text-(--color-text)",
  danger:
    "border border-(--color-border) text-(--color-muted) enabled:hover:border-(--color-danger) enabled:hover:text-(--color-danger)",
};

/**
 * Shared button primitive. Five visual variants across two pill sizes (`md`
 * /`lg`). Pass any extra props (e.g. `title`, `aria-label`, `disabled`)
 * through; `className` extends the built-in styling.
 */
export function Button({
  variant = "primary",
  size = "md",
  icon,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={[base, sizeClasses[size], variantClasses[variant], className]
        .filter(Boolean)
        .join(" ")}
    >
      {icon}
      {children}
    </button>
  );
}
