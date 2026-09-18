import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Modal } from "./Modal";

interface ColorPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Current value (`#RRGGBB`), or null if no custom color is set yet. */
  value: string | null;
  /** Called with the new hex whenever the user picks / edits. */
  onChange: (hex: string) => void;
}

const FALLBACK_HEX = "#6f78c8";

// --- hex / rgb / hsv conversion --------------------------------------------
// All three forms float around in this file — we keep the conversion
// helpers here rather than importing them so the picker is self-contained.
// Math is the standard CS primer version: HSV→RGB via the chroma/match
// decomposition, RGB→HSV via max/min delta.

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function isHex(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!isHex(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsv(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

function hsvToRgb(
  h: number,
  s: number,
  v: number,
): { r: number; g: number; b: number } {
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x] as unknown as number[];
  const m = v - c;
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

/** Build the conic-style rainbow used by the hue strip. We don't use
 *  conic-gradient here because (a) conic stops are awkward to keep
 *  aligned with the drag thumb on a horizontal strip and (b) the
 *  CSS `linear-gradient(to right, red, ...)` along the hue axis is
 *  the standard picker shape (matches every OS color dialog). */
const HUE_GRADIENT =
  "linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)";

// --- components -------------------------------------------------------------

/**
 * Saturation/Value square: a pure-hue background with a white-to-transparent
 * horizontal gradient (controls saturation) layered under a transparent-to-
 * black vertical gradient (controls value). The draggable dot represents the
 * current S/V pick. Mouse-only — the modal has a hex input for keyboard users.
 */
function SaturationValueArea({
  hue,
  saturation,
  value,
  onPick,
}: {
  hue: number;
  saturation: number;
  value: number;
  onPick: (s: number, v: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // `dragging` is a ref, not state — it only gates `onPointerMove`,
  // it doesn't affect render. Using state here would force a
  // full re-render of the SV area on every pointerdown (no visible
  // change, but enough to trigger a paint + cascade through the
  // picker's HSV→hex→parent→back effect chain), which manifested
  // as a one-frame flicker on drag start. Ref is the right primitive.
  const draggingRef = useRef(false);

  const pickFromEvent = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const s = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const v = clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1);
      onPick(s, v);
    },
    [onPick],
  );

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    pickFromEvent(e);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    pickFromEvent(e);
  }
  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Pure-hue rgb at full S/V — used as the area's base layer.
  const baseRgb = hsvToRgb(hue, 1, 1);
  const baseColor = rgbToHex(baseRgb.r, baseRgb.g, baseRgb.b);
  // Dot position: x = sat * width, y = (1 - value) * height, in percent.
  const left = `${saturation * 100}%`;
  const top = `${(1 - value) * 100}%`;

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="presentation"
      aria-hidden="true"
      className="relative aspect-[16/10] w-full touch-none select-none rounded-lg"
      style={{
        backgroundColor: baseColor,
        // Layer order (paint order): solid pure-hue base, then the
        // white→transparent horizontal gradient on top (controls
        // saturation: left edge is white-tinted hue, right edge is
        // pure hue), then the transparent→black vertical gradient on
        // top of that (controls value: top edge is light, bottom is
        // black). No `background-blend-mode` needed — `normal` is the
        // default and these are plain alpha-over composites.
        backgroundImage:
          "linear-gradient(to right, #ffffff, transparent), linear-gradient(to top, #000000, transparent)",
      }}
    >
      {/* Draggable indicator — a white-bordered dot. Cursor stays
          `cursor-pointer` via touch-none on the wrapper above so the
          OS cursor doesn't flicker mid-drag. */}
      <div
        className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0_/_0.3)]"
        style={{ left, top }}
      />
    </div>
  );
}

/** Horizontal hue strip with a draggable thumb. Same pointer-capture
 *  pattern as the SV area. */
function HueStrip({
  hue,
  onPick,
}: {
  hue: number;
  onPick: (h: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Ref instead of state — see SaturationValueArea for the full
  // reasoning. Same drag-flicker fix applies.
  const draggingRef = useRef(false);

  const pickFromEvent = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const h = clamp(
        ((e.clientX - rect.left) / rect.width) * 360,
        0,
        359.999,
      );
      onPick(h);
    },
    [onPick],
  );

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    pickFromEvent(e);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    pickFromEvent(e);
  }
  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const left = `${(hue / 360) * 100}%`;
  // Thumb color = the pure-hue color so it visually "comes from" that
  // part of the rainbow — matches every OS color dialog.
  const thumbRgb = hsvToRgb(hue, 1, 1);
  const thumbColor = rgbToHex(thumbRgb.r, thumbRgb.g, thumbRgb.b);

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="presentation"
      aria-hidden="true"
      className="relative h-3 w-full touch-none select-none rounded-full"
      style={{ backgroundImage: HUE_GRADIENT }}
    >
      <div
        className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0_/_0.3)]"
        style={{ left, top: "50%", backgroundColor: thumbColor }}
      />
    </div>
  );
}

