/**
 * Internal peek accessors used by `useGamepad` so it can route face
 * buttons (A / B) through modal-registered handlers without making the
 * LIFO stacks part of the controller's public API.
 *
 * Kept in its own module so the controller doesn't need to import
 * `useGamepad`, and vice-versa.
 */
type KeyHandler = (e: KeyboardEvent) => void;

let peekEnterFn: (() => KeyHandler | null) | null = null;
let peekEscapeFn: (() => KeyHandler | null) | null = null;

export const useSpatialControllerInternals = {
  registerPeeks(enter: () => KeyHandler | null, escape: () => KeyHandler | null) {
    peekEnterFn = enter;
    peekEscapeFn = escape;
  },
  peekEnter(): KeyHandler | null {
    return peekEnterFn?.() ?? null;
  },
  peekEscape(): KeyHandler | null {
    return peekEscapeFn?.() ?? null;
  },
};
