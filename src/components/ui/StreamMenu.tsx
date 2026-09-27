import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
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
  X,
  XCircle,
} from "@phosphor-icons/react";
import { useSettings } from "../../settings/SettingsContext";
import { powerItems } from "./powerItems";

/** Mirror of Rust's `overlay::StreamToggles` (Moonlight's live stream state). */
interface StreamToggles {
  stats: boolean;
  fullscreen: boolean;
  mouse_capture: boolean;
  mouse_absolute: boolean;
}

/** One choice inside a submenu flyout (e.g. Relative / Absolute). */
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
  /** draw a separator rule under this row */
  dividerAfter?: boolean;
  /** toggle: current state of the checkbox */
  checked?: boolean;
  /** Moonlight `Ctrl+Alt+Shift+<chord>` injected when this row is activated */
  chord?: string;
  /** toggle: the value comes from Moonblast settings rather than Moonlight */
  setting?: "show_floating_menu";
  /** submenu: options for the flyout that opens to the right of the row */
  children?: SubOption[];
}

/**
 * Fine nudge (logical px) on the flyout's row alignment. Negative lifts the
 * flyout above the parent row — purely a look-and-feel tweak.
 */
const FLYOUT_NUDGE = -5;

/**
 * Contents of the `stream-menu` window — the Parsec-style floating menu that
 * sits over a Moonlight stream. Rust owns showing/hiding the window and
 * forwards the navigation keys (`menu-key`) because the window never takes
 * focus; this component owns the item list, the highlighted row, and firing
 * the action on Enter / click.
 *
 * Toggles render as checkboxes whose state comes from Rust's best-effort mirror
 * (`stream_menu_toggles` / `stream-toggles`) — except "Show Floating Menu",
 * which is a Moonblast setting applied **immediately** (Rust reconciles on the
 * settings write). Any item with `children` renders a right caret
 * and opens a **flyout column to the right** on hover (or Right / Enter), so
 * the pattern is reusable for future submenus.
 *
 * The window shrink-wraps to this content: a `ResizeObserver` measures the two
 * columns and resizes the window, which widens when a flyout opens (Rust
 * anchors the list column, so only the flyout grows rightwards).
 */
