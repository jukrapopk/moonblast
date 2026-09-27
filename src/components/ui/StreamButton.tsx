import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import logo from "../../../src-tauri/icons/icon.png";

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
 * handle (Moonblast logo) that opens the floating menu (Parsec-style). It never
 * takes focus (`focusable(false)`), so it can sit over a stream without
 * disturbing input.
 *
 * Drag is done in JS: we track the *absolute* cursor delta from the press and
 * translate the window by the same amount, so the window moving under the
 * cursor can't feed back into the delta. A press that doesn't move past a small
 * threshold counts as a click and toggles the menu.
 */
export function StreamButton() {
  const drag = useRef<DragState | null>(null);
  const [active, setActive] = useState(false);

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
    setActive(true);
  }

  async function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.screenX - d.startX) * d.scale;
    const dy = (e.screenY - d.startY) * d.scale;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    await getCurrentWindow().setPosition(
      new PhysicalPosition(Math.round(d.winX + dx), Math.round(d.winY + dy)),
    );
  }

  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    setActive(false);
    if (d && !d.moved) void invoke("stream_button_click").catch(() => {});
  }

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="flex h-full w-full cursor-grab items-center justify-center active:cursor-grabbing"
    >
      <div
        className={`flex h-11 w-11 items-center justify-center rounded-full border border-(--color-border) bg-(--color-surface-2) shadow-2xl transition ${
          active ? "scale-95" : "hover:border-(--color-accent)"
        }`}
      >
        <img
          src={logo}
          alt="Moonblast"
          draggable={false}
          className="h-6 w-6 rounded-full object-contain"
        />
      </div>
    </div>
  );
}
