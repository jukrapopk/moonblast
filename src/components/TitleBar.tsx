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
        className="flex min-w-0 flex-1 cursor-default items-center gap-2 px-3 text-sm font-medium text-(--color-muted)"
      >
        <img
          src="/moonblast.svg"
          alt="Moonblast"
          draggable={false}
          className="h-[18px] w-[18px] shrink-0"
        />
        <span className="truncate text-[13px]">Moonblast</span>
      </div>

      {/* Window controls */}
      <div className="flex items-stretch">
        <button
          onClick={minimize}
          title="Minimize"
          aria-label="Minimize"
          className="flex w-12 items-center justify-center text-(--color-muted) transition-colors hover:bg-(--color-surface-2) hover:text-(--color-text)"
        >
          <Minus size={15} weight="bold" />
        </button>
        <button
          onClick={toggleMaximize}
          title={maximized ? "Restore" : "Maximize"}
          aria-label={maximized ? "Restore" : "Maximize"}
          className="flex w-12 items-center justify-center text-(--color-muted) transition-colors hover:bg-(--color-surface-2) hover:text-(--color-text)"
        >
          {maximized ? <Copy size={14} weight="bold" /> : <Square size={14} weight="bold" />}
        </button>
        <button
          onClick={close}
          title="Close"
          aria-label="Close"
          className="flex w-12 items-center justify-center text-(--color-muted) transition-colors hover:bg-(--color-danger) hover:text-white"
        >
          <X size={16} weight="bold" />
        </button>
      </div>
    </header>
  );
}