/**
 * In-app color picker modal. Two-surface (SV area + hue strip) plus a hex
 * input. Hex and SV area are kept in sync both ways — editing the hex
 * updates the SV position, dragging the SV updates the hex.
 *
 * The native `<input type="color">` dialog used by the previous revision
 * had a known WebView2/Edge quirk where its position was anchored to the
 * hidden input's bounding rect (which we couldn't place near the trigger), so
 * the dialog popped up somewhere unrelated to the click. This in-app
 * surface avoids that entirely while giving the user a real picker.
 */
export function ColorPickerModal({
  open,
  onClose,
  value,
  onChange,
}: ColorPickerModalProps) {
  // Initial HSV is derived from `value` on mount and on every open flip —
  // the user might have picked something else in the hex field while the
  // modal was closed, and we want the area / hue to land at the right
  // starting dots, not snap back to whatever was picked last time the
  // modal was open.
  const seed = value && isHex(value) ? value : FALLBACK_HEX;
  const seedRgb = hexToRgb(seed)!;
  const initialHsv = rgbToHsv(seedRgb.r, seedRgb.g, seedRgb.b);

  const [hue, setHue] = useState(initialHsv.h);
  const [saturation, setSaturation] = useState(initialHsv.s);
  const [valueV, setValueV] = useState(initialHsv.v);
  const [hexDraft, setHexDraft] = useState(seed);

  // Re-seed on the closed → open transition (NOT on every `value`
  // change). Re-seeding on every value change creates a feedback
  // loop: HSV → onChange → parent updates value prop → this effect
  // re-derives HSV from value (with quantisation drift from the
  // rgbToHex round-trip — Math.round clips 127.5 → 128 → rgbToHsv
  // reads 128/255 = 0.502 ≠ 0.5) → state updates → dot visibly
  // shifts ~0.2% on every click. Tracking the previous `open` value
  // in a ref makes the effect fire exactly once per open flip.
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      const v = value && isHex(value) ? value : FALLBACK_HEX;
      const rgb = hexToRgb(v);
      if (rgb) {
        const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        setHue(hsv.h);
        setSaturation(hsv.s);
        setValueV(hsv.v);
        setHexDraft(v);
      }
    }
    prevOpenRef.current = open;
  }, [open, value]);

  // Every HSV change → committed hex → parent. Skip when the modal
  // isn't open so an out-of-band hex tweak doesn't push back through
  // the HSV pipeline (would create a feedback loop with the row's hex
  // input).
  useEffect(() => {
    if (!open) return;
    const rgb = hsvToRgb(hue, saturation, valueV);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    setHexDraft(hex);
    onChange(hex);
  }, [open, hue, saturation, valueV, onChange]);

  function handleHexChange(v: string) {
    // Allow free typing — only commit valid hex back to HSV so a
    // half-typed string doesn't crash the area to a wrong color.
    setHexDraft(v);
    if (isHex(v)) {
      const rgb = hexToRgb(v)!;
      const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      setHue(hsv.h);
      setSaturation(hsv.s);
      setValueV(hsv.v);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Custom color" width="max-w-sm">
      <div className="space-y-4">
        <SaturationValueArea
          hue={hue}
          saturation={saturation}
          value={valueV}
          onPick={(s, v) => {
            setSaturation(s);
            setValueV(v);
          }}
        />
        <HueStrip
          hue={hue}
          onPick={(h) => setHue(h)}
        />
        <div className="flex items-center gap-2">
          <div
            className="h-9 w-9 shrink-0 rounded-lg border border-(--color-border)"
            style={{
              backgroundColor: hexDraft,
            }}
            aria-hidden="true"
          />
          <input
            type="text"
            value={hexDraft}
            onChange={(e) => handleHexChange(e.currentTarget.value.trim())}
            placeholder="#rrggbb"
            maxLength={7}
            // No tabIndex=-1 here — the hex input is the keyboard entry
            // point for the picker. Modal's autoFocus lands here on open
            // (it's the first focusable inside the panel).
            className="h-9 w-full rounded-md border border-(--color-border) bg-(--color-surface) px-3 font-mono text-sm text-(--color-text) outline-none focus:border-(--color-accent)"
          />
        </div>
      </div>
    </Modal>
  );
}