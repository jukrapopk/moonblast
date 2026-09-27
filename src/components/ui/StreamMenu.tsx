import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  ArrowsIn,
  CaretRight,
  ChartLineUp,
  Check,
  CornersOut,
  Cursor,
  MouseSimple,
  Plugs,
  Power,
  Sliders,
  XCircle,
} from "@phosphor-icons/react";
import { useSettings } from "../../settings/SettingsContext";

/** Mirror of Rust's `overlay::StreamToggles` (Moonlight's live stream state). */
interface StreamToggles {
  stats: boolean;
  fullscreen: boolean;
  mouse_capture: boolean;
  mouse_absolute: boolean;
}

/** One choice inside a submenu (e.g. Relative / Absolute). */
interface SubOption {
  id: string;
  label: string;
  checked: boolean;
  run: () => void;
}

interface Item {
  id: string;
  kind: "action" | "toggle" | "submenu";
  label: string;
  icon: ReactNode;
  danger?: boolean;
  /** toggle: current state of the checkbox */
  checked?: boolean;
  /** toggle: Moonlight `Ctrl+Alt+Shift+<chord>`; absent for our own setting */
  chord?: string;
  /** toggle: the value comes from Moonblast settings rather than Moonlight */
  setting?: "show_floating_menu";
  /** submenu */
  children?: SubOption[];
}

/** A navigable row — a menu item, or an option inside an expanded submenu. */
interface Row {
  key: string;
  item: Item;
  option?: SubOption;
}

/**
 * Contents of the `stream-menu` window — the Parsec-style floating menu that
 * sits over a Moonlight stream. Rust owns showing/hiding the window and
 * forwards the navigation keys (`menu-key`) because the window never takes
 * focus; this component owns the item list, the highlighted row, and firing
 * the action on Enter / click.
 *
 * Toggles render as checkboxes whose state comes from Rust's best-effort mirror
 * (`stream_menu_toggles` / `stream-toggles`) — except "Show Floating Menu",
 * which is a Moonblast setting. Items that are *not* binary (Mouse Mode) become
 * a submenu behind a right caret instead.
 */
