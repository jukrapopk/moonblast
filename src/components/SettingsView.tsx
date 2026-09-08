import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { PageShell } from "./PageShell";
import { Section } from "./ui/Section";
import { Row } from "./ui/Row";
import { Toggle } from "./ui/Toggle";

type TailscaleStatus =
  | "not-found"
  | "not-running"
  | "starting"
  | "logged-out"
  | "connected"
  | "disconnected";function TailscaleRow() {
  const [status, setStatus] = useState<TailscaleStatus | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const info = await invoke<{ status: TailscaleStatus }>("tailscale_status");
      setStatus(info.status);
    } catch {
      setStatus("not-found");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function toggle(up: boolean) {
    setBusy(true);
    try {
      await invoke("tailscale_set", { up });
    } catch {
      // keep current status; refresh below reflects reality
    }
    await refresh();
    setBusy(false);
  }

  if (status === null) {
    return (
      <Row label="Tailscale">
        <span className="text-sm text-(--color-muted)">Checking…</span>
      </Row>
    );
  }

  if (status === "not-found") {
    return (
      <Row label="Tailscale">
        <span className="text-sm text-(--color-muted)/60">Tailscale not found.</span>
      </Row>
    );
  }

  if (status === "not-running") {
    return (
      <Row label="Tailscale" description="Tailscale isn't running">
        <span className="text-sm text-(--color-muted)/60">Start the Tailscale app to use it.</span>
      </Row>
    );
  }

  if (status === "starting") {
    return (
      <Row label="Tailscale" description="Tailscale is starting…">
        <span className="text-sm text-(--color-muted)/60">Please wait.</span>
      </Row>
    );
  }

  if (status === "logged-out") {
    return (
      <Row label="Tailscale" description="Logged out">
        <span className="text-sm text-(--color-muted)/60">Sign in to Tailscale to connect.</span>
      </Row>
    );
  }

  const up = status === "connected";

  return (
    <Row label="Tailscale" description={up ? "Connected" : "Disconnected"}>
      <Toggle checked={up} onChange={toggle} disabled={busy} />
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
  appsEnabled,
  onToggleApps,
  steamgridKey,
  onSetSteamgridKey,
}: {
  moonlightEnabled: boolean;
  onToggleMoonlight: (v: boolean) => void;
  moonlightDir: string | null;
  onSelectMoonlight: (dir: string) => void;
  appsEnabled: boolean;
  onToggleApps: (v: boolean) => void;
  steamgridKey: string | null;
  onSetSteamgridKey: (k: string) => void;
}) {
  const [sgStatus, setSgStatus] = useState<"checking" | "valid" | "invalid" | "error" | null>(null);

  async function checkKey() {
    if (!steamgridKey) return;
    setSgStatus("checking");
    try {
      const s = await invoke<string>("check_steamgrid_key", { key: steamgridKey });
      setSgStatus(s === "valid" ? "valid" : s === "invalid" ? "invalid" : "error");
    } catch {
      setSgStatus("error");
    }
  }
  return (
    <PageShell title="Settings" subtitle="App-level settings.">
      <Section title="General">
        <Row label="Start with Windows" description="Launch Moonblast when you sign in to Windows.">
          <Toggle />
        </Row>
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

      <Section title="Integrations">
        <TailscaleRow />
        <Row label="Apps" description="Discover and launch installed Windows apps.">
          <Toggle checked={appsEnabled} onChange={onToggleApps} />
        </Row>
        <Row label="SteamGridDB" description="Optional API key for nicer game icons (falls back to the extracted icon).">
          <div className="flex items-center gap-2">
            <input
              value={steamgridKey ?? ""}
              onChange={(e) => {
                onSetSteamgridKey(e.currentTarget.value);
                setSgStatus(null);
              }}
              placeholder="API key"
              className="h-9 w-56 rounded-lg border border-(--color-border) bg-(--color-surface-2) px-3 text-sm text-(--color-text) outline-none transition focus:border-(--color-accent) placeholder:text-(--color-muted)"
            />
            <button
              onClick={checkKey}
              disabled={!steamgridKey || sgStatus === "checking"}
              className="rounded-full border border-(--color-accent) px-4 py-1.5 text-sm font-medium text-(--color-accent) transition enabled:hover:bg-(--color-accent-soft) disabled:opacity-40"
            >
              Check
            </button>
          </div>
        </Row>
        {sgStatus && (
          <div
            className={`px-1 py-2 text-sm ${
              sgStatus === "valid"
                ? "text-(--color-accent)"
                : sgStatus === "checking"
                  ? "text-(--color-muted)"
                  : "text-(--color-danger)"
            }`}
          >
            {sgStatus === "checking"
              ? "Checking…"
              : sgStatus === "valid"
                ? "✓ Key is valid."
                : sgStatus === "invalid"
                  ? "✕ Key was rejected."
                  : "Couldn't reach SteamGridDB."}
          </div>
        )}
        <MoonlightRow
          enabled={moonlightEnabled}
          onToggle={onToggleMoonlight}
          dir={moonlightDir}
          onSelect={onSelectMoonlight}
        />
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