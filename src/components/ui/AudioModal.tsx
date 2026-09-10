import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Slider } from "./Slider";
import {
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
  /**
   * Last non-zero levels. 0 and mute are a single state in the UI, so
   * unmuting from 0 restores these instead of staying silent at 0.
   */
  const lastMaster = useRef(50);
  const lastSession = useRef<Record<string, number>>({});
  /**
   * Timestamp of the last local change. The `audio-changed` listener skips
   * refreshes inside this self-echo window: our optimistic state is ahead
   * of the backend read, so a re-read would snap the dragged slider back
   * to a stale value and fight the drag.
   */
  const localChangeAt = useRef(0);
  function markLocal() {
    localChangeAt.current = Date.now();
  }

  async function refresh() {
    setLoading(true);
    try {
      const [d, m, ss] = await Promise.all([
        fetchAudioDevices(),
        fetchAudioMaster(),
        fetchAudioSessions(),
      ]);
      setDevices(d.devices);
      setMaster(m);
      setSessions(ss);
      if (m.volume > 0) lastMaster.current = m.volume;
      for (const s of ss) {
        if (s.volume > 0) lastSession.current[s.id] = s.volume;
      }
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
    // Skips the self-echo window after local changes so refreshes don't
    // fight an in-progress slider drag with stale backend reads.
    let unlisten: (() => void) | undefined;
    void listen("audio-changed", () => {
      if (Date.now() - localChangeAt.current < 500) return;
      void refresh();
    }).then((f) => {
      unlisten = f;
    });
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  async function handleSelectDevice(id: string) {
    setSwitching(id);
    setError(null);
    markLocal();
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
    const wasMuted = master.muted;
    if (v > 0) lastMaster.current = v;
    markLocal();
    // 0 and mute are one state: dragging the slider always leaves mute behind.
    setMaster({ volume: v, muted: false });
    // Fire-and-forget: COM set is sub-millisecond; awaiting every tick
    // would queue invokes behind the drag.
    void setMasterVolume(v)
      .then(() => onChanged())
      .catch((e) => setError(String(e)));
    if (wasMuted) void setMasterMute(false).catch((e) => setError(String(e)));
  }

  async function handleMasterMute() {
    const prev = master;
    markLocal();
    if (prev.muted || prev.volume === 0) {
      const restore = prev.volume > 0 ? prev.volume : lastMaster.current;
      setMaster({ volume: restore, muted: false });
      try {
        if (prev.muted) await setMasterMute(false);
        if (prev.volume === 0) await setMasterVolume(restore);
        onChanged();
      } catch (e) {
        setError(String(e));
        setMaster(prev);
      }
    } else {
      setMaster({ ...prev, muted: true });
      try {
        await setMasterMute(true);
        onChanged();
      } catch (e) {
        setError(String(e));
        setMaster(prev);
      }
    }
  }

  function handleSessionVolume(id: string, v: number) {
    const wasMuted = sessions.find((s) => s.id === id)?.muted ?? false;
    if (v > 0) lastSession.current[id] = v;
    markLocal();
    setSessions((ss) =>
      ss.map((s) => (s.id === id ? { ...s, volume: v, muted: false } : s)),
    );
    void setSessionVolume(id, v).catch((e) => setError(String(e)));
    if (wasMuted) void setSessionMute(id, false).catch((e) => setError(String(e)));
  }

  async function handleSessionMute(id: string) {
    const cur = sessions.find((s) => s.id === id);
    if (!cur) return;
    markLocal();
    if (cur.muted || cur.volume === 0) {
      const restore = cur.volume > 0 ? cur.volume : (lastSession.current[id] ?? 50);
      setSessions((ss) =>
        ss.map((s) => (s.id === id ? { ...s, volume: restore, muted: false } : s)),
      );
      try {
        if (cur.muted) await setSessionMute(id, false);
        if (cur.volume === 0) await setSessionVolume(id, restore);
      } catch (e) {
        setError(String(e));
        setSessions((ss) =>
          ss.map((s) => (s.id === id ? { ...s, volume: cur.volume, muted: cur.muted } : s)),
        );
      }
    } else {
      setSessions((ss) =>
        ss.map((s) => (s.id === id ? { ...s, muted: true } : s)),
      );
      try {
        await setSessionMute(id, true);
      } catch (e) {
        setError(String(e));
        setSessions((ss) =>
          ss.map((s) => (s.id === id ? { ...s, muted: cur.muted } : s)),
        );
      }
    }
  }

  async function refreshSessions() {
    try {
      const ss = await fetchAudioSessions();
      setSessions(ss);
      for (const s of ss) {
        if (s.volume > 0) lastSession.current[s.id] = s.volume;
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleResetAll() {
    setError(null);
    markLocal();
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
      <div className="mb-5 max-h-44 space-y-1 overflow-y-auto">
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
      <div className="mb-5 flex items-center gap-3 rounded-xl px-1 py-1">
        <button
          onClick={() => void handleMasterMute()}
          title={master.muted || master.volume === 0 ? "Unmute" : "Mute"}
          aria-label={master.muted || master.volume === 0 ? "Unmute" : "Mute"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-(--color-muted) transition-colors hover:text-(--color-text)"
        >
          <SpeakerIcon volume={master.volume} muted={master.muted} size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <Slider
            value={master.muted || master.volume === 0 ? 0 : master.volume}
            onChange={handleMasterVolume}
            label="Main volume"
          />
        </div>
        <span className="w-10 shrink-0 text-right text-xs text-(--color-muted) tabular-nums">
          {master.muted || master.volume === 0 ? "Muted" : `${master.volume}%`}
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
                title={s.muted || s.volume === 0 ? `Unmute ${s.name}` : `Mute ${s.name}`}
                aria-label={s.muted || s.volume === 0 ? `Unmute ${s.name}` : `Mute ${s.name}`}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-(--color-muted) transition-colors hover:text-(--color-text)"
              >
                <SpeakerIcon volume={s.volume} muted={s.muted} size={16} />
              </button>
              <div className="min-w-0 flex-1">
                <Slider
                  value={s.muted || s.volume === 0 ? 0 : s.volume}
                  onChange={(v) => handleSessionVolume(s.id, v)}
                  label={`${s.name} volume`}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-xs text-(--color-muted) tabular-nums">
                {s.muted || s.volume === 0 ? "Muted" : `${s.volume}%`}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="mt-5 flex items-center justify-end gap-2 border-t border-(--color-border) pt-4">
        <Button variant="ghost" size="md" onClick={() => void openSoundSettings()}>
          Sound Settings
        </Button>
      </div>
    </Modal>
  );
}
