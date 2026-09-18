import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useFocusRefresh } from "./useFocusRefresh";

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

  const read = useCallback(async (force = false) => {
    if (inFlight.current) return inFlight.current;
    const now = Date.now();
    // `force` bypasses the collapse window: callers that receive an
    // explicit "state changed" signal (Rust push events, a direct user
    // action) know the cached value is stale and want to issue the read
    // regardless of when the last one ran. The in-flight guard above
    // still collapses concurrent callers into one IPC.
    if (!force && now - lastReadAt.current < collapseMs) return;
    // Stamp `lastReadAt` *after* the invoke resolves (success or fail),
    // not before. Stamping first means a transient backend hiccup can
    // consume the collapse window and silently delay the next read by
    // up to `collapseMs`, even after the backend recovers.
    const p = (async () => {
      try {
        const v = await invoke<T>(command);
        setValue(v);
      } catch {
        setValue(null as T);
      }
      lastReadAt.current = Date.now();
    })();
    inFlight.current = p;
    try {
      await p;
    } finally {
      inFlight.current = null;
    }
  }, [command, collapseMs, setValue]);

  useEffect(() => {
    if (pollIntervalMs === undefined) return;
    const id = setInterval(() => void read(), pollIntervalMs);
    return () => clearInterval(id);
  }, [read, pollIntervalMs]);

  useFocusRefresh(() => void read(), [read]);

  return read;
}