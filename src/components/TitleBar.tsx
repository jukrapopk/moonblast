import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Minus, Square, Copy, X } from "@phosphor-icons/react";
import { useContextMenu } from "./ui/ContextMenu";

export function TitleBar({
  fullscreen,
  onToggleFullscreen,
}: {
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const [maximized, setMaximized] = useState(false);
  const ctx = useContextMenu();

  useEffect(() => {
    invoke<boolean>("is_maximized").then(setMaximized).catch(() => {});
  }, []);

  async function minimize() {
    try {
      await invoke("minimize_window");
    } catch {}
  }
  async function toggleMaximize() {
    try {
      const v = await invoke<boolean>("toggle_maximize");
      setMaximized(v);
    } catch {}
  }
  async function close() {
    try {
      await invoke("close_app");
    } catch {}
  }

  return (
    <header className="flex h-10 shrink-0 select-none items-stretch border-b border-(--color-border) bg-(--color-surface)">
      {/* Title + drag region */}
      <div
        data-tauri-drag-region
        onContextMenu={(e) =>
          ctx.open(e, [
            { label: maximized ? "Restore" : "Maximize", onClick: () => toggleMaximize() },
            { label: "Minimize", onClick: () => minimize() },
            {
              label: fullscreen ? "Exit fullscreen" : "Fullscreen",
              onClick: () => onToggleFullscreen(),
            },
            { label: "Close", danger: true, onClick: () => close() },
          ])
        }
        className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 px-3 text-sm font-medium text-(--color-muted)"
      >
        <svg
          viewBox="0 0 1000 1000"
          aria-hidden="true"
          style={{
            fillRule: "evenodd",
            clipRule: "evenodd",
            strokeLinecap: "round",
            strokeLinejoin: "round",
          }}
          className="h-[18px] w-[18px] shrink-0"
        >
          <g transform="matrix(1.26435,0,0,1.26435,-132.175,-132.175)">
            <circle cx="500" cy="500" r="172.756" fill="currentColor" />
          </g>
          <g transform="matrix(2.43731,0,0,2.43731,-718.656,-718.656)">
            <path
              d="M500,327.244C580.348,327.244 647.958,382.215 667.241,456.568"
              fill="none"
              stroke="currentColor"
              strokeWidth="56.35"
            />
          </g>
          <g transform="matrix(-2.43731,0,0,2.43731,1718.66,-718.656)">
            <path
              d="M500,327.244C580.348,327.244 647.958,382.215 667.241,456.568"
              fill="none"
              stroke="currentColor"
              strokeWidth="56.35"
            />
          </g>
          <g transform="matrix(-2.43731,2.98485e-16,-2.98485e-16,-2.43731,1718.66,1718.7)">
            <path
              d="M500,327.244C580.348,327.244 647.958,382.215 667.241,456.568"
              fill="none"
              stroke="currentColor"
              strokeWidth="56.35"
            />
          </g>
          <g transform="matrix(2.43731,-2.98485e-16,-2.98485e-16,-2.43731,-718.656,1718.7)">
            <path
              d="M500,327.244C580.348,327.244 647.958,382.215 667.241,456.568"
              fill="none"
              stroke="currentColor"
              strokeWidth="56.35"
            />
          </g>
        </svg>
        <span className="truncate text-[13px]">Moonblast</span>
      </div>

      {/* Window controls — mouse-only by design. tabIndex={-1} keeps
       *  the buttons clickable (and reachable via OS shortcuts) but
       *  drops them out of the spatial-nav focusable list and out of
       *  the Tab order. Keyboard / gamepad users close / minimize /
       *  maximize through the Power menu, which is a regular focusable
       *  TopBar chip. */}
      <div className="flex items-stretch">
        <button
          tabIndex={-1}
          onClick={minimize}
          aria-label="Minimize"
          className="flex w-12 items-center justify-center text-(--color-muted) transition-colors hover:bg-(--color-surface-2) hover:text-(--color-text)"
        >
          <Minus size={15} weight="bold" />
        </button>
        <button
          tabIndex={-1}
          onClick={toggleMaximize}
          aria-label={maximized ? "Restore" : "Maximize"}
          className="flex w-12 items-center justify-center text-(--color-muted) transition-colors hover:bg-(--color-surface-2) hover:text-(--color-text)"
        >
          {maximized ? <Copy size={14} weight="bold" /> : <Square size={14} weight="bold" />}
        </button>
        <button
          tabIndex={-1}
          onClick={close}
          aria-label="Close"
          className="flex w-12 items-center justify-center text-(--color-muted) transition-colors hover:bg-(--color-danger) hover:text-white"
        >
          <X size={16} weight="bold" />
        </button>
      </div>
    </header>
  );
}