/**
 * Global keyboard + gamepad controller. Owns a single `keydown` listener
 * on `window` that:
 *
 *   - routes Arrow keys through `@bbc/tv-lrud-spatial` (the current focus
 *     moves to the nearest candidate in the chosen direction)
 *   - routes Escape to a stack of registered handlers (LIFO; most
 *     recently registered handler runs first). This is what lets modals
 *     and context menus intercept Escape without the previous view also
 *     receiving it.
 *   - routes Enter / Space to a stack of registered "primary action"
 *     handlers — same LIFO model. The current focus's host can register
 *     itself and intercept Enter (e.g. a focused AppTile launching the
 *     app, a focused ContextMenuItem firing its `onClick`).
 *
 * Tab is intentionally NOT intercepted. Native browser Tab moves focus
 * through the document in tabindex order, which is the right behaviour
 * for keyboard users reaching form controls in Settings / modal inputs.
 * View cycling is handled by the gamepad shoulders (LB/RB) in `useGamepad`.
 *
 * Design notes
 * ------------
 *  - Single global listener: the spatial library is a pure DOM function
 *    that needs `document.activeElement`, so we route ALL keys through one
 *    place. Gamepad synthesises `KeyboardEvent`s which reach the same
 *    listener, so gamepad + keyboard share a single code path.
 *  - LIFO escape/enter stacks: each Modal / ContextMenu pushes a handler
 *    on open and pops it on close. The top of the stack wins.
 *  - `scopeRef` lets views / modals constrain spatial movement so arrows
 *    can't escape a modal panel. `setSpatialScope(el)` is called by the
 *    container that wants focus to be trapped within it.
 */
import { useEffect, useRef } from "react";
import { directionFromKey, focusInitial, moveFocus, type Direction } from "./spatialNav";
import { useSpatialControllerInternals } from "./controllerInternals";

type KeyHandler = (e: KeyboardEvent) => void;

interface EscapeStack {
  push(h: KeyHandler): () => void;
  top(): KeyHandler | null;
}

interface EnterStack {
  push(h: KeyHandler): () => void;
  top(): KeyHandler | null;
}

interface ScopeRef {
  current: HTMLElement | null;
}

/**
 * Module-level singletons. We don't use a React Context here because the
 * controller is global by nature — the same input pipeline should work
 * regardless of which view is mounted.
 */
const escapeStack: EscapeStack = (() => {
  const stack: KeyHandler[] = [];
  return {
    push(h) {
      stack.push(h);
      return () => {
        const i = stack.lastIndexOf(h);
        if (i >= 0) stack.splice(i, 1);
      };
    },
    top() {
      return stack[stack.length - 1] ?? null;
    },
  };
})();

const enterStack: EnterStack = (() => {
  const stack: KeyHandler[] = [];
  return {
    push(h) {
      stack.push(h);
      return () => {
        const i = stack.lastIndexOf(h);
        if (i >= 0) stack.splice(i, 1);
      };
    },
    top() {
      return stack[stack.length - 1] ?? null;
    },
  };
})();

const spatialScope: ScopeRef = { current: null };

// Wire peek accessors for the gamepad bridge. Runs once at module load.
useSpatialControllerInternals.registerPeeks(
  () => enterStack.top(),
  () => escapeStack.top(),
);

/**
 * Push an Escape handler. The returned function pops it. Handlers run in
 * LIFO order; the top handler wins and decides whether to `preventDefault`.
 */
export function pushEscapeHandler(h: KeyHandler): () => void {
  return escapeStack.push(h);
}

/** Same model for Enter / Space activation. */
export function pushEnterHandler(h: KeyHandler): () => void {
  return enterStack.push(h);
}

/** Constrain directional navigation to `el`. `null` = no constraint. */
export function setSpatialScope(el: HTMLElement | null): void {
  spatialScope.current = el;
}

/** Read the current scope — used by the gamepad bridge so D-pad arrows
 *  respect whatever modal / focus trap is active without going through
 *  the spatial controller's keydown listener. */
export function getSpatialScope(): HTMLElement | null {
  return spatialScope.current;
}

const readScope = () => spatialScope.current;

/**
 * Mount the global keyboard + gamepad listener. Should be called once,
 * at the app root. Returns nothing — the controller installs/teardown
 * happens in `useEffect`.
 *
 * Tab is intentionally not intercepted here — the browser's native
 * focus traversal handles form controls / native buttons / links in
 * document order. View cycling is the gamepad shoulders' job (see
 * `useGamepad`).
 */
/**
 * Walk up from `el` looking for an ancestor with
 * `data-lrud-scope-lock="horizontal|vertical|all"`. If found and `dir`
 * is in the locked set, return that element as a directional scope
 * override. Returns `null` if no directional lock applies (the caller
 * falls back to the default scope stack).
 *
 * `horizontal` locks Left/Right (e.g. the topbar — arrows can move
 * horizontally within the topbar but escape Up/Down). `vertical`
 * locks Up/Down. `all` locks every direction (the current modal
 * trap behaviour).
 */
