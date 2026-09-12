import { useEffect, useRef, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettings } from "./SettingsContext";
import type { Settings } from "./SettingsContext";

/** Color presets — a 9-hue rainbow (red → pink) + a Neutral that
 *  matches the previous Moonblast look (very dark gray in dark mode,
 *  white in light mode). Each tinted swatch sits at luminance ~0.21
 *  so every preset reads as the same calm brightness. `auto` tracks
 *  the Windows accent color (DWM colorization, including the OS's
 *  auto-picked variant on Win11 22H2+); `custom` falls back to
 *  settings.appearance.custom_accent. */
export const ACCENT_PRESETS: { id: string; label: string; color: string }[] = [
  { id: "auto", label: "Auto", color: "" },
  { id: "red", label: "Red", color: "#a86060" },
  { id: "orange", label: "Orange", color: "#a0744a" },
  { id: "yellow", label: "Yellow", color: "#8a7e3f" },
  { id: "green", label: "Green", color: "#5a8a55" },
  { id: "teal", label: "Teal", color: "#4a8a88" },
  { id: "blue", label: "Blue", color: "#5a7eb8" },
  { id: "indigo", label: "Indigo", color: "#6a75a8" },
  { id: "purple", label: "Purple", color: "#7a60a8" },
  { id: "pink", label: "Pink", color: "#a8608a" },
  { id: "neutral", label: "Neutral", color: "#0d1017" },
];

const VALID_ACCENT_IDS = new Set(ACCENT_PRESETS.map((p) => p.id));
const VALID_THEMES = new Set(["dark", "light", "auto"]);

/** Resolve the accent id + custom hex + cached Windows accent into
 *  one final CSS hex. The `auto` id reads from `osAccent` (set by
 *  the Rust watcher). */
const FALLBACK_ACCENT = "#0d1017"; // Neutral's dark-mode swatch

export function resolveAccent(
  accentId: string,
  custom: string | null,
  osAccent: string | null,
  mode: "light" | "dark",
): string {
  if (accentId === "custom") {
    return custom ?? FALLBACK_ACCENT;
  }
  if (accentId === "auto") {
    // Fall back to the default accent if the OS query has never
    // returned a value (rare — only during the very first paint).
    return osAccent ?? FALLBACK_ACCENT;
  }
  if (accentId === "neutral") {
    // Neutral resolves to a theme-dependent gray: very dark gray
    // in dark mode (matches the legacy Moonblast default), white
    // in light mode. The picker swatch shows the dark version.
    return mode === "light" ? "#ffffff" : "#0d1017";
  }
  if (VALID_ACCENT_IDS.has(accentId)) {
    return ACCENT_PRESETS.find((p) => p.id === accentId)!.color;
  }
  return FALLBACK_ACCENT;
}

