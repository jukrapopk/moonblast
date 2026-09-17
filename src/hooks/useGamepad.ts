/**
 * Gamepad → spatial navigation bridge. The gamepad's D-pad and
 * left stick route through `dispatchDirection` — the same shared
 * function the keyboard listener uses — so gamepad and keyboard
 * are indistinguishable in behaviour: same lost-focus recovery,
 * same text-input passthrough, same scope locks, same Up-arrow
 * "jump to nav" override. Face buttons (A/B) handle activate /
 * cancel; no other gamepad buttons are mapped — view cycling
 * and other navigation flows go through the directional pad.
 *
 * Mount once at the app root, alongside `useSpatialController`.
 */
import { useEffect } from "react";
import { dispatchDirection } from "../input/useSpatialController";
import { useSpatialControllerInternals } from "../input/controllerInternals";
import { enterLrudMode } from "./useLrudMode";

const ENTER_KEY = "Enter";
const ESCAPE_KEY = "Escape";

function dispatchKey(key: string) {
  // Fallback when no Enter/Escape handler is registered on the LIFO
  // stack (e.g. gamepad A outside any modal). Synthesising the keydown
  // lets native <button> click activation still fire through the
  // spatial controller.
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
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

    function isLikelyGamepad(pad: Gamepad): boolean {
      // Chromium's `navigator.getGamepads()` enumerates every HID
      // device that exposes a gamepad descriptor — including
      // Bluetooth audio dongles, presentation clickers, and other
      // non-gamepad hardware that happens to advertise the class.
      // Filter them out with two cheap heuristics:
      //   - a real pad has at least 4 buttons (A/B/X/Y minimum)
      //   - a real pad has at least 2 axes (left stick)
      // The Xbox 360/One/Series, DualShock 4, DualSense, Switch Pro,
      // and every HID-XInput clone all satisfy both.
      return pad.buttons.length >= 4 && pad.axes.length >= 2;
    }

    function poll() {
      const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
      const pad = pads.find((p) => p && p.connected && isLikelyGamepad(p)) ?? null;

      if (pad) {
        // Face buttons only — A activates, B cancels. The
        // shoulders (LB/RB) used to cycle top-level views, but
        // that flow is gone: view switching now happens through
        // the directional pad via the TopBar nav buttons, the
        // same path keyboard users take. Each pressed-button /
        // pressed-axis edge also drives LRUD-mode entry so the
        // cursor hides when the user starts interacting with the
        // pad (matching the keyboard's `keydown` entry path).
        // No per-frame re-arm — that approach caused cursor
        // flicker because mousemove would exit at 60Hz while the
        // pad was plugged in.
        const faces: [number, "enter" | "escape"][] = [
          [0, "enter"],
          [1, "escape"],
        ];
        for (const [idx, kind] of faces) {
          const btn = pad.buttons[idx];
          if (!btn) continue;
          const id = `btn-${idx}`;
          if (btn.pressed && !held.has(id)) {
            held.add(id);
            enterLrudMode();
            if (kind === "enter") {
              // Route through the registered enter-stack so modal
              // primary actions (submit / pick) win. If nothing is on
              // the stack, manually click the focused element —
              // synthesised `KeyboardEvent`s don't trigger the
              // browser's native button activation (only trusted
              // keydowns do), so we have to drive it ourselves.
              const handler = peekEnter();
              if (handler) handler(new KeyboardEvent("keydown", { key: ENTER_KEY }));
              else {
                const a = document.activeElement;
                if (a instanceof HTMLElement && typeof a.click === "function") {
                  a.click();
                } else {
                  dispatchKey(ENTER_KEY);
                }
              }
            } else if (kind === "escape") {
              const handler = peekEscape();
              if (handler) handler(new KeyboardEvent("keydown", { key: ESCAPE_KEY }));
              else dispatchKey(ESCAPE_KEY);
            }
          } else if (!btn.pressed) {
            held.delete(id);
          }
        }

        // D-pad. Routes through the same `dispatchDirection` helper
        // the keyboard listener uses, so D-pad / left-stick are
        // indistinguishable from arrow keys — same lost-focus
        // recovery, same text-input passthrough, same scope locks,
        // same Up-arrow "jump to nav" override.
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
            enterLrudMode();
            dispatchDirection(dir);
          } else if (!btn.pressed) {
            held.delete(id);
          }
        }

        // Left stick analog — same path as D-pad.
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
            enterLrudMode();
            dispatchDirection(dir as "up" | "down" | "left" | "right");
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
