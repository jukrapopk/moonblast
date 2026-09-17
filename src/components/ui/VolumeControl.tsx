import { type KeyboardEvent, useCallback } from "react";
import { SpeakerIcon } from "./SpeakerIcon";

interface VolumeControlProps {
  value: number;
  muted: boolean;
  label: string;
  /** Increment per Left/Right press (default 5). */
  step?: number;
  onVolumeChange: (value: number) => void;
  onToggleMute: () => void;
  disabled?: boolean;
}

/**
 * Combined speaker-icon + slider + percentage control — single
 * focusable element.
 *
 * Keyboard:
 *   - Left  — decrement volume by `step`.
 *   - Right — increment volume by `step`.
 *   - Enter / Space — toggle mute.
 *   - Up / Down fall through to the spatial-nav controller so the
 *     user can move between rows without first exiting the slider.
 *
 * Mouse:
 *   - Click anywhere on the track → jump to that volume level.
 *   - Click on the speaker icon → toggle mute.
 *   - Drag the thumb → continuous adjust (handled by the inner
 *     <input type="range"> which is invisibly overlaid).
 */
export function VolumeControl({
  value,
  muted,
  label,
  step = 5,
  onVolumeChange,
  onToggleMute,
  disabled,
}: VolumeControlProps) {
  // Visible volume is 0 when muted so the track shows empty; the
  // underlying value is preserved so we can restore on unmute.
  const visibleValue = muted || value === 0 ? 0 : value;
  const percent = visibleValue;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // Stop the event from reaching the window-level spatial-nav
        // controller — otherwise Left/Right would yank focus off this
        // control mid-adjust.
        e.stopPropagation();
        e.preventDefault();
        const base = muted ? 0 : value;
        if (e.key === "ArrowLeft") {
          onVolumeChange(Math.max(0, base - step));
        } else {
          onVolumeChange(Math.min(100, base + step));
        }
      } else if (e.key === " " || e.key === "Enter") {
        // Suppress the spatial-nav controller's Enter handler and
        // any default button activation; this control owns Enter.
        e.stopPropagation();
        e.preventDefault();
        onToggleMute();
      }
      // Up/Down fall through to the spatial-nav controller — they
      // move focus to the next/prev row, matching the rest of the
      // app's directional-nav pattern.
    },
    [disabled, muted, value, step, onVolumeChange, onToggleMute],
  );

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={visibleValue}
      aria-valuetext={muted ? "Muted" : `${visibleValue}%`}
      onKeyDown={handleKeyDown}
      className={`group/volume flex flex-1 items-center gap-2 rounded-full pt-1 pb-1 pl-1 pr-2 outline-none transition focus-visible:shadow-[0_0_0_2px_var(--color-accent)] ${
        disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"
      }`}
    >
      <button
        type="button"
        // Stop propagation so a click on the icon doesn't bubble
        // up to a track-click handler that would jump volume to 0%.
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) onToggleMute();
        }}
        // The wrapper owns the focus ring; this inner button stays
        // mouse-clickable but doesn't take keyboard focus away
        // (tabIndex={-1} so spatial nav + Tab skip past it).
        tabIndex={-1}
        aria-label={muted ? "Unmute" : "Mute"}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-(--color-muted) transition-colors hover:text-(--color-text) focus:outline-none focus-visible:outline-none"
      >
        <SpeakerIcon volume={value} muted={muted} size={16} />
      </button>
      <div className="relative min-w-0 flex-1">
        <div className="pointer-events-none h-1.5 overflow-hidden rounded-full bg-(--color-surface)">
          <div
            className="h-full rounded-full bg-(--color-accent) transition-[width] duration-100"
            style={{ width: `${percent}%` }}
          />
        </div>
        {/* Native range input overlaid for mouse drag + click-to-set.
            Invisible visually but accepts pointer events. */}
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            if (muted) onToggleMute();
            onVolumeChange(Number(e.currentTarget.value));
          }}
          tabIndex={-1}
          aria-hidden="true"
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 focus:outline-none focus-visible:outline-none"
        />
      </div>
      <span
        aria-hidden="true"
        className="w-10 shrink-0 text-right text-xs text-(--color-muted) tabular-nums"
      >
        {muted || value === 0 ? "Muted" : `${value}%`}
      </span>
    </div>
  );
}