/**
 * Typed wrapper around `@bbc/tv-lrud-spatial` — a DOM-rect-based directional
 * focus algorithm. The library only knows about elements on screen; the rest
 * of the input pipeline (containers, focus traps, restore, Enter/Escape,
 * gamepad) is built on top of it in this directory.
 *
 * Why a wrapper
 * -------------
 *  - The package's `.d.ts` declares `keyCode: number`. We want to pass
 *    `"ArrowUp"` / `"ArrowLeft"` (the modern `KeyboardEvent.key` value)
 *    and get a clean TS API, so we normalise here.
 *  - Centralises the focusable-selector contract. Components just need to
 *    render native buttons / inputs / links and the library finds them.
 *  - Adds a tiny convenience for "give me the first focusable inside this
 *    scope" — used by modal autoFocus and view mount.
 */
import { getNextFocus } from "@bbc/tv-lrud-spatial";

export type Direction = "up" | "down" | "left" | "right";

/** Internal keyCode table — mirrors the library's `_keyMap`. We translate
 *  `KeyboardEvent.key` strings into these so the rest of the codebase can
 *  pass `e.key` directly. */
const KEY_TO_DIRECTION: Record<string, Direction | undefined> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

// The package's `.d.ts` types the second argument as `number`, but the
// runtime `_keyMap` happily accepts the string forms of `KeyboardEvent.key`
// ("ArrowUp" etc.). Cast through `unknown` so we get the friendlier string
// API at call sites without `as any` peppering the codebase.
const _getNextFocus = getNextFocus as unknown as (
  current: Element | null,
  keyOrKeyCode: number | string,
  scope?: HTMLElement,
) => HTMLElement | null;

/**
 * Move focus from `current` in `direction`, scoped to `scope` (or the
 * whole document). Returns the new element (already focused) or `null`
 * when no candidate was found.
 */
export function moveFocus(
  current: Element | null,
  direction: Direction,
  scope?: HTMLElement | null,
): HTMLElement | null {
  // The library accepts the string form of `KeyboardEvent.key` directly —
  // its `_keyMap` covers both `"ArrowUp"` and keyCode 38. We pass the
  // string so the contract is clear at call sites.
  const key = `Arrow${direction[0].toUpperCase()}${direction.slice(1)}` as
    | "ArrowUp"
    | "ArrowDown"
    | "ArrowLeft"
    | "ArrowRight";
  const next = _getNextFocus(current, key, scope ?? undefined);
  if (next) next.focus();
  return next;
}

/** Map a `KeyboardEvent.key` to a `Direction`, or `null` if it's not one. */
export function directionFromKey(key: string): Direction | null {
  return KEY_TO_DIRECTION[key] ?? null;
}

/**
 * Focus the first focusable inside `scope`, optionally narrowed by a CSS
 * selector. Used by modal autoFocus / view mount — modal body may have
 * multiple inputs and we want the first visible one.
 */
export function focusInitial(
  scope: HTMLElement,
  selector?: string,
): HTMLElement | null {
  const target = selector ? scope.querySelector<HTMLElement>(selector) : null;
  const fallback =
    target ??
    scope.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
  fallback?.focus();
  return fallback;
}
