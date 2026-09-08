import { useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { CaretDown, Check } from "@phosphor-icons/react";

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-(--color-border) bg-(--color-surface)">
      <div className="border-b border-(--color-border) px-5 py-3 text-base font-semibold text-(--color-text)">
        {title}
      </div>
      <div className="divide-y divide-(--color-border) px-5">{children}</div>
    </div>
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div>
        <div className="text-base font-medium text-(--color-text)">{label}</div>
        {description && <div className="mt-0.5 text-sm text-(--color-muted)">{description}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ defaultOn }: { defaultOn?: boolean }) {
  const [on, setOn] = useState(Boolean(defaultOn));
  return (
    <button
      onClick={() => setOn((v) => !v)}
      aria-pressed={on}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
        on ? "bg-(--color-accent)" : "bg-(--color-border)"
      }`}
    >
      <span
        className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${
          on ? "left-6" : "left-1"
        }`}
      />
    </button>
  );
}

function Select({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative shrink-0">
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="h-9 cursor-pointer appearance-none rounded-lg border border-(--color-border) bg-(--color-surface-2) pl-3 pr-9 text-sm text-(--color-text) outline-none transition focus:border-(--color-accent)"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <CaretDown
        size={14}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-(--color-muted)"
      />
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 rounded-lg bg-(--color-surface-2) p-1">
      {options.map((o) => {
        const active = o === value;
        return (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              active
                ? "bg-(--color-accent) text-white"
                : "text-(--color-muted) hover:text-(--color-text)"
            }`}
          >
            {active && <Check size={14} weight="bold" />}
            {o}
          </button>
        );
      })}
    </div>
  );
}

export function MoonlightSettings() {
  const [resolution, setResolution] = useState("1920×1080");
  const [refresh, setRefresh] = useState("60 Hz");
  const [bitrate, setBitrate] = useState(40);
  const [codec, setCodec] = useState("Auto");

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-6"
    >
      <Section title="Streaming">
        <Row label="Resolution" description="Streaming output resolution">
          <Select
            options={["1280×720", "1920×1080", "2560×1440", "3840×2160"]}
            value={resolution}
            onChange={setResolution}
          />
        </Row>
        <Row label="Refresh rate" description="Frames per second">
          <Segmented
            options={["60 Hz", "120 Hz", "144 Hz"]}
            value={refresh}
            onChange={setRefresh}
          />
        </Row>
        <Row label="Bitrate" description={`${bitrate} Mbps`}>
          <div className="flex w-48 shrink-0 items-center gap-3">
            <input
              type="range"
              min={5}
              max={150}
              step={5}
              value={bitrate}
              onChange={(e) => setBitrate(Number(e.currentTarget.value))}
              className="w-full accent-(--color-accent)"
            />
          </div>
        </Row>
        <Row label="Video codec">
          <Select options={["Auto", "H.264", "HEVC", "AV1"]} value={codec} onChange={setCodec} />
        </Row>
        <Row label="Fullscreen" description="Launch streaming in fullscreen">
          <Toggle defaultOn />
        </Row>
        <Row label="Show FPS overlay">
          <Toggle />
        </Row>
      </Section>

      <Section title="Input">
        <Row label="Gamepad support" description="Use controllers during streaming">
          <Toggle defaultOn />
        </Row>
        <Row label="Mouse smoothing">
          <Toggle />
        </Row>
      </Section>

      <p className="px-1 text-xs text-(--color-muted)">
        Placeholder UI — these controls will bind to your Moonlight config in a later step.
      </p>
    </motion.div>
  );
}
