import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

interface ToastProps {
  /** When non-null, shows the toast with this message. */
  message: string | null;
}

export function Toast({ message }: ToastProps) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-(--color-surface-2) px-5 py-2.5 text-sm text-(--color-text) shadow-lg ring-1 ring-(--color-border)"
        >
          {message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Owns the toast message state and the auto-dismiss timer in one place,
 * so callers don't repeat the same `useState + setTimeout(..., 2500)`
 * effect. Returns `{ message, show, Toast }` — render `<Toast />` once
 * and call `show("…")` to flash it.
 */
export function useToast(dismissMs = 2500) {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!message) return;
    const id = setTimeout(() => setMessage(null), dismissMs);
    return () => clearTimeout(id);
  }, [message, dismissMs]);
  return {
    message,
    show: setMessage,
    Toast,
  };
}