/**
 * Reads `appearance` from settings, subscribes to the Rust
 * `windows-theme-changed` / `windows-accent-changed` events, and
 * applies the resolved theme + color to <html> as data-theme + an
 * inline `--color-accent` custom property.
 *
 * Must be inside <SettingsProvider> (uses `useSettings`). Mount once
 * near the root (App.tsx).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { settings, ready } = useSettings();
  const windowsModeRef = useRef<"light" | "dark">("dark");
  const windowsAccentRef = useRef<string | null>(null);
  // Mirror `settings` into a ref so the once-registered event
  // listener can read the latest value without going stale.
  const settingsRef = useRef<Settings>(settings);
  settingsRef.current = settings;

  // Subscribe to OS theme + accent changes for the "Auto" options.
  useEffect(() => {
    let unlistenTheme: (() => void) | null = null;
    let unlistenAccent: (() => void) | null = null;
    listen<string>("windows-theme-changed", (e) => {
      windowsModeRef.current = e.payload === "light" ? "light" : "dark";
      apply(settingsRef.current, windowsModeRef.current, windowsAccentRef.current);
    }).then((u) => {
      unlistenTheme = u;
    });
    listen<string>("windows-accent-changed", (e) => {
      windowsAccentRef.current = e.payload;
      apply(settingsRef.current, windowsModeRef.current, windowsAccentRef.current);
    }).then((u) => {
      unlistenAccent = u;
    });
    return () => {
      unlistenTheme?.();
      unlistenAccent?.();
    };
  }, []);

  // Apply on every settings change once hydration is done. The
  // apply() call is idempotent — cheap to re-run.
  useEffect(() => {
    if (!ready) return;
    apply(settings, windowsModeRef.current, windowsAccentRef.current);
    // Re-prompt Rust to (re)emit the current OS values so a late
    // subscriber gets them before the watcher thread's first poll.
    Promise.all([
      invoke<string>("windows_app_mode").catch(() => null),
      invoke<string | null>("windows_accent_color").catch(() => null),
    ]).then(([mode, accent]) => {
      if (mode) windowsModeRef.current = mode === "light" ? "light" : "dark";
      if (accent) windowsAccentRef.current = accent;
      apply(settings, windowsModeRef.current, windowsAccentRef.current);
    });
  }, [ready, settings.appearance.theme, settings.appearance.accent, settings.appearance.custom_accent]);

  return <>{children}</>;
}

function apply(s: Settings, osMode: "light" | "dark", osAccent: string | null) {
  const root = document.documentElement;
  // Theme: explicit "light"/"dark" → that; "auto" → mirror the
  // current OS reading.
  const theme = s.appearance.theme;
  let resolved: "light" | "dark";
  if (theme === "light" || theme === "dark") {
    resolved = theme;
  } else if (VALID_THEMES.has(theme)) {
    // "auto" — use the cached OS reading. Default to "dark" if
    // the watcher hasn't emitted yet.
    resolved = osMode;
  } else {
    resolved = "dark";
  }
  if (root.getAttribute("data-theme") !== resolved) {
    root.setAttribute("data-theme", resolved);
  }
  // Persist the user's *intent* (`theme` value) so the inline
  // bootstrap script in index.html can pre-set data-theme on the
  // next page load and avoid a dark-flash-then-light transition.
  try {
    localStorage.setItem("moonblast.theme", theme);
  } catch {
    /* ignore */
  }

  // Color: resolve preset id (+ optional custom hex + cached Windows
  // accent) and re-derive every surface token from it. The accent
  // is the whole app's background; surfaces sit one or two steps
  // darker (dark theme) or lighter (light theme) for layering.
  const accent = resolveAccent(
    s.appearance.accent,
    s.appearance.custom_accent,
    osAccent,
    resolved,
  );
  const palette = derivePalette(accent, resolved, s.appearance.accent);
  for (const [k, v] of Object.entries(palette)) {
    root.style.setProperty(k, v);
  }
}

/** Derive every surface token from the resolved accent + dark/light
 *  mode. The accent swatch in the picker shows the color at its
 *  "true" muted shade (e.g. Default `#6f78c8`). The actual app bg
 *  is derived FROM that swatch:
 *    - dark theme: darken significantly AND desaturate toward gray
 *      so the bg reads as a calm, dark themed room rather than a
 *      saturated wall of color. Muter → less hue dominance.
 *    - light theme: wash toward white (~80%) → pale, soft tint
 *  This keeps the bg calm and prevents the chosen color from
 *  overpowering text, while the swatch stays as the consistent
 *  brightness reference.
 *
 *  Surfaces layer on top of the bg:
 *    - dark: surface lighter than bg (cards pop), surface-2 lighter still
 *    - light: surface slightly darker than bg (subtle depth), surface-2 darker still
 *
 *  Text auto-flips based on bg luminance so contrast stays readable
 *  on every preset. */
