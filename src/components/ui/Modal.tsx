import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "@phosphor-icons/react";
import { useFocusTrap } from "../../input/useSpatialController";
import { focusInitial } from "../../input/spatialNav";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  /** Bootstrap max-width class, e.g. "max-w-md" */
  width?: string;
  /**
   * Optional control rendered in the header row, to the left of the X
   * close button (e.g. a radio on/off toggle). Only shown alongside
   * `title`/`subtitle` — the header row doesn't render otherwise.
   */
  headerAction?: ReactNode;
  /**
   * Selector or element to focus when the modal opens. Defaults to the
   * first focusable inside the panel. Pass `"none"` to skip autoFocus
   * (e.g. when the panel doesn't have a sensible first stop).
   */
  initialFocus?: string | HTMLElement | null | "none";
}

/**
 * Modal panel with full focus-trap semantics:
 *   - Escape closes (registered on the global LIFO escape stack)
 *   - Arrow keys are constrained to the panel via `setSpatialScope`
 *   - On open, focus moves to `initialFocus` (or the first focusable)
 *   - On close, focus is restored to the element that was focused before
 *     the modal opened (typically the chip / button that triggered it)
 *   - While open, any focus that lands outside the panel is yanked back
 *     to the panel on the next frame (focusin sanitizer)
 *
 * Focus management is driven directly off the DOM (MutationObserver +
 * per-open generation token) rather than through React state, so the
 * AnimatePresence close/reopen race cannot leave focus stranded on body
 * or stolen by a stale rAF from a torn-down panel.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = "max-w-md",
  initialFocus,
  headerAction,
}: ModalProps) {
  // Two parallel handles on the live panel:
  //   - `panelElRef` is the ref the AnimatePresence ref callback
  //     writes to, kept live between renders and queried by the
  //     MutationObserver / focusin sanitizer (which fire
  //     asynchronously and shouldn't depend on a stale closure).
  //   - `panelEl` is state that re-renders this component when the
  //     ref callback fires, so `useFocusTrap`'s effect (which reads
  //     `panel` from its render-time closure) actually runs with the
  //     live node — a ref alone never triggers re-renders, which
  //     would leave the escape handler / scope / Tab wrap un-installed.
  const panelElRef = useRef<HTMLDivElement | null>(null);
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);

  // Stash onClose in a ref so callers passing inline callbacks don't
  // churn the focus-trap effect on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const initialFocusProp =
    initialFocus === "none" ? null : (initialFocus ?? undefined);

  // Focus trap owns Escape + Enter stack, scope, and Tab wrap. It does
  // NOT schedule any autoFocus — that's owned by the open/close effect
  // below so there is one and only one focus scheduler per lifecycle.
  useFocusTrap(panelEl, {
    onEscape: () => onCloseRef.current(),
  });

  // Bridge the ref callback to BOTH the ref and the state. The state
  // write is what makes `useFocusTrap` re-run with the live node; the
  // ref write is what the observer / sanitizer read off the live DOM
  // without depending on a captured closure. Keeping both in sync is
  // safe because they never diverge for more than one frame.
  const setRefs = useCallback((node: HTMLDivElement | null) => {
    panelElRef.current = node;
    setPanelEl(node);
  }, []);

  // The whole open/close lifecycle. A single effect, keyed on `open`,
  // owns the previously-focused capture, the autoFocus application,
  // and the close-restore rAF. Inside it a per-open generation token
  // (`gen`) invalidates any pending work when `open` flips, so a stale
  // open's autoFocus rAF cannot fire on the wrong panel after a
  // rapid close-and-reopen.
  useEffect(() => {
    if (!open) return;
    if (typeof document === "undefined") return;

    const restoreTo: HTMLElement | null =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // True after the trap has closed (open flipped false) so any
    // pending work from this cycle bails.
    let closed = false;

    function applyInitialFocus() {
      if (closed) return;
      const panel = panelElRef.current;
      if (!panel || !panel.isConnected) return;
      // If something inside the panel already has focus, do nothing —
      // a Tab wrap or arrow move shouldn't be overridden.
      const active = document.activeElement;
      if (active && panel.contains(active)) return;
      if (typeof initialFocusProp === "string") {
        const target = panel.querySelector<HTMLElement>(initialFocusProp);
        if (target) {
          target.focus();
          return;
        }
      } else if (initialFocusProp instanceof HTMLElement) {
        initialFocusProp.focus();
        return;
      }
      focusInitial(panel);
    }

    // The panel is rendered by AnimatePresence; on rapid close -> reopen
    // the old panel's motion.div unmounts at the end of its exit animation
    // and the new one mounts in parallel. Watch the DOM directly so we
    // don't have to coordinate with React's commit timing. The
    // `[data-modal-panel]` attribute below identifies OUR panel.
    const observer = new MutationObserver(() => {
      // First match wins — the observer fires whenever a new matching
      // node attaches, including AnimatePresence's initial mount.
      applyInitialFocus();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Also catch the case where the panel already mounted before our
    // effect ran (very fast open of a previously-rendered Modal). A
    // microtask + rAF covers both paths.
    queueMicrotask(() => {
      applyInitialFocus();
      requestAnimationFrame(applyInitialFocus);
    });

    // Sanitizer: any focus landing outside the panel while we're open
    // is yanked back to the panel on the next frame. Covers all
    // focusin paths (mousedown, programmatic focus, Tab's natural
    // walk into the document body, etc).
    //
    // Exception: focus landing inside a sibling floating UI (a Select
    // dropdown, a ContextMenu, another Modal) is left alone. Those
    // are deliberate user actions — clicking a Select trigger inside
    // the modal opens the dropdown panel and moves focus into an
    // option; the sanitizer must not steal that focus back to the
    // modal panel's first focusable (the X close button). Matches
    // any ancestor marked as a "floating UI root" via role=dialog /
    // role=listbox / role=menu / role=tooltip.
    function isInsideFloatingUi(target: EventTarget | null): boolean {
      let cur: Node | null = target instanceof Node ? target : null;
      while (cur && cur !== document.body) {
        if (!(cur instanceof Element)) {
          cur = cur.parentNode;
          continue;
        }
        const role = cur.getAttribute?.("role");
        if (
          role === "dialog" ||
          role === "listbox" ||
          role === "menu" ||
          role === "tooltip" ||
          cur.hasAttribute("data-modal-panel")
        ) {
          return true;
        }
        cur = cur.parentElement;
      }
      return false;
    }
    function onFocusIn(e: FocusEvent) {
      if (closed) return;
      const panel = panelElRef.current;
      if (!panel || !panel.isConnected) return;
      const target = e.target;
      if (target instanceof Node && panel.contains(target)) return;
      if (target === panel) return;
      if (isInsideFloatingUi(target)) return;
      // Defer so we don't fight the event that triggered the focus
      // shift (e.g. an overlay mousedown that also calls onClose —
      // we want onClose to win if it's the click-to-close path).
      requestAnimationFrame(() => {
        if (closed) return;
        // Double-check at rAF time: focus may have moved again
        // (e.g. Select's own initial-focus double-rAF fired). If
        // activeElement is now inside a floating UI, leave it.
        const active = document.activeElement;
        if (active && !panel.contains(active) && isInsideFloatingUi(active)) return;
        applyInitialFocus();
      });
    }
    document.addEventListener("focusin", onFocusIn, true);

    return () => {
      closed = true;
      observer.disconnect();
      document.removeEventListener("focusin", onFocusIn, true);

      // Restore focus on close. The body of this cleanup runs when
      // `open` flips false OR the Modal unmounts. If we captured a
      // valid restore target and it's still connected, focus it;
      // otherwise the trigger was unmounted (rapid view swap) — fall
      // back to the active view's nav button so the user is never
      // stranded on body.
      // Defer one frame past framer-motion's exit so we don't fight
      // the unmount.
      requestAnimationFrame(() => {
        if (restoreTo && restoreTo.isConnected) {
          restoreTo.focus();
        } else {
          const sel =
            '[data-active-view]:not([data-active-view=""]):not([data-active-view="false"])';
          const btn = document.querySelector<HTMLElement>(sel);
          btn?.focus();
        }
      });
    };
  }, [open, initialFocusProp]);

  // Render the overlay + panel into `document.body` via a React portal.
  // Without this, a Modal mounted inside `<main>` would make `<main>`'s
  // `data-lrud-scope-lock="all"` an ancestor of the modal's focused
  // button, which the spatial controller's `findDirectionalScope`
  // then picks as the directional scope — letting arrows reach every
  // focusable in main, including the page content behind the modal.
  // Hoisting the DOM up to body (sibling of <main>) removes that
  // ancestor lock and the spatial scope correctly falls back to the
  // modal panel itself. React events still bubble through the React
  // tree as normal; only the DOM placement changes.
  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          // Close only when the press itself starts on the overlay (not
          // when the user drags out of the panel and releases here).
          onMouseDown={onClose}
          className="fixed inset-0 z-50 flex items-center justify-center bg-(--color-overlay) p-6 backdrop-blur-sm"
        >
          <motion.div
            ref={setRefs}
            data-modal-panel=""
            role="dialog"
            aria-modal="true"
            initial={{ scale: 0.96, y: 8, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.96, y: 8, opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className={`w-full ${width} rounded-2xl border border-(--color-border) bg-(--color-surface-2) p-5 outline-none`}
          >
            {(title || subtitle) && (
              <div className="mb-5 flex items-start justify-between">
                <div>
                  {title && <h2 className="text-lg font-semibold tracking-tight">{title}</h2>}
                  {subtitle && <p className="mt-0.5 text-sm text-(--color-muted)">{subtitle}</p>}
                </div>
                {/* `flex-row-reverse` keeps X visually rightmost (the
                 *  header action, e.g. a toggle, sits to its left) while
                 *  the X button stays FIRST in DOM order — so it's still
                 *  the default `focusInitial` target (document-order
                 *  `querySelector`) and the first Tab stop, matching the
                 *  original close-button-first behavior. */}
                <div className="flex flex-row-reverse items-center gap-2">
                  <button
                    onClick={onClose}
                    aria-label="Close"
                    // Circular shape so the focus ring follows a circle
                    // instead of the default rectangular button outline.
                    // Sized to comfortably fit the 20px X icon plus the
                    // 2px focus ring outside; h-9 / w-9 matches the
                    // TopBarButton's circular touch target for visual
                    // consistency across the app.
                    className="flex h-9 w-9 items-center justify-center rounded-full text-(--color-muted) transition focus-visible:bg-(--color-surface) focus-visible:text-(--color-text)"
                  >
                    <X size={20} weight="bold" />
                  </button>
                  {headerAction}
                </div>
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
