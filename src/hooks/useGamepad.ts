/**
 * Gamepad → spatial navigation bridge. The gamepad's D-pad and
 * left stick route through `dispatchDirection` — the same shared
 * function the keyboard listener uses — so gamepad and keyboard
 * are indistinguishable in behaviour: same lost-focus recovery,
 * same text-input passthrough, same scope locks, same Up-arrow
 * "jump to nav" override.
 *
 * Face buttons (A/B) route through the element-aware action
 * helpers in `gamepadActions.ts`:
 *   - A → `activateFocused()` (Enter + user-gesture activation,
 *     element-type aware).
 *   - B → `cancel()` (Escape).
 *
 * No other gamepad buttons are mapped. View switching goes
 * through the directional pad → TopBar nav buttons, the same
 * path keyboard users take.
 *
 * Mount once at the app root, alongside `useSpatialController`.
 */
import { useEffect } from "react";
import { dispatchDirection } from "../input/useSpatialController";
import { activateFocused, cancel } from "../input/gamepadActions";
import { useSpatialControllerInternals } from "../input/controllerInternals";
import { enterLrudMode } from "./useLrudMode";

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
        // Face buttons only — A activates, B cancels. Each
        // pressed-button edge also drives LRUD-mode entry so the
        // cursor hides when the user starts interacting with the
        // pad (matching the keyboard's `keydown` entry path). No
        // per-frame re-arm — that approach caused cursor flicker
        // because mousemove would exit at 60Hz while the pad
        // was plugged in.
        const faces: [number, "activate" | "cancel"][] = [
          [0, "activate"],
          [1, "cancel"],
        ];
        for (const [idx, kind] of faces) {
          const btn = pad.buttons[idx];
          if (!btn) continue;
          const id = `btn-${idx}`;
          if (btn.pressed && !held.has(id)) {
            held.add(id);
            enterLrudMode();
            // Modal LIFO handlers (registered via
            // `pushEnterHandler` / `pushEscapeHandler` from
            // useFocusTrap) win when active — they let modal
            // "submit" / "cancel" run before any element-specific
            // activation. When the stack is empty, fall through to
            // the element-aware action helper.
            if (kind === "activate") {
              const handler = peekEnter();
              if (handler) handler(new KeyboardEvent("keydown", { key: "Enter" }));
              else activateFocused();
            } else if (kind === "cancel") {
              const handler = peekEscape();
              if (handler) handler(new KeyboardEvent("keydown", { key: "Escape" }));
              else cancel();
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
