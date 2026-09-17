/**
 * Internal peek accessors. Reserved for any future caller that
 * wants to read the LIFO escape / enter stacks without making them
 * part of the controller's public API.
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
