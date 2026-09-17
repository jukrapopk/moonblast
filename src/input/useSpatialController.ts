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
 *
 * Design notes
 * ------------
 *  - Single global keyboard listener.
 *  - LIFO escape/enter stacks: each Modal / ContextMenu pushes a handler
 *    on open and pops it on close. The top of the stack wins.
 *  - `spatialScope` lets views / modals constrain spatial movement so
 *    arrows can't escape a modal panel. `setSpatialScope(el)` is called
 *    by the container that wants focus to be trapped within it.
 *  - `lastFocusedRef` tracks the last element the user focused (via
 *    focusin / mousedown) so an arrow press after focus has been lost
 *    (e.g. clicked outside any focusable) restores focus rather than
 *    teleporting to the active view's nav button.
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

/**
 * Tracks the last element that received focus via keyboard or mouse
 * click. Module-level singleton — same rationale as the escape/enter
 * stacks and the spatial scope: the input pipeline is global, so the
 * focus history is too. Used by `processDirection` to re-establish
 * focus when arrows fire while focus is lost (e.g. clicked outside
 * any focusable).
 */
const lastFocusedRef: { current: HTMLElement | null } = { current: null };

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
function pushEnterHandler(h: KeyHandler): () => void {
  return enterStack.push(h);
}

/** Constrain directional navigation to `el`. `null` = no constraint. */
export function setSpatialScope(el: HTMLElement | null): void {
  spatialScope.current = el;
}

/** Read the current scope — exposed for components / tests that need to
 *  query which container arrows are trapped inside. */
export function getSpatialScope(): HTMLElement | null {
  return spatialScope.current;
}

const readScope = () => spatialScope.current;

/**
 * Track every focus change / click so `processDirection` can
 * re-establish focus when arrows fire while focus has been lost.
 * Called once from `useSpatialController`'s effect — module-level
 * so the focus history outlives any single mount of the controller.
 */
