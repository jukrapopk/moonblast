import { useEffect, useRef, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettings } from "./SettingsContext";
import type { Settings } from "./SettingsContext";

/** Color presets — a 9-hue rainbow (red → pink) + Neutral (legacy
 *  Moonblast dark palette) + Gray (pure desaturated, no chroma at
 *  all). Tinted swatches sit at luminance ~0.21 so every preset
 *  reads as the same calm brightness. Neutral / Gray have separate
 *  `pickerSwatch` colors (cosmetic — visible in the chip row) and
 *  `appliedBg` colors (what the app actually uses as bg). Tinted
 *  presets share both — the swatch IS the applied color. `auto`
 *  tracks the Windows accent color (DWM colorization, including
 *  the OS's auto-picked variant on Win11 22H2+); `custom` falls
 *  back to settings.appearance.custom_accent. */
type AccentPreset = {
  id: string;
  label: string;
  /** Color shown as the swatch chip in the picker row. Lifted
   *  slightly for Neutral in dark mode so the chip doesn't blend
   *  into the picker background. */
  pickerSwatch: { dark: string; light: string };
  /** Color used as the actual app background. Different from
   *  pickerSwatch only for Neutral. */
  appliedBg: { dark: string; light: string };
};

export const ACCENT_PRESETS: AccentPreset[] = [
  // Auto: chip shows the live Windows accent; applied bg falls
  // back to the OS reading (handled in resolveAccent).
  {
    id: "auto",
    label: "Auto",
    pickerSwatch: { dark: "#6f78c8", light: "#6f78c8" },
    appliedBg: { dark: "#6f78c8", light: "#6f78c8" },
  },
  // Tinted presets: swatch = applied color (both modes).
  { id: "red", label: "Red", pickerSwatch: { dark: "#a86060", light: "#a86060" }, appliedBg: { dark: "#a86060", light: "#a86060" } },
  { id: "orange", label: "Orange", pickerSwatch: { dark: "#a0744a", light: "#a0744a" }, appliedBg: { dark: "#a0744a", light: "#a0744a" } },
  { id: "yellow", label: "Yellow", pickerSwatch: { dark: "#8a7e3f", light: "#8a7e3f" }, appliedBg: { dark: "#8a7e3f", light: "#8a7e3f" } },
  { id: "green", label: "Green", pickerSwatch: { dark: "#5a8a55", light: "#5a8a55" }, appliedBg: { dark: "#5a8a55", light: "#5a8a55" } },
  { id: "teal", label: "Teal", pickerSwatch: { dark: "#4a8a88", light: "#4a8a88" }, appliedBg: { dark: "#4a8a88", light: "#4a8a88" } },
  { id: "blue", label: "Blue", pickerSwatch: { dark: "#5a7eb8", light: "#5a7eb8" }, appliedBg: { dark: "#5a7eb8", light: "#5a7eb8" } },
  { id: "indigo", label: "Indigo", pickerSwatch: { dark: "#6a75a8", light: "#6a75a8" }, appliedBg: { dark: "#6a75a8", light: "#6a75a8" } },
  { id: "purple", label: "Purple", pickerSwatch: { dark: "#7a60a8", light: "#7a60a8" }, appliedBg: { dark: "#7a60a8", light: "#7a60a8" } },
  { id: "pink", label: "Pink", pickerSwatch: { dark: "#a8608a", light: "#a8608a" }, appliedBg: { dark: "#a8608a", light: "#a8608a" } },
  // Neutral: legacy Moonblast palette. Picker swatch is lifted
  // (`#262c3a`) so the chip reads as a distinct object in the
  // picker row rather than blending into the picker bg. Applied
  // dark bg is the legacy `#0d1017` (cool near-black). Applied
  // light bg is a very pale blue tint (`#f0f3f8`) so it pairs
  // visually with the subtle blue cast of the dark palette —
  // avoids the clinical pure-white look.
  //
  // Swatch is decorative — distinct from the applied bg so the
  // chip reads clearly in the picker row. Dark swatch is lifted
  // (`#2a3140`) so it stands out against the dark picker surface;
  // light swatch is a light blue (`#cfd9ec`) hinting at the
  // pale-blue room.
  {
    id: "neutral",
    label: "Neutral",
    pickerSwatch: { dark: "#2a3140", light: "#cfd9ec" },
    appliedBg: { dark: "#0d1017", light: "#f0f3f8" },
  },
  // Gray: pure desaturated, no chroma. Dark applied bg is a
  // near-black gray; light applied bg is an off-white gray.
  // Light swatch is a true mid-gray (`#888c92`) so the chip
  // reads as clearly gray (not as a white chip in the row).
  {
    id: "gray",
    label: "Gray",
    pickerSwatch: { dark: "#1c1c1c", light: "#888c92" },
    appliedBg: { dark: "#1c1c1c", light: "#f0f0f0" },
  },
];

