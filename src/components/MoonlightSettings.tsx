import { useState } from "react";
import { motion } from "framer-motion";
import { Section } from "./ui/Section";
import { Row } from "./ui/Row";
import { Toggle } from "./ui/Toggle";
import { Select } from "./ui/Select";
import { Segmented } from "./ui/Segmented";

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
            variant="value"
            options={[
              { id: "60 Hz", label: "60 Hz" },
              { id: "120 Hz", label: "120 Hz" },
              { id: "144 Hz", label: "144 Hz" },
            ]}
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
