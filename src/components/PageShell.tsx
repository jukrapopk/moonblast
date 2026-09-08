import { type ReactNode } from "react";
import { motion } from "framer-motion";

interface PageShellProps {
  title: string;
  subtitle?: string;
  /** Right-aligned header controls (buttons, search, etc.) */
  actions?: ReactNode;
  /** A tab bar rendered between the header and content */
  tabs?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Shared page layout: title + subtitle header, optional actions and tab bar,
 * and a spaced content area on a centered, width-capped container.
 */
export function PageShell({
  title,
  subtitle,
  actions,
  tabs,
  children,
  className,
}: PageShellProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className={`mx-auto w-full max-w-6xl space-y-8 ${className ?? ""}`}
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-base text-(--color-muted)">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>

      {tabs}

      {children}
    </motion.div>
  );
}
