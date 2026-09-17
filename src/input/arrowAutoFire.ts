/**
 * Arrow-key hold-to-rapid-fire.
 *
 * Both the keyboard listener and the gamepad adapter need to
 *   - press an arrow once on first push
 *   - if the arrow stays held past `HOLD_INITIAL_DELAY_MS` (400ms),
 *     emit one synthetic keydown on `Arrow*`
 *   - then keep emitting at `HOLD_REPEAT_MS` (500ms) cadence while
 *     the arrow stays held
 *   - release on the corresponding keyup / direction-null
 *
 * Keyboard would auto-repeat natively, but the OS's initial-delay
 * and repeat rate are wrong for our use (Windows defaults to ~500ms
 * initial then ~33/sec). We override it with this helper so keyboard
 * and gamepad feel identical.
 *
 * Implementation
 * --------------
 * A small module-level Map of active holds, keyed by `source` (a
 * string the caller picks — "keyboard" or "gamepad/0" etc., so
 * multiple gamepads don't collide and the keyboard doesn't collide
 * with gamepad-A). Holds carry `{ direction, startedAt, nextFireAt }`.
 *
 * One rAF loop drives every active hold. The loop self-stops when
 * the map drains, restarting when `startArrowHold` adds a new entry.
 * `bindAutoFire` registers the actual dispatch callback once at
 * adapter install time.
 *
 * Tuned values match a "comfortable" repeat rate for spatial nav:
 * 400ms before the first repeat feels deliberate; 500ms between
 * repeats lets the user land on a specific tile without overshoot.
 */
import type { Direction } from "./spatialNav";

const HOLD_INITIAL_DELAY_MS = 300;
const HOLD_REPEAT_MS = 300;

interface Hold {
  direction: Direction;
  startedAt: number;
  /** Whether the leading edge has been emitted. `true` initially so
   *  the caller's own `keydown` / `press` dispatch is the only
   *  leading-edge emission; the helper skips its first tick. */
  leading: boolean;
  /** `performance.now()` ms at which the next repeat dispatch should fire. */
  nextFireAt: number;
}

const holds = new Map<string, Hold>();

let rafId: number | null = null;
let boundEmit: ((source: string, direction: Direction) => void) | null = null;

function now(): number {
  if (typeof performance !== "undefined") return performance.now();
  return Date.now();
}

/**
 * Bind the dispatch callback that the auto-fire helper calls into.
 * Called once at adapter install time. The helper's rAF loop kicks
 * off here and drives itself: it self-stops when `holds` drains and
 * self-starts again when `startArrowHold` adds a new entry.
 */
export function bindArrowAutoFire(
  emit: (source: string, direction: Direction) => void,
): void {
  boundEmit = emit;
  ensureLoop();
}

/**
 * Mark an arrow direction as held by `source`. Idempotent — calling
 * again with the same direction is a no-op; calling with a different
 * direction replaces the held entry (so a user switching from Left
 * to Right doesn't trigger a release first).
 *
 * The leading edge is the caller's own `keydown` / dispatch (which
 * already happens the moment the key/button is pressed); this helper
 * doesn't duplicate that. It only emits *follow-up* ticks past the
 * initial delay.
 *
 * Returns a teardown that clears the entry; the rAF loop auto-stops
 * when the map goes empty.
 */
export function startArrowHold(source: string, direction: Direction): () => void {
  const t = now();
  const existing = holds.get(source);
  if (existing && existing.direction === direction) {
    // Same direction already held — leave cadence alone. The OS
    // will keep auto-repeating; we ignore those (the
    // keyboard listener's `e.repeat` branch calls this just to
    // keep the entry alive across spurious remounts, not to start
    // a fresh cadence). Don't reset `leading` (we already
    // consumed it on the leading edge); don't reset `nextFireAt`.
    return () => {
      if (holds.get(source)?.direction === direction) holds.delete(source);
    };
  }
  // New direction (or first press in this source). Insert a fresh
  // entry; the loop will skip its leading edge because the keyboard
  // listener fired the user-facing `processDirection` synchronously
  // on the `!e.repeat` keydown, and the entry's `leading: true`
  // signals the loop to skip until nextFireAt.
  holds.set(source, { direction, startedAt: t, leading: true, nextFireAt: t + HOLD_INITIAL_DELAY_MS });
  ensureLoop();
  return () => {
    if (holds.get(source)?.direction === direction) holds.delete(source);
  };
}

/** Clear any active hold for `source`. No-op if none. */
export function stopArrowHold(source: string): void {
  holds.delete(source);
}

/** Currently-held direction for `source`, or `null`. Useful for tests. */
export function heldArrow(source: string): Direction | null {
  return holds.get(source)?.direction ?? null;
}

function tick(): void {
  if (holds.size === 0) {
    rafId = null;
    return;
  }
  const t = now();
  for (const [source, hold] of holds) {
    if (hold.leading) {
      hold.leading = false;
      continue;
    }
    if (t >= hold.nextFireAt) {
      boundEmit?.(source, hold.direction);
      hold.nextFireAt = t + HOLD_REPEAT_MS;
    }
  }
  rafId = requestAnimationFrame(tick);
}

function ensureLoop(): void {
  if (rafId !== null) return;
  if (typeof requestAnimationFrame === "undefined") return;
  if (!boundEmit) {
    // The adapter hasn't bound yet — wait. The adapter calls
    // `bindArrowAutoFire` at install time, and the loop starts the
    // first time it runs while holds are non-empty.
    return;
  }
  rafId = requestAnimationFrame(tick);
}

// Tuned values exposed for tests / future tuning.
export const _HOLD_INITIAL_DELAY_MS = HOLD_INITIAL_DELAY_MS;
export const _HOLD_REPEAT_MS = HOLD_REPEAT_MS;
