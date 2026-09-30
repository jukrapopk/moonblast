import { useSyncExternalStore } from "react";

/**
 * The app's single "is this window in the foreground?" condition.
 *
 * Every surface that polls, listens for push events, or otherwise keeps
 * updating itself gates on this — poll timers, `setInterval`s, and the
 * handlers behind Tauri push events all early-return while it is `false`.
 * One rule, one place: a window the user has left (a game or a Moonlight
 * stream in front) does no work at all, and picks straight back up on the
 * transition into the foreground, which also fires a refresh so a surface
 * never returns with stale data.
 *
 * Foreground = visible **and** focused. Visibility alone is not enough:
 * a window that is merely unfocused is still composited on screen, so
 * Chromium keeps its timers running at full rate even though the user is
 * looking at another app.
 *
 * The two auxiliary surfaces — the `overlay` status notch and the `osd`
 * volume bar — are built to be shown *over* another app, so they never
 * hold focus. They are treated as foreground whenever they are visible
 * (Rust still hides the notch under autohide, which flips the document
 * hidden and correctly suspends them).
 *
 * This is the one condition referenced across the app. Do not add
 * per-hook visibility / focus checks — change this file instead.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

let initialized = false;
let current = true;

/** The always-on-top auxiliary windows never take focus by design. */
function isAuxWindow(): boolean {
  if (typeof document === "undefined") return false;
  const role = document.documentElement.dataset.window;
  return role === "overlay" || role === "osd";
}

function compute(): boolean {
  if (typeof document === "undefined") return true;
  if (document.visibilityState !== "visible") return false;
  if (isAuxWindow()) return true;
  return document.hasFocus();
}

function emit() {
  const next = compute();
  if (next === current) return;
  current = next;
  for (const listener of Array.from(listeners)) listener();
}

// Registered lazily on first use: `document.documentElement.dataset.window`
// (which marks the aux windows) is set by `main.tsx` *after* the imported
// modules evaluate, so this can't run at module scope.
function ensureInit() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  current = compute();
  window.addEventListener("focus", emit);
  window.addEventListener("blur", emit);
  document.addEventListener("visibilitychange", emit);
}

/** True while this window is in the foreground. */
export function isForeground(): boolean {
  ensureInit();
  return current;
}

/** Subscribe to foreground transitions. Returns an unsubscribe. */
export function subscribeForeground(listener: Listener): () => void {
  ensureInit();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding — re-renders when the foreground state flips. */
export function useForeground(): boolean {
  return useSyncExternalStore(subscribeForeground, isForeground, () => true);
}
