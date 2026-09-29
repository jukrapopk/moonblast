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
 *
 * The poll is **visibility-gated**: it only runs while the window is
 * visible, so a hidden surface (the notch under autohide, a minimized
 * launcher) issues no reads at all — `useFocusRefresh` re-reads when the
 * window comes back, so the value is fresh on return.
 */
export function useDebouncedRead<T>(
  command: string,
  setValue: (value: T) => void,
  options: {
    /** When set, re-read on this interval even without user input. */
    pollIntervalMs?: number;
    /** Override the 2 s collapse window. */
    collapseMs?: number;
    /**
     * When `false`, `read()` (mount, poll, focus/visibility, and
     * force-called) is a no-op and the poll interval isn't installed.
     * Used to suspend background chips the user hid in Customization —
     * e.g. `useBattery`'s 5 s poll shouldn't run at all if the battery
     * chip is off. Defaults to `true`. Toggling back to `true` fires an
     * immediate read (the `read` identity change re-runs the focus
     * effect below), so re-enabling a chip doesn't wait for the next
     * focus event to show live data.
     */
    enabled?: boolean;
  } = {},
) {
  const { pollIntervalMs, collapseMs = 2000, enabled = true } = options;
  const inFlight = useRef<Promise<void> | null>(null);
  const lastReadAt = useRef(0);

  const read = useCallback(async (force = false) => {
    if (!enabled) return;
    // Collapse *non-forced* concurrent callers: a focus event and a
    // visibilitychange event firing on the same refocus share one IPC.
    // But a forced call (Rust push event, direct user action) MUST
    // issue a fresh IPC — returning an in-flight promise that was
    // *sent before the state-change event* would surface the
    // pre-event value to the chip.
    if (!force && inFlight.current) return inFlight.current;
    const now = Date.now();
    // `force` bypasses the collapse window: callers that receive an
    // explicit "state changed" signal (Rust push events, a direct user
    // action) know the cached value is stale and want to issue the read
    // regardless of when the last one ran.
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
    if (!force) inFlight.current = p;
    try {
      await p;
    } finally {
      if (!force) inFlight.current = null;
    }
  }, [command, collapseMs, setValue, enabled]);

  // Poll only while the window is actually visible. A hidden window — the
  // overlay notch while autohide has it tucked away, a minimized launcher —
  // gets Chromium's background timer throttling anyway; stopping outright
  // makes an unseen chip free. `useFocusRefresh` above re-reads on
  // `visibilitychange → visible`, so the value is fresh the moment the window
  // comes back rather than waiting for the next tick.
  useEffect(() => {
    if (!enabled || pollIntervalMs === undefined) return;
    let id: ReturnType<typeof setInterval> | null = null;
    const sync = () => {
      const visible = document.visibilityState === "visible";
      if (visible && id === null) {
        id = setInterval(() => void read(), pollIntervalMs);
      } else if (!visible && id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      if (id !== null) clearInterval(id);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [read, pollIntervalMs, enabled]);

  useFocusRefresh(() => void read(), [read]);

  return read;
}