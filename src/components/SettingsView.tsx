import { useState } from "react";
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
  const [on, setOn] = useState(false);
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div>
        <div className="font-medium text-(--color-text)">{label}</div>
        <div className="text-sm text-(--color-muted)">{description}</div>
      </div>
      <button
        onClick={() => !disabled && setOn((v) => !v)}
        aria-pressed={on}
        disabled={disabled}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
          disabled ? "opacity-40" : on ? "bg-(--color-accent)" : "bg-(--color-border)"
        }`}
      >
        <span
          className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${
            on ? "left-6" : "left-1"
          }`}
        />
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-(--color-border) bg-(--color-surface)">
      <div className="border-b border-(--color-border) px-5 py-3 text-base font-semibold text-(--color-text)">
        {title}
      </div>
      <div className="px-5">{children}</div>
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
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-base text-(--color-muted)">App-level settings.</p>
      </div>

      <Section title="General">
        <Toggle
          label="Start with Windows"
          description="Launch Moonblast when you sign in to Windows."
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
        <div className="py-4 text-base text-(--color-muted)">
          Moonblast is a lightweight Fullscreen Mode alternative built on Tauri + Rust.
          Moonlight streaming settings live on the Moonlight page.
        </div>
      </Section>
    </motion.div>
  );
}
