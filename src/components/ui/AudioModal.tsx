import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Slider } from "./Slider";
import {
  ArrowCounterClockwise,
  ArrowsClockwise,
  Check,
} from "@phosphor-icons/react";
import { SpeakerIcon } from "./SpeakerIcon";
import {
  fetchAudioDevices,
  fetchAudioMaster,
  fetchAudioSessions,
  openSoundSettings,
  resetSessionVolumes,
  setDefaultDevice,
  setMasterMute,
  setMasterVolume,
  setSessionMute,
  setSessionVolume,
  type AudioDevice,
  type AudioMaster,
  type AudioSession,
} from "../../hooks/useAudio";

interface AudioModalProps {
  open: boolean;
  onClose: () => void;
  /** Parent refreshes the TopBar chip after device/volume changes. */
  onChanged: () => void;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
      {children}
    </div>
  );
}

export function AudioModal({ open, onClose, onChanged }: AudioModalProps) {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [master, setMaster] = useState<AudioMaster>({ volume: 100, muted: false });
  const [sessions, setSessions] = useState<AudioSession[]>([]);
  const [loading, setLoading] = useState(false);
  /** Device id currently being switched to (row spinner). */
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [d, m, s] = await Promise.all([
        fetchAudioDevices(),
        fetchAudioMaster(),
        fetchAudioSessions(),
      ]);
      setDevices(d.devices);
      setMaster(m);
      setSessions(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSwitching(null);
    void refresh();
    // Push channel — external volume/session/device changes re-read
    // automatically while the modal is open. No polling, no Refresh.
    let unlisten: (() => void) | undefined;
    void listen("audio-changed", () => void refresh()).then((f) => {
      unlisten = f;
    });
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  async function handleSelectDevice(id: string) {
    setSwitching(id);
    setError(null);
    try {
      await setDefaultDevice(id);
      await refresh();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setSwitching(null);
    }
  }

  function handleMasterVolume(v: number) {
    setMaster((m) => ({ ...m, volume: v }));
    // Fire-and-forget: COM set is sub-millisecond; awaiting every tick
    // would queue invokes behind the drag.
    void setMasterVolume(v)
      .then(() => onChanged())
      .catch((e) => setError(String(e)));
  }

  async function handleMasterMute() {
    const next = !master.muted;
    setMaster((m) => ({ ...m, muted: next }));
    try {
      await setMasterMute(next);
      onChanged();
    } catch (e) {
      setError(String(e));
      setMaster((m) => ({ ...m, muted: !next }));
    }
  }

  function handleSessionVolume(id: string, v: number) {
    setSessions((ss) => ss.map((s) => (s.id === id ? { ...s, volume: v } : s)));
    void setSessionVolume(id, v).catch((e) => setError(String(e)));
  }

  async function handleSessionMute(id: string) {
    const cur = sessions.find((s) => s.id === id);
    if (!cur) return;
    setSessions((ss) =>
      ss.map((s) => (s.id === id ? { ...s, muted: !s.muted } : s)),
    );
    try {
      await setSessionMute(id, !cur.muted);
    } catch (e) {
      setError(String(e));
      setSessions((ss) =>
        ss.map((s) => (s.id === id ? { ...s, muted: cur.muted } : s)),
      );
    }
  }

  async function handleSessionReset(id: string) {
    setSessions((ss) =>
      ss.map((s) => (s.id === id ? { ...s, volume: 100, muted: false } : s)),
    );
    try {
      await Promise.all([setSessionVolume(id, 100), setSessionMute(id, false)]);
    } catch (e) {
      setError(String(e));
      void refreshSessions();
    }
  }

  async function refreshSessions() {
    try {
      setSessions(await fetchAudioSessions());
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleResetAll() {
    setError(null);
    try {
      await resetSessionVolumes();
      await refreshSessions();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Audio" width="max-w-md">
      {error && (
        <p className="mb-3 rounded-lg border border-(--color-danger)/30 bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)">
          {error}
        </p>
      )}

      <SectionLabel>Output</SectionLabel>
      <div className="mb-4 max-h-44 space-y-1 overflow-y-auto">
        {loading && devices.length === 0 ? (
          <p className="py-4 text-center text-sm text-(--color-muted)">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="py-4 text-center text-sm text-(--color-muted)">
            No output devices found
          </p>
        ) : (
          devices.map((d) => {
            const busy = switching === d.id;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => void handleSelectDevice(d.id)}
                disabled={switching !== null}
                aria-label={`Use ${d.name} for audio`}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors focus:outline-none disabled:opacity-40 ${
                  d.is_default
                    ? "bg-(--color-accent-soft)"
                    : "hover:bg-(--color-surface) focus:bg-(--color-surface)"
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-(--color-text)">
                  {d.name}
                </span>
                {busy ? (
                  <ArrowsClockwise size={14} weight="bold" className="shrink-0 animate-spin text-(--color-muted)" />
                ) : (
                  d.is_default && (
                    <Check size={14} weight="bold" className="shrink-0 text-(--color-accent)" />
                  )
                )}
              </button>
            );
          })
        )}
      </div>

      <SectionLabel>Volume</SectionLabel>
      <div className="mb-4 flex items-center gap-3 rounded-xl px-1 py-1">
        <button
          onClick={() => void handleMasterMute()}
          title={master.muted ? "Unmute" : "Mute"}
          aria-label={master.muted ? "Unmute" : "Mute"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-(--color-muted) transition-colors hover:text-(--color-text)"
        >
          <SpeakerIcon volume={master.volume} muted={master.muted} size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <Slider
            value={master.muted ? 0 : master.volume}
            onChange={handleMasterVolume}
            label="Main volume"
          />
        </div>
        <span className="w-10 shrink-0 text-right text-sm text-(--color-muted) tabular-nums">
          {master.muted ? "Muted" : `${master.volume}%`}
        </span>
      </div>

      <div className="mb-1 flex items-center justify-between">
        <SectionLabel>Apps</SectionLabel>
        {sessions.length > 0 && (
          <Button variant="ghost" size="md" onClick={() => void handleResetAll()} className="px-3 py-1 text-xs">
            Reset all
          </Button>
        )}
      </div>
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <p className="py-4 text-center text-sm text-(--color-muted)">
            {loading ? "Loading…" : "No apps playing audio"}
          </p>
        ) : (
          sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-xl px-1 py-1.5">
              <div className="w-28 shrink-0 truncate text-sm font-medium text-(--color-text)" title={s.name}>
                {s.name}
              </div>
              <button
                onClick={() => void handleSessionMute(s.id)}
                title={s.muted ? `Unmute ${s.name}` : `Mute ${s.name}`}
                aria-label={s.muted ? `Unmute ${s.name}` : `Mute ${s.name}`}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-(--color-muted) transition-colors hover:text-(--color-text)"
              >
                <SpeakerIcon volume={s.volume} muted={s.muted} size={16} />
              </button>
              <div className="min-w-0 flex-1">
                <Slider
                  value={s.muted ? 0 : s.volume}
                  onChange={(v) => handleSessionVolume(s.id, v)}
                  label={`${s.name} volume`}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-xs text-(--color-muted) tabular-nums">
                {s.muted ? "Muted" : `${s.volume}%`}
              </span>
              <button
                onClick={() => void handleSessionReset(s.id)}
                title={`Reset ${s.name} to max`}
                aria-label={`Reset ${s.name} to max`}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-(--color-muted) transition-colors hover:text-(--color-text)"
              >
                <ArrowCounterClockwise size={14} weight="bold" />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-(--color-border) pt-3">
        <Button variant="ghost" size="md" onClick={() => void openSoundSettings()}>
          Sound Settings
        </Button>
      </div>
    </Modal>
  );
}
