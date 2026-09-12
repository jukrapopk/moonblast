import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Shared "event-driven + collapse" read pattern used by the polling-free
 * hooks (`useWifi`) and the slow-poll hooks (`useBattery`). Collapses
 * concurrent / back-to-back callers into one read so focus + visibility
 * firing on the same refocus doesn't issue parallel invokes; refreshes
 * on mount, on window focus, and on `visibilitychange → visible`.
 *
 * The caller owns the state; this hook returns a `read` function that
 * updates state via `setValue` and a `refresh` alias bound to the same
 * read. The 2 s collapse window matches `useWifi`'s original behavior.
 */
export function useDebouncedRead<T>(
  command: string,
  setValue: (value: T) => void,
  options: {
    /** When set, re-read on this interval even without user input. */
    pollIntervalMs?: number;
    /** Override the 2 s collapse window. */
    collapseMs?: number;
  } = {},
) {
  const { pollIntervalMs, collapseMs = 2000 } = options;
  const inFlight = useRef<Promise<void> | null>(null);
  const lastReadAt = useRef(0);

  const read = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const now = Date.now();
    if (now - lastReadAt.current < collapseMs) return;
    lastReadAt.current = now;
    const p = (async () => {
      try {
        const v = await invoke<T>(command);
        setValue(v);
      } catch {
        setValue(null as T);
      }
    })();
    inFlight.current = p;
    try {
      await p;
    } finally {
      inFlight.current = null;
    }
  }, [command, collapseMs, setValue]);

  useEffect(() => {
    let alive = true;
    const safeRead = () => {
      if (alive) void read();
    };
    safeRead();
    const listeners: Array<() => void> = [];
    if (pollIntervalMs !== undefined) {
      const id = setInterval(safeRead, pollIntervalMs);
      listeners.push(() => clearInterval(id));
    }
    function onFocus() {
      safeRead();
    }
    function onVisibility() {
      if (document.visibilityState === "visible") safeRead();
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    listeners.push(() => window.removeEventListener("focus", onFocus));
    listeners.push(() => document.removeEventListener("visibilitychange", onVisibility));
    return () => {
      alive = false;
      for (const off of listeners) off();
    };
  }, [read, pollIntervalMs]);

  return read;
}