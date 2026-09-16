/**
 * Gamepad → spatial navigation bridge. The gamepad is a pure directional
 * input device; instead of synthesising `KeyboardEvent`s (which used to
 * be the only path because the keyboard handler was the sole consumer),
 * we drive the spatial nav API directly. That removes the React keydown
 * round-trip and lets the same arrow go through whatever spatial scope
 * is active — including modal focus traps.
 *
 * Mount once at the app root, alongside `useSpatialController`.
 */
import { useEffect } from "react";
import { moveFocus } from "../input/spatialNav";
import { getSpatialScope } from "../input/useSpatialController";
import { useSpatialControllerInternals } from "../input/controllerInternals";

const ENTER_KEY = "Enter";
const ESCAPE_KEY = "Escape";

function dispatchKey(key: string, opts?: KeyboardEventInit) {
  // Some consumers (e.g. View cycler) still rely on a real keydown event
  // reaching the window listener. Dispatching a synthetic event keeps
  // Tab / Enter / Escape working without needing direct calls into
  // the controller for every gamepad button.
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts }));
}

export function useGamepad() {
  useEffect(() => {
    let raf = 0;
    // Edge state for both buttons and analog axes. Each entry is a string
    // id; presence means "currently held".
    const held = new Set<string>();

    function axisDir(v: number): -1 | 0 | 1 {
      return v < -0.5 ? -1 : v > 0.5 ? 1 : 0;
    }

    function poll() {
      const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
      const pad = pads.find((p) => p && p.connected) ?? null;

      if (pad) {
        // Face + shoulder buttons.
        const faces: [number, "enter" | "escape" | "tab-prev" | "tab-next"][] = [
          [0, "enter"],
          [1, "escape"],
          [4, "tab-prev"], // LB
          [5, "tab-next"], // RB
        ];
        for (const [idx, kind] of faces) {
          const btn = pad.buttons[idx];
          if (!btn) continue;
          const id = `btn-${idx}`;
          if (btn.pressed && !held.has(id)) {
            held.add(id);
            if (kind === "enter") {
              // Route through the registered enter-stack so modal
              // primary actions (submit / pick) win. If nothing is on
              // the stack, fall through to a synthetic keydown so
              // native <button> click activation still fires.
              const handler = peekEnter();
              if (handler) handler(new KeyboardEvent("keydown", { key: ENTER_KEY }));
              else dispatchKey(ENTER_KEY);
            } else if (kind === "escape") {
              const handler = peekEscape();
              if (handler) handler(new KeyboardEvent("keydown", { key: ESCAPE_KEY }));
              else dispatchKey(ESCAPE_KEY);
            } else if (kind === "tab-prev") {
              dispatchKey("Tab", { shiftKey: true });
            } else {
              dispatchKey("Tab");
            }
          } else if (!btn.pressed) {
            held.delete(id);
          }
        }

        // D-pad. Direct spatial — goes through whatever scope is active
        // (so it respects modal traps automatically).
        const dpad: [number, "up" | "down" | "left" | "right"][] = [
          [12, "up"],
          [13, "down"],
          [14, "left"],
          [15, "right"],
        ];
        for (const [idx, dir] of dpad) {
          const btn = pad.buttons[idx];
          if (!btn) continue;
          const id = `dpad-${idx}`;
          if (btn.pressed && !held.has(id)) {
            held.add(id);
            moveFocus(document.activeElement, dir, getSpatialScope());
          } else if (!btn.pressed) {
            held.delete(id);
          }
        }

        // Left stick analog — same spatial path.
        const ax = pad.axes[0] ?? 0;
        const ay = pad.axes[1] ?? 0;
        const dx = axisDir(ax);
        const dy = axisDir(ay);
        for (const [dir, v] of [
          ["left", dx === -1],
          ["right", dx === 1],
          ["up", dy === -1],
          ["down", dy === 1],
        ] as [string, boolean][]) {
          const id = `axis-${dir}`;
          if (v && !held.has(id)) {
            held.add(id);
            moveFocus(
              document.activeElement,
              dir as "up" | "down" | "left" | "right",
              getSpatialScope(),
            );
          } else if (!v) {
            held.delete(id);
          }
        }
      } else {
        held.clear();
      }

      raf = requestAnimationFrame(poll);
    }

    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, []);
}

// Read-only peek at the LIFO stacks for the face-button bridge. The
// stacks live in `useSpatialController`; this thin indirection avoids a
// circular import and keeps the public API of the controller narrow.
const peekEnter = () => useSpatialControllerInternals.peekEnter();
const peekEscape = () => useSpatialControllerInternals.peekEscape();
