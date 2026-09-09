import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { useContextMenu } from "./ContextMenu";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Optional icon rendered on the left inside the field. */
  icon?: ReactNode;
}

const base =
  "h-10 w-full rounded-full border border-(--color-border) bg-(--color-surface-2) px-4 text-sm text-(--color-text) placeholder:text-(--color-muted) outline-none transition focus:border-(--color-accent) disabled:opacity-40";

/**
 * Shared styled input. Owns the text-editing right-click menu (Undo/Redo/
 * Cut/Copy/Paste/Select All) so every field gets it consistently.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { icon, className, onContextMenu, ...props },
  ref,
) {
  const ctx = useContextMenu();

  function handleContextMenu(e: React.MouseEvent<HTMLInputElement>) {
    const el = e.currentTarget;
    const hasSelection =
      el.selectionStart != null && el.selectionEnd != null && el.selectionEnd > el.selectionStart;
    const cmd = (name: string) => {
      try {
        document.execCommand(name);
      } catch {
        /* ignore */
      }
    };
    ctx.open(e, [
      { label: "Undo", onClick: () => cmd("undo") },
      { label: "Redo", onClick: () => cmd("redo") },
      { label: "Cut", disabled: !hasSelection, onClick: () => cmd("cut") },
      { label: "Copy", disabled: !hasSelection, onClick: () => cmd("copy") },
      { label: "Paste", onClick: () => { try { el.focus(); cmd("paste"); } catch {} } },
      {
        label: "Select All",
        onClick: () => {
          try {
            el.focus();
            el.select();
          } catch {}
        },
      },
    ]);
  }

  const cls = icon ? `${base} pl-10` : base;

  return (
    <>
      <div className="relative w-full">
        {icon && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-(--color-muted)">
            {icon}
          </span>
        )}
        <input
          ref={ref}
          {...props}
          onContextMenu={(e) => {
            handleContextMenu(e);
            onContextMenu?.(e);
          }}
          className={[cls, className].filter(Boolean).join(" ")}
        />
      </div>
    </>
  );
});