export function StreamMenu() {
  const { settings, update } = useSettings();
  const showFloating = settings.moonlight.show_floating_menu;

  // -1 = the trigger button itself (the default target); 0.. = a visible row.
  const [index, setIndex] = useState(-1);
  const [flash, setFlash] = useState<string | null>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [toggles, setToggles] = useState<StreamToggles>({
    stats: false,
    fullscreen: true,
    mouse_capture: true,
    mouse_absolute: false,
  });

  const items: Item[] = [
    { id: "disconnect", kind: "action", label: "Disconnect", icon: <Plugs size={19} weight="bold" /> },
    { id: "end_session", kind: "action", label: "End Session", icon: <XCircle size={19} weight="bold" />, danger: true },
    {
      id: "stats",
      kind: "toggle",
      label: "Show Stats",
      icon: <ChartLineUp size={19} weight="bold" />,
      checked: toggles.stats,
      chord: "s",
    },
    {
      id: "fullscreen",
      kind: "toggle",
      label: "Fullscreen",
      icon: <CornersOut size={19} weight="bold" />,
      checked: toggles.fullscreen,
      chord: "x",
    },
    {
      id: "mouse_capture",
      kind: "toggle",
      label: "Mouse Capture",
      icon: <MouseSimple size={19} weight="bold" />,
      checked: toggles.mouse_capture,
      chord: "z",
    },
    {
      id: "mouse_mode",
      kind: "submenu",
      label: "Mouse Mode",
      icon: <Cursor size={19} weight="bold" />,
      children: [
        {
          id: "absolute",
          label: "Absolute",
          checked: toggles.mouse_absolute,
          run: () => invoke("stream_menu_set_mouse_mode", { absolute: true }),
        },
        {
          id: "relative",
          label: "Relative",
          checked: !toggles.mouse_absolute,
          run: () => invoke("stream_menu_set_mouse_mode", { absolute: false }),
        },
      ],
    },
    { id: "minimize", kind: "action", label: "Minimize Stream", icon: <ArrowsIn size={19} weight="bold" /> },
    {
      id: "toggle_floating",
      kind: "toggle",
      label: "Show Floating Menu",
      icon: <Sliders size={19} weight="bold" />,
      checked: showFloating,
      setting: "show_floating_menu",
    },
    { id: "power", kind: "action", label: "Power", icon: <Power size={19} weight="bold" /> },
  ];

  // Flat, navigable view: each item, plus the options of the open submenu.
  const rows: Row[] = [];
  for (const item of items) {
    rows.push({ key: item.id, item });
    if (item.kind === "submenu" && openSub === item.id) {
      for (const option of item.children ?? []) {
        rows.push({ key: `${item.id}:${option.id}`, item, option });
      }
    }
  }

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const indexRef = useRef(index);
  indexRef.current = index;
  const openSubRef = useRef(openSub);
  openSubRef.current = openSub;
  const showFloatingRef = useRef(showFloating);
  showFloatingRef.current = showFloating;
  const runRef = useRef<(i: number) => void>(() => {});
  const activateRef = useRef<(i: number) => void>(() => {});

  // Flash a transient status message in the footer.
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFlash = useCallback((msg: string) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1600);
  }, []);

  const refreshToggles = useCallback(() => {
    invoke<StreamToggles>("stream_menu_toggles")
      .then(setToggles)
      .catch(() => {});
  }, []);

  const run = useCallback(
    async (i: number) => {
      const row = rowsRef.current[i];
      if (!row) return;
      try {
        // An option inside an open submenu: run it, then collapse.
        if (row.option) {
          await row.option.run();
          setOpenSub(null);
          return;
        }
        const item = row.item;
        if (item.kind === "toggle") {
          if (item.setting === "show_floating_menu") {
            const next = !showFloatingRef.current;
            update((s) => ({
              ...s,
              moonlight: { ...s.moonlight, show_floating_menu: next },
            }));
            showFlash(`Floating menu ${next ? "on" : "off"} for next stream`);
            return;
          }
          if (item.chord) await invoke("stream_menu_key", { key: item.chord });
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
        }
      } catch (e) {
        showFlash(String(e));
      }
    },
    [update, showFlash],
  );
  runRef.current = (i: number) => void run(i);

  /** Enter / click on a row: expand a submenu, otherwise run it. */
  const activate = useCallback((i: number) => {
    const row = rowsRef.current[i];
    if (!row) return;
    if (!row.option && row.item.kind === "submenu") {
      setOpenSub((v) => (v === row.item.id ? null : row.item.id));
      return;
    }
    runRef.current(i);
  }, []);
  activateRef.current = activate;

  /** Collapse a submenu and park the highlight back on its parent row. */
  const collapseTo = useCallback((itemId: string) => {
    setOpenSub(null);
    const parent = rowsRef.current.findIndex((r) => r.key === itemId);
    if (parent >= 0) setIndex(parent);
  }, []);

  useEffect(() => {
    const onKey = (key: string) => {
      const list = rowsRef.current;
      const i = indexRef.current;
      const row = list[i];
      if (key === "up") {
        setIndex((v) => Math.max(-1, v - 1));
      } else if (key === "down") {
        setIndex((v) => Math.min(list.length - 1, v + 1));
      } else if (key === "right") {
        if (row && !row.option && row.item.kind === "submenu" && openSubRef.current !== row.item.id) {
          setOpenSub(row.item.id);
          setIndex(i + 1); // first option sits right below the parent
        }
      } else if (key === "left") {
        if (row?.option) collapseTo(row.item.id);
      } else if (key === "enter" || key === "space") {
        // Default target is the button → toggles the menu off.
        if (i < 0) void invoke("stream_menu_hide");
        else activateRef.current(i);
      } else if (key === "escape") {
        if (openSubRef.current) collapseTo(openSubRef.current);
        else void invoke("stream_menu_hide");
      }
    };
    const unKeys = listen<{ key: string }>("menu-key", (e) => onKey(e.payload.key));
    const unShown = listen("menu-shown", () => {
      setIndex(-1);
      setOpenSub(null);
      refreshToggles();
      void emit("menu-focus", { on: true }).catch(() => {});
    });
    const unToggles = listen<StreamToggles>("stream-toggles", (e) => setToggles(e.payload));
    refreshToggles();
    return () => {
      void unKeys.then((f) => f());
      void unShown.then((f) => f());
      void unToggles.then((f) => f());
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, [collapseTo, refreshToggles]);

  // Tell the button window whether it is the current target, so it can show its
  // active ring (Rust clears it when the menu hides).
  useEffect(() => {
    void emit("menu-focus", { on: index < 0 }).catch(() => {});
  }, [index]);

  return (
    <div className="flex h-full w-full p-1.5">
      <div className="flex w-full flex-col overflow-hidden rounded-2xl border border-(--color-border) bg-(--color-surface) shadow-2xl">
        <div className="space-y-0.5 p-1.5">
          {rows.map((row, i) => {
            const selected = i === index;
            const item = row.item;
            const option = row.option;
            const danger = item.danger;
            return (
              <button
                key={row.key}
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => activateRef.current(i)}
                className={`flex w-full items-center gap-3 rounded-xl py-2.5 pr-3 text-left transition-colors ${
                  option ? "pl-11" : "pl-3"
                } ${selected ? "bg-(--color-accent-soft)" : "hover:bg-(--color-surface-2)"}`}
              >
                {!option && (
                  <span
                    className={
                      danger
                        ? "text-(--color-danger)"
                        : selected
                          ? "text-(--color-accent)"
                          : "text-(--color-muted)"
                    }
                  >
                    {item.icon}
                  </span>
                )}
                <span
                  className={`flex-1 text-sm font-medium ${
                    danger ? "text-(--color-danger)" : "text-(--color-text)"
                  }`}
                >
                  {option ? option.label : item.label}
                </span>
                {!option && item.kind === "toggle" && <Checkbox checked={!!item.checked} />}
                {!option && item.kind === "submenu" && (
                  <CaretRight
                    size={14}
                    weight="bold"
                    className={`text-(--color-muted) transition-transform ${
                      openSub === item.id ? "rotate-90" : ""
                    }`}
                  />
                )}
                {option && <Checkbox checked={option.checked} />}
              </button>
            );
          })}
        </div>

        <div className="border-t border-(--color-border) px-4 py-2 text-center text-xs text-(--color-muted)">
          {flash ?? "↑↓ Navigate · ←→ Options · Enter Select · Esc Close"}
        </div>
      </div>
    </div>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        checked
          ? "border-(--color-accent) bg-(--color-accent) text-white"
          : "border-(--color-muted) text-transparent"
      }`}
    >
      <Check size={12} weight="bold" />
    </span>
  );
}
