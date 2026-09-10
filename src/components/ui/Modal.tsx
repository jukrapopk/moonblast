import { type ReactNode, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "@phosphor-icons/react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  /** Bootstrap max-width class, e.g. "max-w-md" */
  width?: string;
}

export function Modal({ open, onClose, title, subtitle, children, width = "max-w-md" }: ModalProps) {
  // Hold onClose in a ref so callers passing an inline `() => setX(false)`
  // don't churn the Escape listener on every parent render. The listener
  // is bound once per `open` flip and reads the latest callback.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Escape closes the modal (also reached via gamepad B).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

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