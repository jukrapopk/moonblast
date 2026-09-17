import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check } from "@phosphor-icons/react";
import { useFocusTrap } from "../../input/useSpatialController";

interface SelectOption {
  label: string;
  value: string;
  /**
   * Render the option as non-selectable. The button still appears
   * in the dropdown for visibility but is greyed out and can't be
   * picked. Used by the monitor dropdown for disconnected displays.
   */
  disabled?: boolean;
}
export type SelectOptionInput = string | SelectOption;

interface SelectProps {
  options: SelectOptionInput[];
  value: string;
  onChange: (value: string) => void;
  /** Disable the entire control. Mirrors the native `<select disabled>`. */
  disabled?: boolean;
  /** Accessible label for the trigger button (e.g. "Resolution"). */
  "aria-label"?: string;
  /**
   * Extra classes appended to the trigger button. Use `w-full` if
   * the Select sits inside a flex/grid layout that should fill the
   * available width — the dropdown panel then matches.
   */
  className?: string;
}

function toOption(o: SelectOptionInput): SelectOption {
  return typeof o === "string" ? { label: o, value: o } : o;
}

/**
 * Custom dropdown that replaces the native `<select>` element. One
 * single DOM component drives every input device — keyboard arrows,
 * gamepad D-pad, mouse hover, mouse click — so the behaviour is
 * consistent across the board.
 *
 * Trigger: a `<button>` showing the currently-selected label (or a
 * muted "—" placeholder when nothing matches). Click / Enter / A
 * opens the dropdown.
 *
 * Dropdown panel:
 *   - Portaled to `document.body` (sibling of `<main>`) so the
 *     panel's ancestor walk doesn't hit main's
 *     `data-lrud-scope-lock="all"` and leak arrows back to the page.
 *     `Modal` does the same thing.
 *   - `lrud-container` so the spatial library treats it as a scoped
 *     island — D-pad / arrows navigate between option buttons, never
 *     escape back to the page.
 *   - `useFocusTrap` for Escape / Tab handling. Escape closes the
 *     dropdown; focus restores to the trigger button.
 *   - Each option is a `<button>` with hover/focus styling. Mouse
 *     hover focuses it (via the global `useFocusOnHover`), so visual
 *     state matches keyboard state.
 *   - Disabled options render but are skipped by the spatial library.
 *
 * Positioning: anchored below the trigger by default, flipping up if
 * there isn't enough room below. Falls back to centered on small
 * viewports.
 */
