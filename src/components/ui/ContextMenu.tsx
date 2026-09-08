import { useEffect, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";

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
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
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

/** Right-click context menu state + open helper. */
export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  function open(e: ReactMouseEvent, items: CtxAction[]) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function openAt(x: number, y: number, items: CtxAction[]) {
    setMenu({ x, y, items });
  }

  const render = <ContextMenu state={menu} onClose={() => setMenu(null)} />;
  return { open, openAt, render, setMenu };
}