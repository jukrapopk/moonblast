import { motion } from "framer-motion";

function Toggle({
  label,
  description,
  disabled,
}: {
  label: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div>
        <div className="font-medium text-(--color-text)">{label}</div>
        <div className="text-sm text-(--color-muted)">{description}</div>
      </div>
      <div
        className={`h-6 w-11 shrink-0 rounded-full bg-(--color-border) ${disabled ? "opacity-40" : ""}`}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-(--color-border) bg-(--color-surface)">
      <div className="border-b border-(--color-border) px-5 py-3 text-sm font-semibold text-(--color-text)">
        {title}
      </div>
      <div className="px-5 py-1">{children}</div>
    </div>
  );
}

export function SettingsView() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="max-w-2xl space-y-6"
    >
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-(--color-muted)">Configure your streaming shell.</p>
      </div>

      <Section title="Moonlight">
        <Toggle
          label="Launch Moonlight for each game"
          description="Start the Moonlight client when you press Play."
          disabled
        />
        <Toggle
          label="Close shell during streaming"
          description="Free up resources while a session is running. (Coming soon)"
          disabled
        />
      </Section>

      <Section title="Fullscreen Mode">
        <Toggle
          label="Suppress Explorer & background processes"
          description="Similar to Fullscreen Xbox Mode. Planned for v2."
          disabled
        />
        <Toggle
          label="Hide taskbar & auto-fullscreen"
          description="Enter a clean fullscreen shell on launch."
          disabled
        />
      </Section>

      <Section title="About">
        <div className="py-4 text-sm text-(--color-muted)">
          Moonblast is a lightweight Fullscreen Mode alternative built on Tauri + Rust. Step 1 is an
          interface shell — Moonlight integration and process management come in later steps.
        </div>
      </Section>
    </motion.div>
  );
}
