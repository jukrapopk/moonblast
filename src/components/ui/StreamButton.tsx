import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";

interface DragState {
  startX: number;
  startY: number;
  winX: number;
  winY: number;
  scale: number;
  moved: boolean;
}

/** Inline Moonblast mark. Deliberately an inline `<svg>` (not an `<img>`) so
 *  there is no separate image layer in this tiny transparent window. */
function MoonblastMark() {
  const stroke = "rgb(179,214,229)";
  return (
    <svg
      viewBox="0 0 1000 1000"
      className="h-6 w-6"
      aria-hidden="true"
      style={{
        fillRule: "evenodd",
        clipRule: "evenodd",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        strokeMiterlimit: 1.5,
      }}
    >
      <g transform="matrix(1.26435,0,0,1.26435,-132.175,-132.175)">
        <circle cx="500" cy="500" r="172.756" fill={stroke} />
      </g>
      <g transform="matrix(2.43731,0,0,2.43731,-718.656,-718.656)">
        <path
          d="M500,327.244C580.348,327.244 647.958,382.215 667.241,456.568"
          fill="none"
          stroke={stroke}
          strokeWidth="56.35"
        />
      </g>
      <g transform="matrix(-2.43731,0,0,2.43731,1718.66,-718.656)">
        <path
          d="M500,327.244C580.348,327.244 647.958,382.215 667.241,456.568"
          fill="none"
          stroke={stroke}
          strokeWidth="56.35"
        />
      </g>
      <g transform="matrix(-2.43731,2.98485e-16,-2.98485e-16,-2.43731,1718.66,1718.7)">
        <path
          d="M500,327.244C580.348,327.244 647.958,382.215 667.241,456.568"
          fill="none"
          stroke={stroke}
          strokeWidth="56.35"
        />
      </g>
      <g transform="matrix(2.43731,-2.98485e-16,-2.98485e-16,-2.43731,-718.656,1718.7)">
        <path
          d="M500,327.244C580.348,327.244 647.958,382.215 667.241,456.568"
          fill="none"
          stroke={stroke}
          strokeWidth="56.35"
        />
      </g>
    </svg>
  );
}

/**
 * Contents of the `stream-button` window — a small, draggable, always-on-top
 * handle that opens the floating menu (Parsec-style). It never takes focus
 * (`focusable(false)`), so it can sit over a stream without disturbing input.
 *
 * Baseline for debugging: no ring / hover / press / transition effects — just
 * the circle and the logo. Effects get added back one at a time once the
 * rendering artifact is understood.
 */
export function StreamButton() {
  const drag = useRef<DragState | null>(null);
  const followPending = useRef(false);

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
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
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
      <div className="flex aspect-square h-full items-center justify-center rounded-full bg-(--color-surface-2)">
        <MoonblastMark />
      </div>
    </div>
  );
}
