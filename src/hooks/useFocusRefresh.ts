import { useEffect, type DependencyList } from "react";
import { isForeground, subscribeForeground } from "./foreground";

/**
 * Run `fn` once on mount, then again on every transition into the
 * foreground (see `foreground.ts` — visible **and** focused). Cancels on
 * unmount via an `alive` flag so an in-flight async call doesn't
 * `setState` after unmount.
 *
 * This is the refresh half of the foreground gate: paired with a
 * `useDebouncedRead` / `useForegroundInterval` that suspends while
 * backgrounded, it guarantees the surface is current the moment the user
 * comes back.
 *
 * `enabled` (default `true`) skips the registration entirely when false —
 * so a caller that is mounted-but-idle (a modal rendered at the App root
 * with `open` as a prop) attaches no listeners at all, rather than
 * attaching them and fencing inside the callback. `enabled` is part of the
 * effect deps, so flipping it re-runs the effect and fires the initial
 * call on the way in. Mirrors `useForegroundInterval`'s flag.
 *
 *   useFocusRefresh(refresh);
 *   useFocusRefresh(() => scan(), [sub === "machines"]);
 *   useFocusRefresh(refresh, [open], open);
 */
export function useFocusRefresh(fn: () => void, deps?: DependencyList, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const safe = () => {
      if (alive) fn();
    };
    safe();
    const unsubscribe = subscribeForeground(() => {
      if (isForeground()) safe();
    });
    return () => {
      alive = false;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...(deps ?? []), enabled]);
}
