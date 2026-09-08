import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { PageShell } from "./PageShell";
import { Section } from "./ui/Section";
import { Row } from "./ui/Row";
import { Toggle } from "./ui/Toggle";
import { useSettings } from "../settings/SettingsContext";

function TailscaleRow() {
  const { settings, update } = useSettings();
  const enabled = settings.integrations.tailscale_enabled;
  const [info, setInfo] = useState<{ found: boolean; up: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<{ found: boolean; up: boolean }>("tailscale_status")
      .then(setInfo)
      .catch(() => setInfo({ found: false, up: false }));
  }, []);

  async function toggle(up: boolean) {
    setBusy(true);
    try {
      await invoke("tailscale_set", { up });
      update((s) => ({
        ...s,
        integrations: { ...s.integrations, tailscale_enabled: up },
      }));
    } catch {
      // leave state as-is on failure
    } finally {
      setBusy(false);
    }
  }

  if (!info) {
    return (
      <Row label="Tailscale">
        <span className="text-sm text-(--color-muted)">Checking…</span>
      </Row>
    );
  }

  if (!info.found) {
    return (
      <Row label="Tailscale">
        <span className="text-sm text-(--color-muted)/60">Tailscale not found.</span>
      </Row>
    );
  }

  return (
    <Row label="Tailscale" description={info.up ? "Connected" : "Disconnected"}>
      <Toggle checked={enabled} onChange={toggle} disabled={busy} />
    </Row>
  );
}

function MoonlightRow({
  enabled,
  onToggle,
  dir,
  onSelect,
}: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  dir: string | null;
  onSelect: (dir: string) => void;
}) {
  const [invalid, setInvalid] = useState(false);

  async function select() {
    const picked = await open({ directory: true });
    if (typeof picked !== "string") return;
    try {
      const ok = await invoke<boolean>("validate_moonlight_dir", { path: picked });
      if (ok) {
        setInvalid(false);
        onSelect(picked);
      } else {
        setInvalid(true);
      }
    } catch {
      setInvalid(true);
    }
  }

  return (
    <Row
      label="Moonlight"
      description={
        invalid ? "Selected folder isn't a Moonlight install." : dir ?? "Select your Moonlight folder"
      }
    >
      <div className="flex items-center gap-3">
        <button
          onClick={select}
          className="rounded-full border border-(--color-accent) px-4 py-1.5 text-sm font-medium text-(--color-accent) transition hover:bg-(--color-accent-soft)"
        >
          Select
        </button>
        <Toggle checked={enabled} onChange={onToggle} disabled={!dir} />
      </div>
    </Row>
  );
}

export function SettingsView({
  moonlightEnabled,
  onToggleMoonlight,
  moonlightDir,
  onSelectMoonlight,
}: {
  moonlightEnabled: boolean;
  onToggleMoonlight: (v: boolean) => void;
  moonlightDir: string | null;
  onSelectMoonlight: (dir: string) => void;
}) {
  return (
    <PageShell title="Settings" subtitle="App-level settings.">
      <Section title="Integrations">
        <TailscaleRow />
        <MoonlightRow
          enabled={moonlightEnabled}
          onToggle={onToggleMoonlight}
          dir={moonlightDir}
          onSelect={onSelectMoonlight}
        />
      </Section>

      <Section title="General">
        <Row label="Start with Windows" description="Launch Moonblast when you sign in to Windows.">
          <Toggle />
        </Row>
      </Section>

      <Section title="Fullscreen Mode">
        <Row
          label="Suppress Explorer & background processes"
          description="Similar to Fullscreen Xbox Mode. Planned for v2."
        >
          <Toggle disabled />
        </Row>
        <Row label="Hide taskbar & auto-fullscreen" description="Enter a clean fullscreen shell on launch.">
          <Toggle disabled />
        </Row>
      </Section>

      <Section title="About">
        <div className="py-4 text-base text-(--color-muted)">
          Moonblast is a lightweight Fullscreen Mode alternative built on Tauri + Rust.
          Moonlight streaming settings live on the Moonlight page.
        </div>
      </Section>
    </PageShell>
  );
}