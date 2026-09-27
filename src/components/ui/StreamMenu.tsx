import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  ArrowsIn,
  ChartLineUp,
  Clipboard,
  CornersOut,
  Cursor,
  MouseSimple,
  Plugs,
  Power,
  Sliders,
  XCircle,
} from "@phosphor-icons/react";
import { useSettings } from "../../settings/SettingsContext";

interface Item {
  id: string;
  kind: "action" | "toggle";
  label: string;
  icon: ReactNode;
  danger?: boolean;
}

/**
 * Contents of the `stream-menu` window — the Parsec-style floating menu that
 * sits over a Moonlight stream. Rust owns showing/hiding the window and
 * forwards the navigation keys (`menu-key`) because the window never takes
 * focus; this component owns the item list, the highlighted row, and firing
 * the action on Enter / click.
 */
export function StreamMenu() {
  const { settings, update } = useSettings();
  const showFloating = settings.moonlight.show_floating_menu;

  // -1 = the trigger button itself (the default target); 0.. = a list row.
  const [index, setIndex] = useState(-1);
  const [flash, setFlash] = useState<string | null>(null);

  const items: Item[] = [
    { id: "disconnect", kind: "action", label: "Disconnect", icon: <Plugs size={19} weight="bold" /> },
    { id: "end_session", kind: "action", label: "End Session", icon: <XCircle size={19} weight="bold" />, danger: true },
    { id: "stats", kind: "action", label: "Toggle Stats", icon: <ChartLineUp size={19} weight="bold" /> },
    { id: "fullscreen", kind: "action", label: "Toggle Fullscreen", icon: <CornersOut size={19} weight="bold" /> },
    { id: "mouse_capture", kind: "action", label: "Toggle Mouse Capture", icon: <MouseSimple size={19} weight="bold" /> },
    { id: "mouse_mode", kind: "action", label: "Toggle Mouse Mode", icon: <Cursor size={19} weight="bold" /> },
    { id: "clipboard", kind: "action", label: "Type Clipboard", icon: <Clipboard size={19} weight="bold" /> },
    { id: "minimize", kind: "action", label: "Minimize Stream", icon: <ArrowsIn size={19} weight="bold" /> },
    { id: "toggle_floating", kind: "toggle", label: "Show Floating Menu", icon: <Sliders size={19} weight="bold" /> },
    { id: "power", kind: "action", label: "Power", icon: <Power size={19} weight="bold" /> },
  ];
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const showFloatingRef = useRef(showFloating);
  showFloatingRef.current = showFloating;
  const indexRef = useRef(index);
  indexRef.current = index;
  const runRef = useRef<(i: number) => void>(() => {});

  // Flash a transient status message in the footer.
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFlash = useCallback((msg: string) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1600);
  }, []);

  const run = useCallback(
    async (i: number) => {
      const item = itemsRef.current[i];
      if (!item) return;
      try {
        if (item.kind === "toggle") {
          const next = !showFloatingRef.current;
          update((s) => ({
            ...s,
            moonlight: { ...s.moonlight, show_floating_menu: next },
          }));
          showFlash(`Floating menu ${next ? "on" : "off"} for next stream`);
          return;
        }
        switch (item.id) {
          case "disconnect":
            await invoke("stream_menu_disconnect");
            break;
          case "end_session":
            await invoke("stream_menu_end_session");
            break;
          case "power":
            await invoke("open_power_menu");
            break;
          case "stats":
            await invoke("stream_menu_key", { key: "s" });
            break;
          case "fullscreen":
            await invoke("stream_menu_key", { key: "x" });
            break;
          case "mouse_capture":
            await invoke("stream_menu_key", { key: "z" });
            break;
          case "mouse_mode":
            await invoke("stream_menu_key", { key: "m" });
            break;
          case "clipboard":
            await invoke("stream_menu_key", { key: "v" });
            break;
          case "minimize":
            await invoke("stream_menu_key", { key: "d" });
            break;
        }
      } catch (e) {
        showFlash(String(e));
      }
    },
    [update, showFlash],
  );
  runRef.current = (i: number) => void run(i);

  useEffect(() => {
    const onKey = (key: string) => {
      const count = itemsRef.current.length;
      if (key === "up") {
        setIndex((i) => Math.max(-1, i - 1));
      } else if (key === "down") {
        setIndex((i) => Math.min(count - 1, i + 1));
      } else if (key === "enter" || key === "space") {
        // Default target is the button → toggles the menu off.
        if (indexRef.current < 0) void invoke("stream_menu_hide");
        else runRef.current(indexRef.current);
      } else if (key === "escape") {
        void invoke("stream_menu_hide");
      }
    };
    const unKeys = listen<{ key: string }>("menu-key", (e) => onKey(e.payload.key));
    const unShown = listen("menu-shown", () => {
      setIndex(-1);
      void emit("menu-focus", { on: true }).catch(() => {});
    });
    return () => {
      void unKeys.then((f) => f());
      void unShown.then((f) => f());
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  // Tell the button window whether it is the current target, so it can show its
  // active ring (Rust clears it when the menu hides).
  useEffect(() => {
    void emit("menu-focus", { on: index < 0 }).catch(() => {});
  }, [index]);

  return (
    <div className="flex h-full w-full p-1.5">
      <div className="flex w-full flex-col overflow-hidden rounded-2xl border border-(--color-border) bg-(--color-surface) shadow-2xl">
        <div className="space-y-0.5 p-1.5">
          {items.map((item, i) => {
            const selected = i === index;
            return (
              <button
                key={item.id}
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => runRef.current(i)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                  selected ? "bg-(--color-accent-soft)" : "hover:bg-(--color-surface-2)"
                }`}
              >
                <span
                  className={
                    item.danger
                      ? "text-(--color-danger)"
                      : selected
                        ? "text-(--color-accent)"
                        : "text-(--color-muted)"
                  }
                >
                  {item.icon}
                </span>
                <span
                  className={`flex-1 text-sm font-medium ${
                    item.danger ? "text-(--color-danger)" : "text-(--color-text)"
                  }`}
                >
                  {item.label}
                </span>
                {item.kind === "toggle" && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      showFloating
                        ? "bg-(--color-accent) text-white"
                        : "bg-(--color-surface-2) text-(--color-muted)"
                    }`}
                  >
                    {showFloating ? "On" : "Off"}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="border-t border-(--color-border) px-4 py-2 text-center text-xs text-(--color-muted)">
          {flash ?? "↑↓ Navigate · Enter Select · Esc Close"}
        </div>
      </div>
    </div>
  );
}
