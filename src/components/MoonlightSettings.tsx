import { PencilSimple } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { useSettings } from "../settings/SettingsContext";
import { useFocusRefresh } from "../hooks/useFocusRefresh";
import type { HdrStatus } from "./SettingsView";
import { Prompt } from "./ui/Prompt";
import { Row } from "./ui/Row";
import { Section } from "./ui/Section";
import { Segmented } from "./ui/Segmented";
import { Select, type SelectOptionInput } from "./ui/Select";
import { Slider } from "./ui/Slider";
import { Toggle } from "./ui/Toggle";

const RATIOS = ["16:9", "16:10", "21:9", "32:9", "4:3", "5:4"];

const RES_BY_RATIO: Record<string, string[]> = {
  "16:9": ["640x360", "1280x720", "1920x1080", "2560x1440", "3840x2160", "7680x4320"],
  "16:10": ["1280x800", "1920x1200", "2560x1600", "3840x2400"],
  "21:9": ["2560x1080", "3440x1440", "3840x1600", "5120x2160"],
  "32:9": ["3840x1080", "5120x1440", "7680x2160"],
  "4:3": ["1024x768", "1280x960", "1600x1200", "2048x1536"],
  "5:4": ["1280x1024", "2560x2048"],
};

const FPS_COMMON = ["30", "60", "120"];

const norm = (s: string) => s.replace(/\s+/g, "").replace(/×/g, "x").toLowerCase();
const normRes = (s: string) =>
  /^\d+x\d+$/.test(s.replace(/×/g, "x").toLowerCase()) ? s.replace(/×/g, "x").toLowerCase() : null;
const fpsOf = (s: string) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
};

function PencilButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-muted) transition hover:text-(--color-text)"
    >
      <PencilSimple size={15} weight="bold" />
    </button>
  );
}

interface ClientDisplay {
  width: number;
  height: number;
  refresh_rate: number | null;
}