const VALID_THEMES = new Set(["dark", "light", "auto"]);

/** Color shown as the chip in the picker row. */
export function presetSwatch(p: AccentPreset, mode: "light" | "dark"): string {
  return mode === "light" ? p.pickerSwatch.light : p.pickerSwatch.dark;
}

/** Color used as the actual app background. */
function presetApplied(p: AccentPreset, mode: "light" | "dark"): string {
  return mode === "light" ? p.appliedBg.light : p.appliedBg.dark;
}

/** Resolve the accent id + custom hex + cached Windows accent into
 *  one final CSS hex. The `auto` id reads from `osAccent` (set by
 *  the Rust watcher). */
const FALLBACK_ACCENT = "#0d1017"; // Neutral's dark-mode swatch

function resolveAccent(
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
  const preset = ACCENT_PRESETS.find((p) => p.id === accentId);
  if (preset) {
    // Return the ACTUAL bg color that will be applied — for most
    // presets this equals the picker swatch, but for Neutral the
    // swatch is lifted so it reads in the picker while the
    // applied bg stays at the legacy `#0d1017`.
    return presetApplied(preset, mode);
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
  // Untinted presets (Neutral / Gray) skip the hue derivation:
  // bg passes through directly, surfaces / text / border come
  // from a hand-picked neutral scale.
  const isUntinted = accentId === "neutral" || accentId === "gray";
  const isNeutral = accentId === "neutral";
  const isGray = accentId === "gray";

  // Bg: tinted presets derive from the swatch (dark: rich deep
  // room; light: pale wash). Untinted presets pass through.
  // Dark mode darkens more aggressively + desaturates so every
  // preset sits in the same low-luminance band — neutral reads
  // at ~0.005, tinted at ~0.008-0.012. The whole palette drops
  // together for a moody, harmonized room.
  const bg = isUntinted
    ? swatch
    : dark
      ? desaturate(darken(swatch, 0.82), 0.55)
      : mix(swatch, { r: 255, g: 255, b: 255 }, 0.82);

  // Surfaces step on top of the bg.
  //  - Neutral: legacy Moonblast palette (slight cool tint)
  //  - Gray: pure desaturated steps (no chroma)
  //  - Tinted: derived from the bg's brightness. Dark mode
  //    uses flatter steps (6% / 10%) so cards sit close to the
  //    floor — the room reads as one surface, not stacked layers.
  const surface = isNeutral
    ? (dark ? { r: 0x16, g: 0x19, b: 0x23 } : { r: 0xe8, g: 0xec, b: 0xf2 })
    : isGray
      ? (dark ? { r: 0x25, g: 0x25, b: 0x25 } : { r: 0xdd, g: 0xdd, b: 0xdd })
      : dark
        ? lighten(bg, 0.06)
        : darken(bg, 0.05);
  const surface2 = isNeutral
    ? (dark ? { r: 0x1d, g: 0x22, b: 0x30 } : { r: 0xdb, g: 0xe1, b: 0xea })
    : isGray
      ? (dark ? { r: 0x2e, g: 0x2e, b: 0x2e } : { r: 0xca, g: 0xca, b: 0xca })
      : dark
        ? lighten(bg, 0.1)
        : darken(bg, 0.1);

  // Text / muted are darkened neutral grays so the UI keeps one
  // consistent text vocabulary regardless of which color preset
  // the user picked. Dark text is dimmed (`#c8ccd6`, lum 0.60)
  // so it doesn't shout against the dark bg — calmer room,
  // easier reading at Big-Picture scale.
  //
  // Light text is lightened from the original near-black
  // (`#1a1d23`, lum 0.012) to `#3a4252` (lum ~0.045) — less
  // stark on the pale bg, easier reading. Light muted is
  // darkened from `#6c7280` (lum 0.168) to `#52596b` (lum 0.10)
  // for stronger separation against the bg (~7× contrast).
  //
  // Both pick up a 25% mix of the chosen hue so tinted presets
  // carry a hint of color through the typography — a Blue preset
  // reads with slightly cooler text, a Red preset slightly warmer.
  // Neutral / Gray pass through unchanged.
  const baseTextLight = { r: 0x3a, g: 0x42, b: 0x52 };
  const baseMutedLight = { r: 0x52, g: 0x59, b: 0x6b };
  const baseTextDark = { r: 0xc8, g: 0xcc, b: 0xd6 };
  const baseMutedDark = { r: 0x7a, g: 0x82, b: 0x94 };
  const tintAmount = 0.25;
  const baseText = dark ? baseTextDark : baseTextLight;
  const baseMuted = dark ? baseMutedDark : baseMutedLight;
  const text = isUntinted
    ? baseText
    : mix(baseText, swatch, tintAmount);
  const muted = isUntinted
    ? baseMuted
    : mix(baseMuted, swatch, tintAmount * 0.6);
  const border = isNeutral
    ? (dark ? { r: 0x26, g: 0x2c, b: 0x3a } : { r: 0xb8, g: 0xc0, b: 0xce })
    : isGray
      ? (dark ? { r: 0x38, g: 0x38, b: 0x38 } : { r: 0xb0, g: 0xb0, b: 0xb0 })
      : dark
        ? lighten(surface2, 0.06)
        : darken(surface2, 0.1);

  // Overlay: scrim used behind modals. Heavier on light bg.
  const bgIsLight = relativeLuminance(bg) >= 0.55;
  const overlay = bgIsLight
    ? "rgb(0 0 0 / 0.6)"
    : "rgb(0 0 0 / 0.7)";
  const overlaySoft = bgIsLight
    ? "rgb(0 0 0 / 0.15)"
    : "rgb(0 0 0 / 0.2)";

  // Accent: tinted presets use the swatch (dark) or its darkened
  // version (light) so primary buttons pop against the derived bg.
  // Neutral keeps the legacy purple accent (it's the default and
  // users expect color there). Gray uses a true gray accent —
  // mid-gray for dark bg (lifts above the floor), darker gray
  // for light bg (sinks into a visible button).
  const accentRgb = isNeutral
    ? hexToRgb(dark ? "#6f78c8" : "#4a60dc")!
    : isGray
      ? hexToRgb(dark ? "#9aa0a8" : "#5a606b")!
      : dark
        ? swatch
        : darken(swatch, 0.18);
  const accentColor = toCss(accentRgb);

  return {
    "--color-bg": toCss(bg),
    "--color-surface": toCss(surface),
    "--color-surface-2": toCss(surface2),
    "--color-border": toCss(border),
    "--color-muted": toCss(muted),
    "--color-text": toCss(text),
    "--color-accent": accentColor,
    "--color-accent-soft": `rgb(${accentRgb.r} ${accentRgb.g} ${accentRgb.b} / 0.22)`,
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


