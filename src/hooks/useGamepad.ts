import { useEffect } from "react";

/**
 * Bridges gamepad input to keyboard events so gamepads drive the same UI
 * navigation as the keyboard (arrows, Enter, Escape, Tab / Shift+Tab).
 * Mount once at the app root.
 */
export function useGamepad() {
  useEffect(() => {
    let raf = 0;
    // Track edge state: gamepad button/axis ids currently "held".
    const held = new Set<string>();

    function dispatch(key: string, opts?: { shiftKey?: boolean }) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts }));
    }

    function send(dir: "up" | "down" | "left" | "right") {
      const key = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" }[dir];
      dispatch(key);
    }

    function axisDir(v: number): -1 | 0 | 1 {
      return v < -0.5 ? -1 : v > 0.5 ? 1 : 0;
    }

    function poll() {
      const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
      const pad = pads.find((p) => p && p.connected) ?? null;

      if (pad) {
        // Face + shoulder buttons.
        const faces: [number, string][] = [
          [0, "Enter"],
          [1, "Escape"],
          [4, "Tab"], // LB
          [5, "Tab"], // RB
        ];
        for (const [idx, key] of faces) {
          const btn = pad.buttons[idx];
          if (!btn) continue;
          const id = `btn-${idx}`;
          if (btn.pressed && !held.has(id)) {
            held.add(id);
            dispatch(key, { shiftKey: idx === 4 });
          } else if (!btn.pressed) {
            held.delete(id);
          }
        }

        // D-pad.
        const dpad: [number, string][] = [
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
            send(dir as "up" | "down" | "left" | "right");
          } else if (!btn.pressed) {
            held.delete(id);
          }
        }

        // Left stick analog.
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
            send(dir as "up" | "down" | "left" | "right");
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