export function MoonlightSettings() {
  const { settings, update } = useSettings();
  const m = settings.moonlight;

  // Per-field setter — the same `{ ...s, moonlight: { ...s.moonlight, [k]: v } }`
  // dance that `useSettingsField` does, kept here as a single local helper
  // so call sites stay short (`set("aspect_ratio", v)`).
  function set<K extends keyof typeof m>(key: K, value: (typeof m)[K]) {
    update((s) => ({ ...s, moonlight: { ...s.moonlight, [key]: value } }));
  }

  const [detected, setDetected] = useState<ClientDisplay | null>(null);
  useEffect(() => {
    invoke<ClientDisplay>("client_display").then(setDetected).catch(() => { });
  }, []);

  // Live read of the OS-level display HDR state. Used to mirror the
  // global HDR state onto the disabled HDR toggle when
  // `hdr_follow_global` is on. Three refresh paths:
  //   - mount: initial fetch
  //   - `hdr-changed` event: pushed by Rust after every successful
  //     `set_hdr` IPC, so toggling HDR in the Display modal updates
  //     this view immediately without a remount
  //   - window `focus` / `visibilitychange → visible`: catches the case
  //     where HDR was flipped outside Moonblast (Windows Settings app,
  //     OEM hotkey, OS policy) and the user alt-tabs back
  //
  // The actual stream is always correct regardless of this read —
  // `moonlight_flags()` re-resolves `hdr_status().enabled` at spawn
  // time. This hook only keeps the visual indicator honest.
  const [globalHdr, setGlobalHdr] = useState<HdrStatus | null>(null);
  const refreshGlobalHdr = useCallback(async () => {
    try {
      setGlobalHdr(await invoke<HdrStatus>("hdr_status"));
    } catch {
      // Leave the previous value alone — same shape as useAudioMaster.
    }
  }, []);
  useEffect(() => {
    let alive = true;
    const unlisten = listen<HdrStatus>("hdr-changed", () => {
      if (alive) void refreshGlobalHdr();
    });
    return () => {
      alive = false;
      void unlisten.then((f) => f());
    };
  }, [refreshGlobalHdr]);

  useFocusRefresh(refreshGlobalHdr, [refreshGlobalHdr]);

  // Custom-input modals.
  const [resOpen, setResOpen] = useState(false);
  const [fpsOpen, setFpsOpen] = useState(false);
  const [bitrateOpen, setBitrateOpen] = useState(false);

  // ---- Resolution ----
  const detectedRes = detected ? `${detected.width}x${detected.height}` : null;
  const storedRes = norm(m.resolution);
  const resAuto = storedRes === "" || storedRes === "auto";
  const effectiveRes = resAuto ? (detectedRes ?? storedRes) : storedRes;

  const commonRes = RES_BY_RATIO[m.aspect_ratio] ?? RES_BY_RATIO["16:9"];
  const resOptions: SelectOptionInput[] = [];
  if (detectedRes) resOptions.push({ label: `Detected · ${detectedRes}`, value: detectedRes });
  for (const r of commonRes) {
    if (!resOptions.some((o) => (typeof o === "string" ? o : o.value) === r)) resOptions.push(r);
  }
  if (!resAuto && !commonRes.includes(effectiveRes)) {
    resOptions.push({ label: `Custom · ${effectiveRes}`, value: effectiveRes });
  }

  // ---- Refresh rate ----
  const storedFps = fpsOf(m.refresh_rate);
  const fpsAuto = norm(m.refresh_rate) === "" || norm(m.refresh_rate) === "auto";
  const detectedFps = detected?.refresh_rate ?? null;
  const effectiveFps = fpsAuto ? detectedFps : storedFps;

  const fpsOptions = [
    { id: "detected", label: detectedFps ? `Detected · ${detectedFps}` : "Detected" },
    { id: "30", label: "30" },
    { id: "60", label: "60" },
    { id: "120", label: "120" },
    { id: "custom", label: "Custom" },
  ];
  const fpsVal = fpsAuto
    ? "detected"
    : storedFps !== null && FPS_COMMON.includes(String(storedFps))
      ? String(storedFps)
      : "custom";

  function onFpsChange(id: string) {
    if (id === "detected") set("refresh_rate", "auto");
    else if (id === "custom") setFpsOpen(true);
    else set("refresh_rate", id);
  }

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="space-y-6"
      >
        <Section title="Video">
          <Row label="Aspect ratio">
            <Select options={RATIOS} value={m.aspect_ratio} onChange={(v) => set("aspect_ratio", v)} />
          </Row>
          <Row
            label="Resolution"
            description={effectiveRes ? (resAuto ? `${effectiveRes} · native` : effectiveRes) : "Detecting display…"}
          >
            <div className="flex shrink-0 items-center gap-2">
              <Select
                options={resOptions}
                value={effectiveRes}
                onChange={(v) => set("resolution", v === detectedRes ? "auto" : v)}
              />
              <PencilButton onClick={() => setResOpen(true)} label="Custom resolution" />
            </div>
          </Row>
          <Row
            label="Refresh rate"
            description={effectiveFps ? `${effectiveFps} Hz` : "Detecting display…"}
          >
            <div className="flex shrink-0 items-center gap-2">
              <Segmented variant="value" value={fpsVal} onChange={onFpsChange} options={fpsOptions} />
              <PencilButton onClick={() => setFpsOpen(true)} label="Custom refresh rate" />
            </div>
          </Row>
          <Row label="Bitrate" description={`${m.bitrate} Mbps`}>
            <div className="flex shrink-0 items-center gap-3">
              <Slider
                label="Bitrate"
                value={Math.min(100, Math.max(1, m.bitrate))}
                onChange={(v) => set("bitrate", v)}
                min={1}
                max={100}
                step={1}
                className="w-44"
              />
              <span className="w-9 text-right text-sm tabular-nums text-(--color-muted)">{m.bitrate}</span>
              <PencilButton onClick={() => setBitrateOpen(true)} label="Custom bitrate" />
            </div>
          </Row>
          <Row label="Video codec">
            <Select
              options={["Auto", "H.264", "HEVC", "AV1"]}
              value={m.codec}
              onChange={(v) => set("codec", v)}
            />
          </Row>
          <Row label="Video decoder">
            <Segmented
              variant="value"
              options={[
                { id: "auto", label: "Auto" },
                { id: "hardware", label: "Hardware" },
                { id: "software", label: "Software" },
              ]}
              value={m.video_decoder}
              onChange={(v) => set("video_decoder", v)}
            />
          </Row>
          <Row label="Display mode">
            <Segmented
              variant="value"
              options={[
                { id: "fullscreen", label: "Fullscreen" },
                { id: "windowed", label: "Windowed" },
                { id: "borderless", label: "Borderless" },
              ]}
              value={m.display_mode}
              onChange={(v) => set("display_mode", v)}
            />
          </Row>
          <Row label="V-Sync">
            <Toggle checked={m.vsync} onChange={(v) => set("vsync", v)} />
          </Row>
          <Row
            label="Follow global HDR"
            description={m.hdr_follow_global ? "Stream HDR when your display does" : "Set HDR per stream below"}
          >
            <Toggle
              checked={m.hdr_follow_global}
              onChange={(v) => set("hdr_follow_global", v)}
            />
          </Row>
          <Row
            label="HDR"
            description={
              m.hdr_follow_global
                ? globalHdr === null
                  ? "Reading display HDR state…"
                  : globalHdr.supported
                    ? `Following display — currently ${globalHdr.enabled ? "on" : "off"}`
                    : "This display doesn't support HDR"
                : "Stream in HDR"
            }
          >
            <Toggle
              checked={m.hdr}
              onChange={(v) => set("hdr", v)}
              disabled={m.hdr_follow_global}
              // When following, the toggle is read-only but should still
              // mirror the OS-level HDR state so the user can see what
              // the stream will do.
              displayValue={m.hdr_follow_global ? globalHdr?.enabled : undefined}
            />
          </Row>
          <Row label="YUV 4:4:4">
            <Toggle checked={m.yuv444} onChange={(v) => set("yuv444", v)} />
          </Row>
          <Row label="Frame pacing">
            <Toggle checked={m.frame_pacing} onChange={(v) => set("frame_pacing", v)} />
          </Row>
          <Row label="FPS overlay">
            <Toggle checked={m.fps_overlay} onChange={(v) => set("fps_overlay", v)} />
          </Row>
          <Row label="Packet size">
            <Select
              options={["Default", "1024", "1200", "1400", "1500"]}
              value={m.packet_size == null ? "Default" : String(m.packet_size)}
              onChange={(v) => set("packet_size", v === "Default" ? null : Number(v))}
            />
          </Row>
        </Section>

        <Section title="Audio">
          <Row label="Audio config">
            <Select
              options={["stereo", "5.1-surround", "7.1-surround"]}
              value={m.audio_config}
              onChange={(v) => set("audio_config", v)}
            />
          </Row>
          <Row label="Audio on host" description="Play through the host speakers too">
            <Toggle checked={m.audio_on_host} onChange={(v) => set("audio_on_host", v)} />
          </Row>
          <Row label="Mute on focus loss">
            <Toggle checked={m.mute_on_focus_loss} onChange={(v) => set("mute_on_focus_loss", v)} />
          </Row>
        </Section>

        <Section title="Input">
          <Row label="Multiple controllers">
            <Toggle checked={m.multi_controller} onChange={(v) => set("multi_controller", v)} />
          </Row>
          <Row label="Background gamepad">
            <Toggle checked={m.background_gamepad} onChange={(v) => set("background_gamepad", v)} />
          </Row>
          <Row label="Swap gamepad buttons">
            <Toggle checked={m.swap_gamepad_buttons} onChange={(v) => set("swap_gamepad_buttons", v)} />
          </Row>
          <Row label="Absolute mouse">
            <Toggle checked={m.absolute_mouse} onChange={(v) => set("absolute_mouse", v)} />
          </Row>
          <Row label="Swap mouse buttons">
            <Toggle checked={m.mouse_buttons_swap} onChange={(v) => set("mouse_buttons_swap", v)} />
          </Row>
          <Row label="Reverse scroll direction">
            <Toggle
              checked={m.reverse_scroll_direction}
              onChange={(v) => set("reverse_scroll_direction", v)}
            />
          </Row>
          <Row label="Capture system keys">
            <Segmented
              variant="value"
              options={[
                { id: "never", label: "Never" },
                { id: "fullscreen", label: "Fullscreen" },
                { id: "always", label: "Always" },
              ]}
              value={m.capture_system_keys}
              onChange={(v) => set("capture_system_keys", v)}
            />
          </Row>
        </Section>

        <Section title="Session">
          <Row label="Keep display awake">
            <Toggle checked={m.keep_awake} onChange={(v) => set("keep_awake", v)} />
          </Row>
          <Row label="Quit app after session">
            <Toggle checked={m.quit_after} onChange={(v) => set("quit_after", v)} />
          </Row>
          <Row label="Game optimizations">
            <Toggle checked={m.game_optimization} onChange={(v) => set("game_optimization", v)} />
          </Row>
        </Section>

        <p className="px-1 text-xs text-(--color-muted)">
          These settings apply when you start a stream.
        </p>
      </motion.div>
      <Prompt
        open={resOpen}
        onClose={() => setResOpen(false)}
        title="Custom resolution"
        subtitle="Width × height"
        initial={effectiveRes || detectedRes || ""}
        placeholder="e.g. 1920x1080"
        validate={(v) => (normRes(v) ? null : "Use the form 1920x1080")}
        onSubmit={(v) => {
          const r = normRes(v);
          if (r) set("resolution", r);
        }}
      />
      <Prompt
        open={fpsOpen}
        onClose={() => setFpsOpen(false)}
        title="Custom refresh rate"
        subtitle="Frames per second (10 – 480)"
        initial={effectiveFps ? String(effectiveFps) : ""}
        placeholder="e.g. 90"
        validate={(v) => {
          const n = fpsOf(v);
          if (n === null) return "Enter a number";
          if (n < 10 || n > 480) return "Must be between 10 and 480";
          return null;
        }}
        onSubmit={(v) => {
          const n = fpsOf(v);
          if (n !== null) set("refresh_rate", String(n));
        }}
      />
      <Prompt
        open={bitrateOpen}
        onClose={() => setBitrateOpen(false)}
        title="Custom bitrate"
        subtitle="Megabits per second (0.5 – 500)"
        initial={String(m.bitrate)}
        placeholder="e.g. 100"
        validate={(v) => {
          const n = parseFloat(v);
          if (!Number.isFinite(n)) return "Enter a number";
          if (n < 0.5 || n > 500) return "Must be between 0.5 and 500";
          return null;
        }}
        onSubmit={(v) => {
          const n = parseFloat(v);
          if (Number.isFinite(n)) set("bitrate", n);
        }}
      />
    </>
  );
}