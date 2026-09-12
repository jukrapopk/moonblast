/**
 * Format a duration in seconds as a short or long human-readable string.
 *
 * - `style: "long"` → "1 h 42 min" / "12 min" (used in BatteryModal)
 * - `style: "short"` → "1h 42m" / "12m" (used in the TopBar chip tooltip)
 *
 * `null` / `0` both map to a placeholder ("calculating…") — the chip needs
 * the "we don't know yet" string inline, while the modal hides the row
 * entirely when the value isn't usable and only calls this with a real
 * estimate.
 */
export function formatDuration(
  sec: number | null,
  style: "short" | "long" = "long",
): string {
  if (sec === null || sec === 0) return "calculating…";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (style === "short") {
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
  }
  if (h > 0 && m > 0) return `${h} h ${m} min`;
  if (h > 0) return `${h} h`;
  return `${m} min`;
}