function trackFocusForRecovery(): () => void {
  function rememberFocus() {
    const el = document.activeElement;
    if (el && el !== document.body && el instanceof HTMLElement) {
      lastFocusedRef.current = el;
    }
  }
  document.addEventListener("focusin", rememberFocus, true);
  document.addEventListener("mousedown", rememberFocus, true);
  return () => {
    document.removeEventListener("focusin", rememberFocus, true);
    document.removeEventListener("mousedown", rememberFocus, true);
  };
}

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
 * Escape and Up arrow when no modal is open.
 *
 * `data-active-view` is set by `TopBarButton` only when the button's
 * `view === viewId` — but React's data-* handling has a quirk: an
 * attribute value of `false` (the JS literal — see the JSX in
 * TopBarButton's `active && viewId ? viewId : undefined` expression)
 * is serialised to the DOM string `"false"`. So inactive nav buttons
 * (Apps / Moonlight / Settings) all end up with `data-active-view="false"`
 * alongside the active button's `data-active-view="<view>"`. A bare
 * `[data-active-view]` selector returns whichever comes first in
 * DOM order — always the Apps button.
 *
 * Filter out the literal "false" (and empty) values with the `:not()`
 * pseudo-class so we only match the real active-view button.
 */
function focusActiveViewButton(): HTMLElement | null {
  const btn = document.querySelector<HTMLElement>(
    '[data-active-view]:not([data-active-view=""]):not([data-active-view="false"])',
  );
  if (btn) btn.focus();
  return btn;
}

/**
 * Shared directional-navigation entry point. Both the keyboard
 * listener (Arrow keys) and the gamepad poller (D-pad / left stick)
 * call this with the same arguments and get identical behaviour:
 *
 *   1. Lost-focus recovery: if nothing is focused, jump back to the
 *      last element the user touched (or the active view's nav
 *      button as a final fallback) and stop. The user can press the
 *      same arrow again to actually move.
 *   2. Text-input passthrough: arrow keys inside `<input>` (text /
 *      search / email / url / password / number) and `<textarea>`
 *      are caret movement, not focus jumps — let the browser handle
 *      them.
 *   3. `<select>` passthrough for Up/Down: native open/cycle wins,
 *      Left/Right still move focus spatially.
 *   4. `<input type="range">` Left/Right step the value; Up/Down
 *      escape so the user can leave without first clearing.
 *   5. Directional scope lock: `data-lrud-scope-lock="horizontal"`
 *      on the TopBar pins Left/Right inside the header (so cycling
 *      L→R stays in the nav, Up/Down escape into the page), etc.
 *   6. Up-arrow "jump to nav": if no modal is open and the library's
 *      normal search lands on a TopBar button (Euclidean distance
 *      would otherwise pick the wrong nav chip), redirect to the
 *      active view's nav button. Mid-content Up is unaffected.
 *   7. When no candidate exists above (top of scroll area) and no
 *      modal is open, also fall back to the active view's nav
 *      button — symmetric "jump to nav" from anywhere on the page.
 *
 * `preventDefault` is called after we decide the press is ours to
 * consume (so a text-input caret move still fires the browser's
 * native behaviour). Both keyboard and gamepad pass the same
 * `preventDefault` callback shape — the controller's keyboard path
 * uses `e.preventDefault()` directly, the gamepad path uses a
 * no-op (gamepad events don't have a native default to suppress).
 */
function processDirection(dir: Direction, preventDefault: () => void): void {
  // 1. Lost-focus recovery.
  if (!document.activeElement || document.activeElement === document.body) {
    preventDefault();
    const last = lastFocusedRef.current;
    if (
      last &&
      last.isConnected &&
      !last.hasAttribute("disabled") &&
      !(last instanceof HTMLInputElement && last.disabled)
    ) {
      last.focus();
    } else {
      focusActiveViewButton();
    }
    return;
  }
  // 2. Text-input caret passthrough.
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
  // 3. Native <select>: Left/Right are reserved for the OS-native
  //    picker (open/close dropdown, navigate options) — let those
  //    through. Up/Down escape to the next focusable via spatial
  //    nav, matching the slider pattern (see Select.tsx for the
  //    matching `preventDefault` that blocks the dropdown opening
  //    when Up/Down is pressed for spatial nav).
  if (a instanceof HTMLSelectElement) {
    if (dir === "left" || dir === "right") return;
  }
  // 4. Native range input: Left/Right step the value, Up/Down escape.
  if (a instanceof HTMLInputElement && a.type === "range") {
    if (dir === "left" || dir === "right") return;
  }
  // 5. Directional scope lock.
  const dirScope = findDirectionalScope(a, dir);
  const scope = dirScope ?? readScope();
  // 6. Up-arrow "jump to nav" + 7. top-of-scroll fallback.
  if (dir === "up" && !escapeStack.top()) {
    preventDefault();
    const next = moveFocus(a, "up", scope);
    if (next) {
      const topbar = document.querySelector("header.lrud-container");
      if (topbar?.contains(next)) {
        const activeBtn = focusActiveViewButton();
        if (activeBtn) return;
      }
      return;
    }
    const activeBtn = focusActiveViewButton();
    if (activeBtn) return;
    return;
  }
  preventDefault();
  moveFocus(a, dir, scope);
}

/**
 * Shared directional handler. The keyboard listener calls it
 * internally. Exported for any future caller that wants the same
 * arrow-key behaviour (e.g. a different input device bridge).
 */
export function dispatchDirection(dir: Direction): void {
  processDirection(dir, () => {});
}

export function useSpatialController() {
  useEffect(() => {
    const stopTracking = trackFocusForRecovery();
    function onKey(e: KeyboardEvent) {
      // 0. Context-menu shortcut. Two equivalent triggers:
      //    - The dedicated ContextMenu key on Windows keyboards
      //      (`e.key === "ContextMenu"`).
      //    - Shift+F10, the standard Windows shortcut for "show context
      //      menu for the focused element".
      // Both dispatch a synthetic `contextmenu` event on the focused
      // element so any React `onContextMenu` handler in the focus chain
      // fires — the same code path as a real right-click. No-op when
      // focus is on the body or another element without a context menu.
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        const target = document.activeElement;
        if (target && target !== document.body && target instanceof Element) {
          // Position the menu at the focused element's centre so the
          // shortcut behaves like a real right-click — without this,
          // the menu opens at viewport (0, 0). For very small targets
          // (e.g. an icon-only TopBar button) we offset slightly so the
          // menu doesn't sit exactly on the centre pixel.
          const rect = target.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          e.preventDefault();
          const synthetic = new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: cx,
            clientY: cy,
            view: window,
          });
          // Mark the event as keyboard-triggered so the context menu
          // knows to autoFocus its first item — mouse right-click
          // keeps focus where it was.
          (synthetic as MouseEvent & { __keyboard?: boolean }).__keyboard = true;
          target.dispatchEvent(synthetic);
        }
        return;
      }

      // 1. Escape — LIFO stack of handlers wins (modal/menu close).
      //    When the stack is empty, fall through to the default handler:
      //    focus the TopBar button for the currently-active view, so the
      //    user gets a consistent "jump back to nav" escape hatch from
      //    anywhere on the page (e.g. from inside a Settings row).
      //
      //    Suppressed while a modal is open (`spatialScope` is set).
      //    Escape may briefly find no stack handler during the ~16ms
      //    close-restore window in Modal.tsx (its handler has popped,
      //    but focus hasn't moved back to the trigger yet). Without
      //    this guard that window would let `focusActiveViewButton()`
      //    fire and yank focus to the TopBar while the user is still
      //    looking at the modal. Modal.tsx's `focusin` sanitizer owns
      //    focus during the open lifecycle — leave it alone.
      if (e.key === "Escape") {
        const h = escapeStack.top();
        if (h) {
          e.preventDefault();
          h(e);
          return;
        }
        if (readScope()) return;
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
        // Respect a local React `onKeyDownCapture` / `onKeyDown`
        // handler that already redirected focus (e.g. Moonlight
        // Settings' sub-tab Down override captures ArrowDown to
        // jump to the first content row). `defaultPrevented` is set
        // by any `preventDefault()` call on the same event,
        // including ones from React's capture-phase `onKeyDownCapture`
        // handlers that ran earlier in the dispatch.
        if (e.defaultPrevented) return;
        processDirection(dir, () => e.preventDefault());
      }
    }

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stopTracking();
    };
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
 * escape it; Tab / Shift+Tab wraps inside the panel's focusables; the
 * escape / enter handlers pop on cleanup.
 *
 * `useFocusTrap` does NOT schedule any autoFocus or focus restoration.
 * That lifecycle is owned by `Modal.tsx` directly (DOM-MutationObserver
 * + generation token + close-restore rAF). Doing it here too would
 * create the two-rAF race that caused focus to land on body on rapid
 * open/close. Single source of truth: Modal owns open + close.
 */
export function useFocusTrap(
  panel: HTMLElement | null,
  opts: {
    onEscape: () => void;
    onEnter?: () => void;
  },
): void {
  const { onEscape, onEnter } = opts;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;

  useEffect(() => {
    if (!panel) return;
    const popEscape = pushEscapeHandler(() => onEscapeRef.current());
    const popEnter = onEnterRef.current
      ? pushEnterHandler(() => onEnterRef.current!())
      : null;
    const prevScope = readScope();
    setSpatialScope(panel);

    // Tab / Shift+Tab wrap. Arrows are trapped via `setSpatialScope`.
    // Without this, browser-native Tab traversal would walk out of
    // the panel (it's just a <div> in the page DOM, not a real dialog).
    const PANEL_FOCUSABLES =
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    function onTabKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const p = panel!;
      const all = Array.from(p.querySelectorAll<HTMLElement>(PANEL_FOCUSABLES));
      const focusables = all.filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && p.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (!inside || active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onTabKey, true);

    return () => {
      window.removeEventListener("keydown", onTabKey, true);
      popEscape();
      popEnter?.();
      setSpatialScope(prevScope);
    };
  }, [panel]);
}