export function StreamMenu() {
  const { settings, update } = useSettings();
  const showFloating = settings.moonlight.show_floating_menu;

  // -1 = the trigger button itself (the default target); 0.. = a list row.
  const [index, setIndex] = useState(-1);
  // Open flyout (its parent item id) + which of its options is highlighted.
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [optionIndex, setOptionIndex] = useState(0);
  // Where the *keyboard* is. Hovering the flyout never moves it here.
  const [zone, setZone] = useState<"list" | "flyout">("list");
  const [flash, setFlash] = useState<string | null>(null);
  // Which list the window shows: the floating menu, or the centred Power view.
  const [view, setView] = useState<"menu" | "power">("menu");
  const [toggles, setToggles] = useState<StreamToggles>({
    stats: false,
    fullscreen: true,
    mouse_capture: true,
    mouse_absolute: false,
  });

  const items: Item[] = [
    { id: "minimize", kind: "action", label: "Minimize Stream", icon: <ArrowsIn size={19} weight="bold" />, chord: "d" },
    { id: "disconnect", kind: "action", label: "Disconnect", icon: <Plugs size={19} weight="bold" /> },
    {
      id: "end_session",
      kind: "action",
      label: "End Session",
      icon: <XCircle size={19} weight="bold" />,
      danger: true,
      dividerAfter: true,
    },
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
      dividerAfter: true,
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

  // The Power view reuses the row machinery verbatim: its rows are plain
  // actions from the shared definition, so they map onto the same `Item` shape.
  const powerRows: Item[] = powerItems({ variant: "overlay" }).map((p) => ({
    id: p.id,
    kind: "action",
    label: p.label,
    icon: p.icon,
    danger: p.danger,
    dividerAfter: p.dividerAfter,
  }));
  const rows = view === "power" ? powerRows : items;

  const itemsRef = useRef(rows);
  itemsRef.current = rows;
  const viewRef = useRef(view);
  viewRef.current = view;
  const indexRef = useRef(index);
  indexRef.current = index;
  const openSubRef = useRef(openSub);
  openSubRef.current = openSub;
  const optionIndexRef = useRef(optionIndex);
  optionIndexRef.current = optionIndex;
  const zoneRef = useRef(zone);
  zoneRef.current = zone;
  const showFloatingRef = useRef(showFloating);
  showFloatingRef.current = showFloating;
  const runRef = useRef<(i: number) => void>(() => {});
  const activateRef = useRef<(i: number) => void>(() => {});
  const runOptionRef = useRef<(i: number) => void>(() => {});
  const openPowerRef = useRef<() => void>(() => {});
  const runPowerRef = useRef<(id: string) => Promise<void>>(async () => {});

  // Flash a transient status message.
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
      const item = itemsRef.current[i];
      if (!item) return;
      try {
        // The Power view's rows are owned by Rust directly.
        if (viewRef.current === "power") {
          await runPowerRef.current(item.id);
          return;
        }
        if (item.kind === "toggle" && item.setting === "show_floating_menu") {
          const next = !showFloatingRef.current;
          update((s) => ({
            ...s,
            moonlight: { ...s.moonlight, show_floating_menu: next },
          }));
          showFlash(`Floating menu ${next ? "on" : "off"}`);
          return;
        }
        // Moonlight shortcut rows — toggles and one-shot actions alike.
        if (item.chord) {
          await invoke("stream_menu_key", { key: item.chord });
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
            openPowerRef.current();
            break;
        }
      } catch (e) {
        showFlash(String(e));
      }
    },
    [update, showFlash],
  );
  runRef.current = (i: number) => void run(i);

  /** Run the n-th option of the open flyout. It stays open so the new state shows. */
  const runOption = useCallback(
    async (i: number) => {
      const parent = itemsRef.current.find((it) => it.id === openSubRef.current);
      const option = parent?.children?.[i];
      if (!option) return;
      try {
        await option.run();
      } catch (e) {
        showFlash(String(e));
      }
    },
    [showFlash],
  );
  runOptionRef.current = (i: number) => void runOption(i);

  /** Enter / click on a list row: open its flyout, otherwise run it. */
  const activate = useCallback((i: number) => {
    const item = itemsRef.current[i];
    if (!item) return;
    if (item.kind === "submenu") {
      setOpenSub(item.id);
      setOptionIndex(0);
      setZone("flyout");
      return;
    }
    runRef.current(i);
  }, []);
  activateRef.current = activate;

  /** Swap the window to the centred Power view. */
  const openPowerView = useCallback(() => {
    setView("power");
    // -1 targets the header's X, so the view opens with it focused; Down moves
    // into the system rows. -2 means "nothing" (the scrim was hovered).
    setIndex(-1);
    setOpenSub(null);
    setZone("list");
    void invoke("stream_menu_center", { centered: true }).catch(() => {});
  }, []);
  openPowerRef.current = openPowerView;

  /**
   * The Power view's actions — system rows only, all owned by Rust.
   */
  const runPower = useCallback(async (id: string) => {
    switch (id) {
      case "sleep":
        await invoke("system_power", { action: "sleep" });
        break;
      case "reboot":
        await invoke("system_power", { action: "reboot" });
        break;
      case "shutdown":
        await invoke("system_power", { action: "shutdown" });
        break;
      default:
        return;
    }
    // The machine is going down — take the overlay with it.
    void invoke("stream_menu_hide").catch(() => {});
  }, []);
  runPowerRef.current = runPower;

  // The flyout follows the highlighted list row — by hover (mouse) and by
  // arrows (keyboard). While the keyboard is inside the flyout, leave it alone.
  useEffect(() => {
    if (zone === "flyout") return;
    const item = itemsRef.current[index];
    const id = item && item.kind === "submenu" ? item.id : null;
    if (id === openSubRef.current) return;
    setOpenSub(id);
    setOptionIndex(0);
  }, [index, zone]);

  useEffect(() => {
    const onKey = (key: string) => {
      const list = itemsRef.current;
      if (zoneRef.current === "flyout") {
        const parent = list.find((it) => it.id === openSubRef.current);
        const count = parent?.children?.length ?? 0;
        if (key === "up") setOptionIndex((v) => Math.max(0, v - 1));
        else if (key === "down") setOptionIndex((v) => Math.min(count - 1, v + 1));
        else if (key === "left" || key === "escape") setZone("list");
        else if (key === "enter" || key === "space") runOptionRef.current(optionIndexRef.current);
        return;
      }
      if (key === "up") {
        setIndex((v) => Math.max(-1, v - 1));
      } else if (key === "down") {
        setIndex((v) => Math.min(list.length - 1, v + 1));
      } else if (key === "right") {
        const item = list[indexRef.current];
        if (item?.kind === "submenu") {
          setOpenSub(item.id);
          setOptionIndex(0);
          setZone("flyout");
        }
      } else if (key === "enter" || key === "space") {
        const i = indexRef.current;
        if (i < 0) {
          // -1 is a real target in both views (the trigger button in the menu
          // view, the X in the Power view) → activating it dismisses. -2 is
          // "nothing focused" (the pointer left / is off the panel) → no-op.
          if (i === -1) void invoke("stream_menu_hide");
          return;
        }
        const item = list[i];
        if (item?.kind === "submenu") {
          setOpenSub(item.id);
          setOptionIndex(0);
          setZone("flyout");
          return;
        }
        runRef.current(i);
      } else if (key === "escape") {
        if (openSubRef.current) setOpenSub(null);
        else void invoke("stream_menu_hide");
      }
    };
    const unKeys = listen<{ key: string }>("menu-key", (e) => onKey(e.payload.key));
    const unShown = listen("menu-shown", () => {
      setIndex(-1);
      setOpenSub(null);
      setOptionIndex(0);
      setZone("list");
      // Rust clears its centred flag on hide, so every summon starts on the menu.
      setView("menu");
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
  }, [refreshToggles]);

  // Shrink-wrap the window to the two columns, and line the flyout up with the
  // row that opened it (classic submenu) rather than with the top of the list.
  // The columns are measured directly (rather than the root) because `#root`
  // clips the overflowing flyout until the window has grown, which would make a
  // root-based measurement circular.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const flyoutListRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const appliedSize = useRef({ w: 0, h: 0 });
  useEffect(() => {
    // The Power view is monitor-sized (its scrim fills the screen) and Rust owns
    // that size. Reset the guard on the way in/out so returning to the menu
    // re-measures and shrinks the window back down to the panel.
    if (view === "power") {
      appliedSize.current = { w: 0, h: 0 };
      return;
    }
    const apply = () => {
      const root = rootRef.current;
      const list = listRef.current;
      if (!root || !list) return;
      const cs = getComputedStyle(root);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const gap = parseFloat(cs.columnGap) || 0;
      const listRect = list.getBoundingClientRect();
      const flyout = flyoutRef.current;
      if (flyout) {
        const parentIndex = openSub ? itemsRef.current.findIndex((it) => it.id === openSub) : -1;
        const row = parentIndex >= 0 ? rowRefs.current[parentIndex] : null;
        const inner = flyoutListRef.current;
        if (row && inner) {
          // Measure both offsets *absolutely* — the row's distance from the top
          // of the list, and the first option's from the top of the flyout
          // panel — then subtract. That makes this idempotent: a self-referential
          // delta would read 0 once aligned, and the ResizeObserver's initial
          // callback (which fires on every re-subscribe) would snap it to the
          // top. Rects rather than `offsetTop`, so the borders can't skew it.
          const rowOffset = row.getBoundingClientRect().top - listRect.top;
          const innerOffset = inner.getBoundingClientRect().top - flyout.getBoundingClientRect().top;
          flyout.style.marginTop = `${Math.max(
            0,
            Math.round(rowOffset - innerOffset + FLYOUT_NUDGE),
          )}px`;
        }
      }
      const flyoutRect = flyout?.getBoundingClientRect();
      const w = Math.ceil(listRect.width + (flyoutRect ? gap + flyoutRect.width : 0) + padX);
      const h = Math.ceil(
        Math.max(listRect.height, flyoutRect ? flyoutRect.bottom - listRect.top : 0) + padY,
      );
      if (w <= 0 || h <= 0) return;
      if (Math.abs(w - appliedSize.current.w) < 1 && Math.abs(h - appliedSize.current.h) < 1) return;
      appliedSize.current = { w, h };
      // Re-anchor: Rust positions the menu from the window's real size.
      void getCurrentWebviewWindow()
        .setSize(new LogicalSize(w, h))
        .then(() => invoke("stream_menu_follow"))
        .catch(() => {});
    };
    apply();
    const observer = new ResizeObserver(apply);
    if (listRef.current) observer.observe(listRef.current);
    if (flyoutRef.current) observer.observe(flyoutRef.current);
    return () => observer.disconnect();
  }, [openSub, view]);

  // Tell the button window whether it is the current target, so it can show its
  // active ring (Rust clears it when the menu hides).
  useEffect(() => {
    void emit("menu-focus", { on: view === "menu" && index === -1 }).catch(() => {});
  }, [index, view]);

  const subItem = openSub ? items.find((it) => it.id === openSub) : undefined;

  // The list column is identical in both views — only what surrounds it differs.
  const listColumn = (
    <div
      ref={listRef}
      className="relative flex w-[288px] shrink-0 flex-col overflow-hidden rounded-2xl border border-(--color-border) bg-(--color-surface) shadow-2xl"
    >
      {/* Power view only: the launcher modal's header, so the two read alike. */}
      {view === "power" && (
        <div className="flex items-center justify-between px-3 pt-2 pb-0.5">
          <h2 className="text-lg font-semibold tracking-tight text-(--color-text)">Power</h2>
          <button
            type="button"
            aria-label="Close"
            onMouseEnter={() => setIndex(-1)}
            onClick={() => void invoke("stream_menu_hide")}
            className={`flex h-9 w-9 items-center justify-center rounded-full transition ${
              index === -1
                ? "bg-(--color-accent-soft) text-(--color-accent)"
                : "text-(--color-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)"
            }`}
          >
            <X size={20} weight="bold" />
          </button>
        </div>
      )}
      <div className="space-y-0.5 p-1.5">
        {rows.map((item, i) => {
          const selected = i === index;
          return (
            <Fragment key={item.id}>
              <button
                type="button"
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                onMouseEnter={() => {
                  setZone("list");
                  setIndex(i);
                }}
                onClick={() => activateRef.current(i)}
                className={`flex w-full items-center gap-3 rounded-xl py-2.5 pr-3 pl-3 text-left transition-colors ${
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
                {item.kind === "toggle" && <Checkbox checked={!!item.checked} />}
                {item.kind === "submenu" && (
                  <CaretRight size={14} weight="bold" className="text-(--color-muted)" />
                )}
              </button>
              {item.dividerAfter && <div className="mx-3 my-1 h-px bg-(--color-border)" />}
            </Fragment>
          );
        })}
      </div>

      {/* Errors / confirmations only — no permanent footer. */}
      {flash && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2">
          <span className="rounded-full bg-(--color-surface-2) px-3 py-1 text-xs font-medium text-(--color-text) shadow-lg">
            {flash}
          </span>
        </div>
      )}
    </div>
  );

  // Power view: the panel is centred over a full-monitor tinted scrim, so the
  // window is blown up to the monitor by `stream_menu_center` and the scrim is
  // what covers the stream. Clicking it dismisses; hovering it clears focus
  // (-2 = nothing) so no row or the X looks focused while the pointer is off the
  // panel. -1 targets the X, 0.. the system rows.
  if (view === "power") {
    return (
      <div
        ref={rootRef}
        onClick={() => void invoke("stream_menu_hide")}
        className="flex h-full w-full items-center justify-center bg-(--color-overlay)"
      >
        {/* The wrapper's box is exactly the panel, so its `mouseleave` fires for
            both gestures that should clear focus: onto the scrim, and off the
            window entirely. One handler, no target inspection needed. */}
        <div onMouseLeave={() => setIndex(-2)} onClick={(e) => e.stopPropagation()}>
          {listColumn}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      // Same rule as the launcher's `useFocusOnHover` (hover = focus,
      // `mouseleave` = blur), applied to the overlay's own `index`: leaving the
      // window drops focus so nothing stays lit while the pointer is out over
      // the stream. -2 = nothing focused.
      onMouseLeave={() => setIndex(-2)}
      className="flex w-max items-start gap-1.5 p-1.5"
    >
      {listColumn}

      {/* Flyout column — any item with `children`. */}
      {subItem && (
        <div
          ref={flyoutRef}
          className="flex w-[184px] shrink-0 flex-col overflow-hidden rounded-2xl border border-(--color-border) bg-(--color-surface) shadow-2xl"
        >
          <div ref={flyoutListRef} className="space-y-0.5 p-1.5">
            {(subItem.children ?? []).map((option, j) => (
              <button
                key={option.id}
                type="button"
                onMouseEnter={() => setOptionIndex(j)}
                onClick={() => runOptionRef.current(j)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                  j === optionIndex ? "bg-(--color-accent-soft)" : "hover:bg-(--color-surface-2)"
                }`}
              >
                <span className="flex-1 text-sm font-medium text-(--color-text)">{option.label}</span>
                <Checkbox checked={option.checked} />
              </button>
            ))}
          </div>
        </div>
      )}
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
