import { SpeakerHigh, SpeakerLow, SpeakerNone, SpeakerX } from "@phosphor-icons/react";

interface SpeakerIconProps {
  /** 0–100. Overlay tier: >=67 High, >=33 Low, >0 None. */
  volume?: number;
  muted?: boolean;
  size?: number;
}

/**
 * Single volume glyph used by every volume indicator (TopBar chip, master
 * + per-app mute buttons). Normal state is two stacked icons: a dimmed
 * SpeakerHigh base with a full-brightness overlay directly on top —
 * SpeakerHigh at 67–100, SpeakerLow at 33–66, SpeakerNone at 1–32.
 * Muted or zero volume renders a lone SpeakerX with no base.
 */
export function SpeakerIcon({ volume = 100, muted = false, size = 24 }: SpeakerIconProps) {
  if (muted || volume <= 0) {
    return <SpeakerX size={size} weight="bold" />;
  }
  const Overlay = volume >= 67 ? SpeakerHigh : volume >= 33 ? SpeakerLow : SpeakerNone;
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <SpeakerHigh size={size} weight="bold" className="absolute inset-0 opacity-40" />
      <Overlay size={size} weight="bold" className="absolute inset-0" />
    </span>
  );
}