function findDirectionalScope(
  el: Element | null,
  dir: Direction,
): HTMLElement | null {
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    const lock = cur.getAttribute?.("data-lrud-scope-lock");
    if (lock) {
      const dirs = lock.split(/\s+/);
      const locked =
        (dir === "left" || dir === "right")
          ? dirs.includes("horizontal") || dirs.includes("all")
          : dirs.includes("vertical") || dirs.includes("all");
      if (locked && cur instanceof HTMLElement) return cur;
      // Lock doesn't apply to this direction — keep walking in case a
      // closer ancestor has a different lock.
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Focus the TopBar button for the currently-active view
 * (`[data-active-view]`), if any. Used as the default handler for
 * Escape (no modal) and Up arrow (no directional lock above focus).
 */
function focusActiveViewButton(): HTMLElement | null {
  const btn = document.querySelector<HTMLElement>("[data-active-view]");
  if (btn) btn.focus();
  return btn;
}

export function useSpatialController() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // 1. Escape — LIFO stack of handlers wins (modal/menu close).
      //    When the stack is empty, fall through to the default handler:
      //    focus the TopBar button for the currently-active view, so the
      //    user gets a consistent "jump back to nav" escape hatch from
      //    anywhere on the page (e.g. from inside a Settings row).
      if (e.key === "Escape") {
        const h = escapeStack.top();
        if (h) {
          e.preventDefault();
          h(e);
          return;
        }
        const btn = focusActiveViewButton();
        if (btn) e.preventDefault();
        return;
      }

      // 2. Enter / Space — primary action of the focused element. Two
      //    paths: a registered handler (modal "submit"), or the browser's
      //    native button activation (let `<button>` fire its `onClick`).
      //    We only intercept when a handler is on the stack.
      if (e.key === "Enter" || e.key === " ") {
        const h = enterStack.top();
        if (h) {
          // Don't preventDefault if focus is already on a button — the
          // browser would have already triggered its click. We just give
          // the modal a chance to do its own thing first.
          h(e);
          return;
        }
        // Native button activation covers Enter/Space automatically — let
        // it through.
        return;
      }

      // 3. Arrow keys — spatial navigation.
      const dir = directionFromKey(e.key);
      if (dir) {
        // When focus is in a text input (search, rename, password), arrow
        // keys are text navigation, not focus movement. Same for
        // <textarea>. Suppress before calling the spatial library so it
        // doesn't yank focus out of the field.
        const a = document.activeElement;
        if (
          a instanceof HTMLInputElement &&
          (a.type === "text" ||
            a.type === "search" ||
            a.type === "email" ||
            a.type === "url" ||
            a.type === "password" ||
            a.type === "number")
        ) {
          return;
        }
        if (a instanceof HTMLTextAreaElement) return;
        // Native <select>: arrow keys cycle the open dropdown. Leave them
        // alone so the OS-native picker works.
        if (a instanceof HTMLSelectElement) return;
        // Native range input: arrow keys step the value. Same.
        if (a instanceof HTMLInputElement && a.type === "range") return;
        // Up-arrow "jump back to nav" escape hatch: when focus is in the
        // page (not inside a topbar-style horizontal lock) and there's no
        // modal, treat Up like Escape's no-modal fallback and focus the
        // active TopBar button. Lets the user return to nav from anywhere
        // on the page without first reaching the topbar via Up.
        if (dir === "up" && !escapeStack.top()) {
          const locked = findDirectionalScope(a, "up");
          if (!locked) {
            const btn = focusActiveViewButton();
            if (btn) {
              e.preventDefault();
              return;
            }
          }
        }
        // Directional scope lock: if a `data-lrud-scope-lock` ancestor
        // applies to this direction, use it as the library's scope so the
        // fallback search stays inside the locked container even when no
        // sibling matches.
        const dirScope = findDirectionalScope(a, dir);
        const scope = dirScope ?? readScope();
        e.preventDefault();
        moveFocus(document.activeElement, dir, scope);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Re-focus the most-recently-focused element inside `scope`. Used by
 * modals on open to honour a caller-provided `initialFocus` selector.
 * Re-exported from `./spatialNav` so consumers can `import { focusInitial }
 * from "../../input/useSpatialController"` alongside the other
 * controller hooks.
 */
export { focusInitial };

/**
 * Lightweight "focus trap" used by modals. While active, the spatial
 * scope is set to `panel` so arrows can move *within* the panel but not
 * escape it. Returned function undoes both: pops the escape / enter
 * handlers and clears the scope.
 */
export function useFocusTrap(
  panel: HTMLElement | null,
  opts: {
    onEscape: () => void;
    onEnter?: () => void;
    /** Called once the panel is mounted. Default: focus the first
     *  focusable inside the panel. */
    initialFocus?: string | HTMLElement | null;
    /** Set to false to skip the autoFocus behaviour (e.g. when the
     *  caller wants to manage it themselves). */
    autoFocus?: boolean;
  },
): void {
  const { onEscape, onEnter, initialFocus, autoFocus = true } = opts;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;

  useEffect(() => {
    if (!panel) return;
    // Push handlers + scope, then autoFocus.
    const popEscape = pushEscapeHandler(() => onEscapeRef.current());
    const popEnter = onEnterRef.current
      ? pushEnterHandler(() => onEnterRef.current!())
      : null;
    const prevScope = readScope();
    setSpatialScope(panel);

    if (autoFocus) {
      // Defer one frame so the panel's framer-motion enter animation
      // hasn't stolen focus mid-transition.
      const id = requestAnimationFrame(() => {
        if (!panel.isConnected) return;
        if (typeof initialFocus === "string") {
          focusInitial(panel, initialFocus);
        } else if (initialFocus instanceof HTMLElement) {
          initialFocus.focus();
        } else {
          focusInitial(panel);
        }
      });
      return () => {
        cancelAnimationFrame(id);
        popEscape();
        popEnter?.();
        setSpatialScope(prevScope);
      };
    }

    return () => {
      popEscape();
      popEnter?.();
      setSpatialScope(prevScope);
    };
  }, [panel, autoFocus, initialFocus]);
}
