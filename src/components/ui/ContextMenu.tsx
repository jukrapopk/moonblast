import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useFocusTrap } from "../../input/useSpatialController";
import { focusInitial } from "../../input/spatialNav";

interface CtxAction {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

interface MenuState {
  x: number;
  y: number;
  items: CtxAction[];
  /**
   * When true, the menu moves keyboard focus to its first item on open
   * (used by Shift+F10 / ContextMenu key). When false (default — the
   * mouse right-click path), the menu is mouse-only and skips autoFocus
   * so the user's previous keyboard focus stays put.
   */
  keyboard?: boolean;
}

interface CtxMenuProps {
  state: MenuState | null;
  onClose: () => void;
}

export function ContextMenu({ state, onClose }: CtxMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
  // Hold onClose in a ref so the host's inline `() => storeSet(null)` doesn't
  // re-bind all four listeners on every render of ContextMenuHost while a
  // menu is open. Listeners are bound once per `state` flip.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Mark this element as a spatial container so the LRUD library treats
  // the menu as one scoped island — arrows can't escape it back into the
  // page below. `useFocusTrap` owns Escape (LIFO push), spatial scope,
// and autoFocus — the latter is opt-in via `state.keyboard` so mouse
// right-click doesn't yank focus off the previously-focused element.
  useFocusTrap(panelEl, {
    onEscape: () => onCloseRef.current(),
    autoFocus: state?.keyboard === true,
  });

  // Capture outside-close / blur / scroll semantics (LRUD handles Up/Down).
  useEffect(() => {
    if (!state) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    }
    function onScroll() {
      onCloseRef.current();
    }
    document.addEventListener("mousedown", onDoc, true);
    window.addEventListener("blur", onCloseRef.current);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDoc, true);
      window.removeEventListener("blur", onCloseRef.current);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [state]);

  // Restore focus to the previously-focused element on close (typically
  // the tile / row the menu was opened from).
  const prevFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (state) {
      prevFocused.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      // Only move focus into the menu when it was opened by keyboard
      // (Shift+F10 / ContextMenu key). Mouse right-click leaves focus
      // where it was so the previously-focused element keeps its
      // outline and the close-restore is a no-op.
      if (state.keyboard) {
        const id = requestAnimationFrame(() => {
          if (ref.current) focusInitial(ref.current);
        });
        return () => cancelAnimationFrame(id);
      }
      return;
    }
    if (prevFocused.current) {
      const el = prevFocused.current;
      const id = requestAnimationFrame(() => {
        if (el.isConnected) el.focus();
      });
      prevFocused.current = null;
      return () => cancelAnimationFrame(id);
    }
  }, [state]);

  if (!state) return null;

  // Keep the menu inside the viewport.
  const width = 224;
  const height = 40 + Math.min(state.items.length, 8) * 34;
  const left = Math.max(8, Math.min(state.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(state.y, window.innerHeight - height - 8));

  return (
    <div
      ref={(node) => {
        ref.current = node;
        setPanelEl(node);
      }}
      role="menu"
      // `lrud-container` opts the panel into the LRUD library's
      // container system: scope = panel only, last-focused tracking via
      // data-focus, etc.
      className="lrud-container fixed z-[70] overflow-hidden rounded-xl border border-(--color-border) bg-(--color-surface-2) p-1 shadow-2xl"
      style={{ left, top, width }}
    >
      {state.items.map((it, i) => (
        <button
          key={i}
          role="menuitem"
          disabled={it.disabled}
          onClick={() => {
            if (it.disabled) return;
            it.onClick();
            onClose();
          }}
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            it.disabled
              ? "cursor-default opacity-40"
              : it.danger
                ? "text-(--color-danger) hover:bg-(--color-surface)"
                : "text-(--color-text) hover:bg-(--color-surface)"
          }`}
        >
          {it.icon}
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---- global singleton store ----------------------------------------------
// Only one context menu may be open at a time, so all `useContextMenu()`
// instances share a single module-level store; opening a menu replaces any
// previously-open one. A single `<ContextMenuHost/>` is mounted once at the
// app root and renders whatever the store holds.

let menuState: MenuState | null = null;
const listeners = new Set<() => void>();

function storeSet(s: MenuState | null) {
  menuState = s;
  listeners.forEach((l) => l());
}
function storeSubscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function storeGet() {
  return menuState;
}

export function useContextMenu() {
  function open(e: ReactMouseEvent, items: CtxAction[]) {
    e.preventDefault();
    e.stopPropagation();
    // Detect the synthetic keyboard-flagged contextmenu event that the
    // spatial controller dispatches for Shift+F10 / ContextMenu key.
    // Real mouse right-clicks don't carry the flag — those stay
    // mouse-only and don't yank focus.
    const keyboard =
      "__keyboard" in e.nativeEvent &&
      (e.nativeEvent as MouseEvent & { __keyboard?: boolean }).__keyboard === true;
    storeSet({ x: e.clientX, y: e.clientY, items, keyboard });
  }
  const openAt = (
    x: number,
    y: number,
    keyboard: boolean,
    items: CtxAction[],
  ) => {
    storeSet({ x, y, items, keyboard });
  };
  const setMenu = (s: MenuState | null) => storeSet(s);
  return { open, openAt, setMenu };
}

/** Mount once (e.g. in App.tsx) — the single rendered context menu. */
export function ContextMenuHost() {
  const state = useSyncExternalStore(storeSubscribe, storeGet);
  return <ContextMenu state={state} onClose={() => storeSet(null)} />;
}
