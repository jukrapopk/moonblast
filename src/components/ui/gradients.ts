/** Theme-aware gradients for placeholder icons (app tiles with no image,
 *  host cards). Each entry is a CSS gradient that references the
 *  current theme tokens so the tile blends into the room rather
 *  than showing a hard blue rectangle. The `gradientFor` helper
 *  picks deterministically per seed string so the same app
 *  always gets the same gradient. */
const PALETTE = [
  "linear-gradient(135deg, var(--color-bg), var(--color-surface-2))",
  "linear-gradient(135deg, var(--color-surface-2), var(--color-bg))",
  "linear-gradient(135deg, var(--color-bg), var(--color-accent-soft))",
  "linear-gradient(135deg, var(--color-surface), var(--color-surface-2))",
  "linear-gradient(135deg, var(--color-bg), var(--color-surface))",
  "linear-gradient(135deg, var(--color-surface-2), var(--color-surface))",
  "linear-gradient(135deg, var(--color-bg), var(--color-border))",
  "linear-gradient(135deg, var(--color-accent-soft), var(--color-surface))",
];

/**
 * Stable, deterministic gradient per seed string — same input always
 * returns the same gradient, so an app icon doesn't flicker between
 * styles. Each gradient is theme-aware (uses CSS vars) so the tile
 * blends into the chosen room.
 */
export function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