function derivePalette(
  accent: string,
  mode: "light" | "dark",
  accentId: string,
): Record<string, string> {
  const swatch = hexToRgb(accent) ?? { r: 111, g: 120, b: 200 };
  const dark = mode === "dark";
  const isNeutral = accentId === "neutral";

  // Bg: tinted presets get a derived bg (dark: rich deep room;
  // light: pale wash). Neutral passes through unchanged so the
  // app stays untinted — matching the legacy Moonblast default.
  // Dark mode also desaturates toward mid-gray so the hue doesn't
  // shout — keeps the room moody.
  const bg = isNeutral
    ? swatch
    : dark
      ? desaturate(darken(swatch, 0.7), 0.55)
      : mix(swatch, { r: 255, g: 255, b: 255 }, 0.82);

  // Surfaces step on top of the bg. Tinted presets stay close to
  // the bg (flatter, more uniform) — cards read as "part of the
  // room" rather than elevated panels. The biggest contrast
  // between layers was over-emphasizing elevation.
  const surface = isNeutral
    ? (dark ? { r: 0x16, g: 0x19, b: 0x23 } : { r: 0xf5, g: 0xf6, b: 0xf8 })
    : dark
      ? lighten(bg, 0.06)
      : darken(bg, 0.02);
  const surface2 = isNeutral
    ? (dark ? { r: 0x1d, g: 0x22, b: 0x30 } : { r: 0xee, g: 0xf0, b: 0xf3 })
    : dark
      ? lighten(bg, 0.12)
      : darken(bg, 0.05);

  // Auto-pick text for contrast. On most light-themed presets the
  // bg is pale enough to need dark text; on every dark-themed
  // preset we use light text.
  const lum = relativeLuminance(bg);
  const textIsLight = lum < 0.55;
  // Neutral uses the original Moonblast text colors so the legacy
  // look is fully preserved; tinted presets use a slightly warmer
  // white / cooler near-black that pairs with the bg hue.
  const text = isNeutral
    ? (dark ? { r: 0xd9, g: 0xdd, b: 0xe8 } : { r: 0x1a, g: 0x1d, b: 0x23 })
    : textIsLight
      ? { r: 248, g: 249, b: 253 }
      : { r: 28, g: 30, b: 38 };
  const muted = isNeutral
    ? (dark ? { r: 0x90, g: 0x99, b: 0xac } : { r: 0x6c, g: 0x72, b: 0x80 })
    : textIsLight
      ? { r: 175, g: 178, b: 190 }
      : { r: 155, g: 158, b: 172 };

  // Border: very subtle contrast vs surface. Cards are flat;
  // borders are just a quiet outline, not a strong frame.
  const border = isNeutral
    ? (dark ? { r: 0x26, g: 0x2c, b: 0x3a } : { r: 0xd8, g: 0xdb, b: 0xe2 })
    : mix(surface, text, 0.08);

  // Overlay: scrim used behind modals. Heavier on light bg.
  const overlay = textIsLight
    ? "rgb(0 0 0 / 0.6)"
    : "rgb(0 0 0 / 0.7)";
  const overlaySoft = textIsLight
    ? "rgb(0 0 0 / 0.15)"
    : "rgb(0 0 0 / 0.2)";

  // Accent: tinted presets use the swatch (dark) or its darkened
  // version (light) so primary buttons pop against the derived bg.
  // Neutral falls back to the legacy --color-accent token.
  const accentColor = isNeutral
    ? (dark ? "#6f78c8" : "#4a60dc")
    : dark
      ? toCss(swatch)
      : toCss(darken(swatch, 0.18));

  return {
    "--color-bg": toCss(bg),
    "--color-surface": toCss(surface),
    "--color-surface-2": toCss(surface2),
    "--color-border": toCss(border),
    "--color-muted": toCss(muted),
    "--color-text": toCss(text),
    "--color-accent": accentColor,
    "--color-accent-soft": `rgb(${swatch.r} ${swatch.g} ${swatch.b} / 0.22)`,
    "--color-surface-ghost": dark
      ? `rgb(${bg.r} ${bg.g} ${bg.b} / 0.6)`
      : `rgb(${bg.r} ${bg.g} ${bg.b} / 0.85)`,
    "--color-overlay": overlay,
    "--color-overlay-soft": overlaySoft,
    "--color-muted-soft": `rgb(${muted.r} ${muted.g} ${muted.b} / 0.5)`,
  };
}

type RGB = { r: number; g: number; b: number };

function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

function clamp(v: number) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function toCss(c: RGB) {
  return `rgb(${clamp(c.r)} ${clamp(c.g)} ${clamp(c.b)})`;
}

/** Multiply-toward-black for dark themes. `amt` 0..1. */
function darken(c: RGB, amt: number): RGB {
  return {
    r: c.r * (1 - amt),
    g: c.g * (1 - amt),
    b: c.b * (1 - amt),
  };
}

/** Pull the color toward its mid-gray equivalent. `amt` 0 = no
 *  change, 1 = pure gray. Used in dark mode so the chosen hue
 *  tints the bg without dominating it. */
function desaturate(c: RGB, amt: number): RGB {
  const gray = (c.r + c.g + c.b) / 3;
  return mix(c, { r: gray, g: gray, b: gray }, amt);
}

/** Multiply-toward-white for light themes. `amt` 0..1. */
function lighten(c: RGB, amt: number): RGB {
  return {
    r: c.r + (255 - c.r) * amt,
    g: c.g + (255 - c.g) * amt,
    b: c.b + (255 - c.b) * amt,
  };
}

/** Linear-mix two colors in sRGB. `t` 0 = a, 1 = b. */
function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

/** Relative luminance per WCAG (sRGB → linear, then weighted). */
function relativeLuminance(c: RGB): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}