export function Select({ options, value, onChange, disabled, "aria-label": ariaLabel, className }: SelectProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; triggerWidth: number; placeAbove: boolean } | null>(null);

  const items = options.map(toOption);
  const selected = items.find((o) => o.value === value) ?? null;
  const selectedIndex = items.findIndex((o) => o.value === value);

  // Position the panel beneath the trigger (or above if no room).
  // Two-pass: first paint the panel with a placeholder position,
  // measure its actual rendered height, then adjust. The single-
  // pass approach (assumes a fixed 280px max) left a visible gap
  // when the panel had only a few options — the formula subtracted
  // 280px from the trigger's top even though the panel was only
  // ~140px tall, leaving the dropdown floating in mid-air.
  const updatePosition = useCallback(() => {
    const t = triggerRef.current;
    const panel = panelRef.current;
    if (!t) return;
    const rect = t.getBoundingClientRect();
    // Use the panel's actual rendered height when available so the
    // flip-above offset matches the visible panel. Falls back to
    // the CSS-declared max-h-72 (288px) on the first render before
    // the panel is mounted.
    const panelHeight = panel?.offsetHeight ?? 288;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const placeAbove =
      panelHeight > spaceBelow && rect.top - panelHeight - 8 > 8;
    const top = placeAbove
      ? Math.max(8, rect.top - panelHeight - 4)
      : rect.bottom + 4;
    setPos({
      left: rect.left,
      top,
      triggerWidth: rect.width,
      placeAbove,
    });
  }, []);

  // Reposition after the panel mounts and lays out so the height
  // we measured matches reality. The single rAF defers past the
  // browser's first paint; `updatePosition` reads `panelRef.current`
  // which is set synchronously in the panel's ref callback.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => updatePosition());
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition, pos]);

  // Focus trap for Escape handling, Tab trapping, and spatial
  // scope. We pass `autoFocus: false` so the trap doesn't race
  // our own focus-to-selected effect — the autoFocus branch in
  // `useFocusTrap` schedules a single `requestAnimationFrame`
  // that lands on the first focusable, which would steal focus
  // from the selected option before our (double-rAF) selection
  // focus call fires on first open. We own the initial focus
  // below.
  useFocusTrap(panelEl, {
    onEscape: () => close(),
    autoFocus: false,
  });

  // When the panel opens, focus the currently-selected option
  // (or the first enabled option) and scroll it into view. The
  // initial scroll matters: long option lists (resolution /
  // refresh pickers) would otherwise render from the top while
  // the active row sits below the visible area, leaving the user
  // looking at irrelevant options on first paint. We match
  // buttons to options by element index so disabled entries in
  // `items` stay aligned with the rendered list (the
  // `[disabled]` filter on `querySelectorAll` would otherwise
  // skip past them and mis-target the focused button).
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      // Two rAFs to be sure layout has settled — `useFocusTrap`'s
      // autoFocus also fires on a single rAF and races with us.
      // The second rAF guarantees the panel's `scrollHeight` is
      // accurate and that the previous focus call (from
      // `useFocusTrap` auto-focusing the first focusable) has
      // already happened so our `target.focus()` wins.
      const id2 = requestAnimationFrame(() => {
        const panel = panelRef.current;
        if (!panel) return;
        const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>("button"));
        const target =
          buttons.find((b, i) => i >= (selectedIndex ?? -1) && !b.disabled) ??
          buttons.find((b) => !b.disabled) ??
          buttons[0];
        if (!target) return;
        target.focus();
        const panelRect = panel.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const offsetInPanel = targetRect.top - panelRect.top + panel.scrollTop;
        const targetCenter = offsetInPanel + targetRect.height / 2;
        panel.scrollTop = targetCenter - panel.clientHeight / 2;
      });
      // Stash cleanup on the outer rAF — the inner rAF will run
      // before this outer one is naturally GC'd.
      return () => cancelAnimationFrame(id2);
    });
    return () => cancelAnimationFrame(id);
  }, [open, selectedIndex]);

  // Keep the focused option in view as the user navigates with
  // D-pad / arrows. `focusin` fires only when focus actually
  // changes, so this doesn't fight with the initial-scroll above.
  useEffect(() => {
    if (!open) return;
    function onFocusIn(e: FocusEvent) {
      const t = e.target;
      if (!(t instanceof HTMLButtonElement)) return;
      const panel = panelRef.current;
      if (!panel) return;
      const panelRect = panel.getBoundingClientRect();
      const targetRect = t.getBoundingClientRect();
      const offsetInPanel = targetRect.top - panelRect.top + panel.scrollTop;
      // "nearest" semantics: only scroll if the target is
      // actually outside the visible area. Equivalent to
      // `scrollIntoView({ block: "nearest" })` but reliable for
      // fixed-positioned containers.
      const visibleTop = panel.scrollTop;
      const visibleBottom = visibleTop + panel.clientHeight;
      const targetTop = offsetInPanel;
      const targetBottom = offsetInPanel + targetRect.height;
      if (targetTop < visibleTop) {
        panel.scrollTop = targetTop;
      } else if (targetBottom > visibleBottom) {
        panel.scrollTop = targetBottom - panel.clientHeight;
      }
    }
    const panel = panelRef.current;
    panel?.addEventListener("focusin", onFocusIn);
    return () => panel?.removeEventListener("focusin", onFocusIn);
  }, [open]);

  // Outside-click closes the dropdown.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = triggerRef.current;
      const p = panelRef.current;
      if (t?.contains(e.target as Node)) return;
      if (p?.contains(e.target as Node)) return;
      close();
    }
    document.addEventListener("mousedown", onDoc, true);
    return () => document.removeEventListener("mousedown", onDoc, true);
  }, [open]);

  function close() {
    setOpen(false);
    // Restore focus to the trigger after the panel exits. Every
    // close path — Escape, outside-click, option commit — goes
    // through here so the trigger always regains focus. rAF
    // defers past framer-motion's exit / portal unmount so the
    // focus call doesn't fire on a node that's mid-detach.
    requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  }

  function commit(value: string) {
    onChange(value);
    close();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        // `min-w-44` gives every trigger a comfortable minimum so
        // a single-char option list (e.g. "On" / "Off") doesn't
        // collapse to a chip. No `w-full` — the dropdown panel
        // sizes to the trigger, and a stretched trigger produces
        // a stretched panel that balloons across the row. Callers
        // can pass `className="w-full"` if they want full-width.
        className={[
          "flex h-9 min-w-44 cursor-pointer items-center justify-between gap-2 rounded-lg border border-(--color-border) bg-(--color-surface-2) px-3 text-sm text-(--color-text) outline-none transition focus:border-(--color-accent) disabled:cursor-not-allowed disabled:opacity-40",
          className,
        ].filter(Boolean).join(" ")}
      >
        <span className={selected ? "truncate" : "truncate text-(--color-muted)"}>
          {selected ? selected.label : "—"}
        </span>
        <CaretDown
          size={14}
          weight="bold"
          className={`shrink-0 text-(--color-muted) transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && pos && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={(node) => {
              panelRef.current = node;
              setPanelEl(node);
            }}
            role="listbox"
            tabIndex={-1}
            // lrud-container — D-pad navigation stays inside the
            // panel. Portal places this at the body level so
            // <main>'s scope lock isn't an ancestor. Min-width
            // matches the trigger so the panel feels like an
            // extension of it; max-width caps the panel at a
            // reasonable size so very long option labels truncate
            // with an ellipsis instead of ballooning the panel.
            className="lrud-container fixed z-[60] max-h-72 min-w-(--trigger-w) max-w-xs overflow-y-auto rounded-lg border border-(--color-border) bg-(--color-surface-2) p-1 shadow-2xl outline-none"
            style={{
              left: pos.left,
              top: pos.top,
              // CSS custom property consumed by the Tailwind
              // `min-w-(--trigger-w)` class above.
              ["--trigger-w" as string]: `${pos.triggerWidth}px`,
            }}
          >
            {items.map((o, i) => {
              const isSelected = o.value === value;
              return (
                <button
                  key={`${o.value}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={o.disabled}
                  onClick={() => !o.disabled && commit(o.value)}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors focus:bg-(--color-surface) focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="flex w-4 shrink-0 items-center justify-center">
                    {isSelected && (
                      <Check size={12} weight="bold" className="text-(--color-accent)" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
