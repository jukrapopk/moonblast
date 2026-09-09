/** Brand gradient for placeholder icons (used by AppTile and host IconTile). */
export const BRAND_GRADIENT = "linear-gradient(135deg,#31416b,#2b3a5e)";

const PALETTE = [
  "linear-gradient(135deg,#31416b,#2b3a5e)",
  "linear-gradient(135deg,#3a3f57,#394b45)",
  "linear-gradient(135deg,#454a75,#3b3f63)",
  "linear-gradient(135deg,#563b45,#4a3a3a)",
  "linear-gradient(135deg,#333c4a,#2f4a42)",
  "linear-gradient(135deg,#3b3b52,#333c4a)",
  "linear-gradient(135deg,#4a4460,#3f3a52)",
  "linear-gradient(135deg,#3a3f66,#323c44)",
];

/**
 * Stable, deterministic gradient per seed string — same input always returns
 * the same gradient, so an app icon doesn't flicker between colors.
 */
export function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
