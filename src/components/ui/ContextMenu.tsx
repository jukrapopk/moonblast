import { useEffect, useRef, useSyncExternalStore, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";

export interface CtxAction {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  items: CtxAction[];
}

interface CtxMenuProps {
  state: MenuState | null;
  onClose: () => void;
}

export function ContextMenu({ state, onClose }: CtxMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onScroll() {
      onClose();
    }
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [state, onClose]);

  if (!state) return null;

  // Keep the menu inside the viewport.
  const width = 224;
  const height = 40 + Math.min(state.items.length, 8) * 34;
  const left = Math.max(8, Math.min(state.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(state.y, window.innerHeight - height - 8));

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top, width }}
      className="fixed z-[70] overflow-hidden rounded-xl border border-(--color-border) bg-(--color-surface-2) p-1 shadow-2xl"
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
    storeSet({ x: e.clientX, y: e.clientY, items });
  }
  const openAt = (x: number, y: number, items: CtxAction[]) => {
    storeSet({ x, y, items });
  };
  const setMenu = (s: MenuState | null) => storeSet(s);
  return { open, openAt, setMenu };
}

/** Mount once (e.g. in App.tsx) — the single rendered context menu. */
export function ContextMenuHost() {
  const state = useSyncExternalStore(storeSubscribe, storeGet);
  return <ContextMenu state={state} onClose={() => storeSet(null)} />;
}