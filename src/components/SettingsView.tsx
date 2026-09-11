import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { PageShell } from "./PageShell";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Row } from "./ui/Row";
import { Section } from "./ui/Section";
import { Toggle } from "./ui/Toggle";

type TailscaleStatus =
  | "not-found"
  | "not-running"
  | "starting"
  | "logged-out"
  | "connected"
  | "disconnected"; function TailscaleRow() {
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
      // Poll while the Settings page is mounted (it unmounts on navigation, so
      // the timer stops when you leave). Keeps the status live without any cost
      // on other pages.
      const id = setInterval(refresh, 3000);
      return () => clearInterval(id);
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
        <Button variant="outline-accent" size="md" onClick={select} className="px-4 py-1.5">
          Select
        </Button>
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
  startWithWindows,
  onToggleStartWithWindows,
  autoImmersive,
  onToggleAutoImmersive,
  showTime,
  onToggleShowTime,
  showDate,
  onToggleShowDate,
  showWifi,
  onToggleShowWifi,
  showBattery,
  onToggleShowBattery,
  showAudio,
  onToggleShowAudio,
}: {
  moonlightEnabled: boolean;
  onToggleMoonlight: (v: boolean) => void;
  moonlightDir: string | null;
  onSelectMoonlight: (dir: string) => void;
  appsEnabled: boolean;
  onToggleApps: (v: boolean) => void;
  steamgridKey: string | null;
  onSetSteamgridKey: (k: string) => void;
  startWithWindows: boolean;
  onToggleStartWithWindows: (v: boolean) => void;
  autoImmersive: boolean;
  onToggleAutoImmersive: (v: boolean) => void;
  showTime: boolean;
  onToggleShowTime: (v: boolean) => void;
  showDate: boolean;
  onToggleShowDate: (v: boolean) => void;
  showWifi: boolean;
  onToggleShowWifi: (v: boolean) => void;
  showBattery: boolean;
  onToggleShowBattery: (v: boolean) => void;
  showAudio: boolean;
  onToggleShowAudio: (v: boolean) => void;
}) {
  const [sgStatus, setSgStatus] = useState<"checking" | "valid" | "invalid" | "error" | null>(null);
  // Battery hardware presence — one-shot read on mount. `undefined`
  // while checking; the toggle stays disabled until we know.
  const [hasBattery, setHasBattery] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    invoke<{ percent: number; charging: boolean } | null>("battery")
      .then((s) => {
        if (alive) setHasBattery(s !== null);
      })
      .catch(() => {
        if (alive) setHasBattery(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  // HDR on the primary display. `undefined` while we haven't checked yet
  // (description says "Checking…"); `null` after a failed IPC read; an
  // object with `supported: false` means the panel/driver don't advertise
  // HDR (toggle disabled); `locked: true` means the OS has wideColorEnforced
  // or advancedColorForceDisabled set — the SET request would be silently
  // ignored, so the toggle is disabled with a "Change in Windows display
  // settings" hint.
  const [hdrStatus, setHdrStatus] = useState<
    { supported: boolean; enabled: boolean; locked: boolean } | null | undefined
  >(undefined);
  async function refreshHdr() {
    try {
      const s = await invoke<{ supported: boolean; enabled: boolean; locked: boolean }>(
        "hdr_status",
      );
      setHdrStatus(s);
    } catch {
      setHdrStatus(null);
    }
  }
  useEffect(() => {
    refreshHdr();
  }, []);
  async function toggleHdr(enabled: boolean) {
    try {
      await invoke("set_hdr", { enabled });
    } catch {
      // ignore — refresh will reflect reality
    }
    await refreshHdr();
  }

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
          <Toggle checked={startWithWindows} onChange={onToggleStartWithWindows} />
        </Row>
        <div className="flex items-start justify-between gap-4 py-4">
          <div className="flex-1">
            <div className="text-base font-medium text-(--color-text)">Auto Immersive Mode</div>
            <div className="mt-0.5 text-sm text-(--color-muted)">
              {startWithWindows
                ? "Sign in straight into Moonblast instead of the Windows desktop. Applies from your next sign-in — turning this on won't change anything right now. It:"
                : 'Requires "Start with Windows" to be enabled.'}
            </div>
            {startWithWindows && (
              <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-(--color-muted)">
                <li>Launches Moonblast fullscreen before anything else</li>
                <li>Never starts the desktop or taskbar, so nothing flashes on the way in</li>
                <li>Skips your Windows startup apps — the desktop is what launches them</li>
                <li>Minimizes other open windows so they don't show behind</li>
                <li>Hands the desktop back when you exit Immersive Mode or close Moonblast</li>
                <li>Hold Shift while signing in to boot to the normal desktop</li>
              </ul>
            )}
          </div>
          <Toggle
            checked={autoImmersive}
            onChange={onToggleAutoImmersive}
            disabled={!startWithWindows}
          />
        </div>
      </Section>

      <Section title="Display">
        <Row
          label="HDR"
          description={
            hdrStatus === undefined
              ? "Checking…"
              : hdrStatus === null
                ? "Couldn't detect display capabilities."
                : !hdrStatus.supported
                  ? "This display doesn't support HDR."
                  : hdrStatus.locked
                    ? "Locked by Windows color settings — change HDR / wide-color in Display Settings."
                    : hdrStatus.enabled
                      ? "HDR is on."
                      : "HDR is off."
          }
        >
          <Toggle
            checked={hdrStatus?.enabled ?? false}
            onChange={toggleHdr}
            disabled={
              hdrStatus === undefined ||
              hdrStatus === null ||
              !hdrStatus.supported ||
              hdrStatus.locked
            }
          />
        </Row>
      </Section>

      <Section title="Customization">
        <Row label="Show Time" description="Show the clock in the TopBar.">
          <Toggle checked={showTime} onChange={onToggleShowTime} />
        </Row>
        <Row label="Show Date" description="Show the date beside the clock in the TopBar.">
          <Toggle checked={showDate} onChange={onToggleShowDate} />
        </Row>
        <Row
          label="Show Battery"
          description={
            hasBattery === false
              ? "No battery detected on this machine."
              : "Only shown on battery-powered machines."
          }
        >
          <Toggle checked={showBattery} onChange={onToggleShowBattery} disabled={hasBattery !== true} />
        </Row>
        <Row label="Show WiFi" description="Show the WiFi status icon in the TopBar.">
          <Toggle checked={showWifi} onChange={onToggleShowWifi} />
        </Row>
        <Row label="Show Audio" description="Show the volume control in the TopBar.">
          <Toggle checked={showAudio} onChange={onToggleShowAudio} />
        </Row>
      </Section>

      <Section title="Integrations">
        <TailscaleRow />
        <Row label="Apps" description="Discover and launch installed Windows apps.">
          <Toggle checked={appsEnabled} onChange={onToggleApps} />
        </Row>
        <Row label="SteamGridDB" description="Optional API key for nicer game icons (falls back to the extracted icon).">
          <div className="flex items-center gap-2">
            <div className="w-56">
              <Input
                value={steamgridKey ?? ""}
                onChange={(e) => {
                  onSetSteamgridKey(e.currentTarget.value);
                  setSgStatus(null);
                }}
                placeholder="API key"
              />
            </div>
            <Button
              variant="outline-accent"
              size="md"
              onClick={checkKey}
              disabled={!steamgridKey || sgStatus === "checking"}
              className="px-4 py-1.5"
            >
              Check
            </Button>
          </div>
        </Row>
        {sgStatus && (
          <div
            className={`px-1 py-2 text-sm ${sgStatus === "valid"
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