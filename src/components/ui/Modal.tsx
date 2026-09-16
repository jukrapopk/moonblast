import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "@phosphor-icons/react";
import { useFocusTrap } from "../../input/useSpatialController";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  /** Bootstrap max-width class, e.g. "max-w-md" */
  width?: string;
  /**
   * Selector or element to focus when the modal opens. Defaults to the
   * first focusable inside the panel. Pass `"none"` to skip autoFocus
   * (e.g. when the panel doesn't have a sensible first stop).
   */
  initialFocus?: string | HTMLElement | null | "none";
}

/**
 * Modal panel with full focus-trap semantics:
 *   - Escape closes (registered on the global LIFO escape stack)
 *   - Arrow keys are constrained to the panel via `setSpatialScope`
 *   - On open, focus moves to `initialFocus` (or the first focusable)
 *   - On close, focus is restored to the element that was focused before
 *     the modal opened (typically the chip / button that triggered it)
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = "max-w-md",
  initialFocus,
}: ModalProps) {
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);

  // Stash onClose in a ref so callers passing inline callbacks don't
  // churn the focus-trap effect on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Focus trap owns the Escape handler (pushes one onto the LIFO stack
  // for the lifetime of the panel) AND scopes spatial movement to the
  // panel. Restore-on-close lives below.
  const initialFocusProp =
    initialFocus === "none" ? null : (initialFocus ?? undefined);
  useFocusTrap(panelEl, {
    onEscape: () => onCloseRef.current(),
    autoFocus: initialFocus !== "none",
    initialFocus: initialFocusProp as string | HTMLElement | null | undefined,
  });

  // Capture the previously-focused element when the modal opens so we
  // can restore on close. Mirrors the WAI-ARIA dialog pattern.
  const prevFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      prevFocused.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    } else if (prevFocused.current) {
      const el = prevFocused.current;
      // Defer past framer-motion's exit animation so the focus doesn't
      // fight the unmount.
      const id = requestAnimationFrame(() => {
        if (el.isConnected) el.focus();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Bridge the ref into state so `useFocusTrap` (which re-runs on
  // `panelEl` change) sees the live node.
  const setRefs = useCallback((node: HTMLDivElement | null) => {
    setPanelEl(node);
  }, []);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          // Close only when the press itself starts on the overlay (not when the
          // user drags out of the panel and releases here).
          onMouseDown={onClose}
          className="fixed inset-0 z-50 flex items-center justify-center bg-(--color-overlay) p-6 backdrop-blur-sm"
        >
          <motion.div
            ref={setRefs}
            initial={{ scale: 0.96, y: 8, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.96, y: 8, opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className={`w-full ${width} rounded-2xl border border-(--color-border) bg-(--color-surface-2) p-5`}
          >
            {(title || subtitle) && (
              <div className="mb-5 flex items-start justify-between">
                <div>
                  {title && <h2 className="text-lg font-semibold tracking-tight">{title}</h2>}
                  {subtitle && <p className="mt-0.5 text-sm text-(--color-muted)">{subtitle}</p>}
                </div>
                <button
                  onClick={onClose}
                  className="text-(--color-muted) transition hover:text-(--color-text)"
                >
                  <X size={20} weight="bold" />
                </button>
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
