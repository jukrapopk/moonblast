import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { MoonblastMark } from "./MoonblastMark";

interface DragState {
  startX: number;
  startY: number;
  winX: number;
  winY: number;
  scale: number;
  moved: boolean;
}

/**
 * Contents of the `stream-button` window — a small, draggable, always-on-top
 * handle that opens the floating menu (Parsec-style). It never takes focus
 * (`focusable(false)`), so it can sit over a stream without disturbing input.
 *
 * Drag is tracked from the *absolute* cursor delta captured on pointer-down and
 * fed to `setPosition`, so the moving window can't feed back into the delta.
 * Past ~4px it counts as a drag — which pins the position in Rust via
 * `stream_button_moved`; below that, pointer-up is a click that toggles the
 * menu. The ring + tint are drawn *inside* the circle: nothing sits on the
 * outer edge, where the removed OS region clip used to leave artifacts.
 */
export function StreamButton() {
  const drag = useRef<DragState | null>(null);
  const followPending = useRef(false);
  // True while the open menu's current target is the button itself (its default
  // state) — shows the accent ring. The menu drives it; Rust clears it on hide.
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const un = listen<{ on: boolean }>("menu-focus", (e) => setFocused(e.payload.on));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  function scheduleFollow() {
    if (followPending.current) return;
    followPending.current = true;
    requestAnimationFrame(() => {
      followPending.current = false;
      void invoke("stream_menu_follow").catch(() => {});
    });
  }

  async function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const win = getCurrentWindow();
    const [pos, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
    drag.current = {
      startX: e.screenX,
      startY: e.screenY,
      winX: pos.x,
      winY: pos.y,
      scale,
      moved: false,
    };
  }

  async function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.screenX - d.startX) * d.scale;
    const dy = (e.screenY - d.startY) * d.scale;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      d.moved = true;
      // Tell Rust this is a real drag, so it stops re-placing the button at its
      // default spot on every show and remembers where the user put it.
      void invoke("stream_button_moved").catch(() => {});
    }
    await getCurrentWindow().setPosition(
      new PhysicalPosition(Math.round(d.winX + dx), Math.round(d.winY + dy)),
    );
    scheduleFollow();
  }

  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) scheduleFollow();
    else void invoke("stream_button_click").catch(() => {});
  }

  return (
    // The wrapper fills the window (it owns the drag handlers); the visual is a
    // circle inside. No OS region clip anymore — the window is a plain
    // transparent square and the circle is pure CSS.
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="flex h-full w-full cursor-grab items-center justify-center active:cursor-grabbing"
    >
      <div
        className={`group flex aspect-square h-full items-center justify-center rounded-full bg-(--color-surface-2) p-0.5 text-[#b3d6e5] transition-shadow duration-150 ${
          // Tint the whole circle while the button is the menu's target (a huge
          // inset shadow = a tint layer, painted under the ring/logo).
          focused ? "[box-shadow:inset_0_0_0_100px_var(--color-accent-soft)]" : ""
        }`}
      >
        {/* The highlight ring is drawn 2px inside the circle (inner element at
         *  40px) so nothing sits on the outer edge — no clipping artifacts. */}
        <div
          className={`flex h-full w-full items-center justify-center rounded-full ring-1 ring-inset transition-colors duration-150 ${
            focused
              ? "ring-(--color-accent)"
              : "ring-transparent group-hover:ring-(--color-accent) group-active:ring-(--color-accent)"
          }`}
        >
          <MoonblastMark />
        </div>
      </div>
    </div>
  );
}
