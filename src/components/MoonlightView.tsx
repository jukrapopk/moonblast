import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, Play, LockKey, Monitor } from "@phosphor-icons/react";
import { machines, type Machine } from "../data";
import { MoonlightSettings } from "./MoonlightSettings";

type Step = "address" | "pin";

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${
        online ? "bg-(--color-accent-2)" : "bg-(--color-muted)/50"
      }`}
      title={online ? "Online" : "Offline"}
    />
  );
}

function MachineCard({
  machine,
  onPair,
  onPlay,
}: {
  machine: Machine;
  onPair: (m: Machine) => void;
  onPlay: (m: Machine) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="flex items-center gap-4 rounded-2xl border border-(--color-border) bg-(--color-surface) p-4"
    >
      <div
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white/80"
        style={{ background: "linear-gradient(135deg,#31416b,#2b3a5e)" }}
      >
        <Monitor size={22} weight="fill" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StatusDot online={machine.online} />
          <span className="truncate font-medium text-(--color-text)">{machine.name}</span>
        </div>
        <div className="mt-0.5 truncate text-xs text-(--color-muted)">
          {machine.address} · {machine.paired ? "Paired" : "Not paired"}
        </div>
      </div>

      {pairedButton(machine, onPlay, onPair)}
    </motion.div>
  );
}

function pairedButton(machine: Machine, onPlay: (m: Machine) => void, onPair: (m: Machine) => void) {
  if (machine.paired) {
    return (
      <div className="flex shrink-0 items-center gap-2">
        <button className="hidden rounded-lg px-3 py-1.5 text-sm text-(--color-muted) transition hover:text-(--color-text) sm:block">
          Forget
        </button>
        <button
          onClick={() => onPlay(machine)}
          className="flex items-center gap-1.5 rounded-full bg-(--color-accent) px-4 py-2 text-sm font-medium text-white transition hover:brightness-110"
        >
          <Play size={16} weight="fill" />
          Play
        </button>
      </div>
    );
  }
  return (
    <button
      onClick={() => onPair(machine)}
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent) transition hover:bg-(--color-accent)/10"
    >
      <LockKey size={16} weight="fill" />
      Pair
    </button>
  );
}

/* ----------------------------- Pairing modal ----------------------------- */

function AddMachineModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("address");
  const [address, setAddress] = useState("");
  const [pin, setPin] = useState(["", "", "", ""]);

  function nextFromAddress() {
    if (!address.trim()) return;
    setStep("pin");
  }

  function finish() {
    // Step 2: submit PIN to the host over the pairing protocol.
    onClose();
  }

  function setDigit(i: number, value: string) {
    const v = value.replace(/\D/g, "");
    if (!v) {
      setPin((p) => p.map((d, j) => (j === i ? "" : d)));
      return;
    }
    const next = pin.map((d, j) => (j === i ? v.slice(-1) : d));
    setPin(next);
    if (i < 3 && v) {
      document.getElementById(`pin-${i + 1}`)?.focus();
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-(--color-border) bg-(--color-surface-2) p-6"
      >
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              {step === "address" ? "Add machine" : "Enter pairing PIN"}
            </h2>
            <p className="mt-0.5 text-sm text-(--color-muted)">
              {step === "address"
                ? "Enter the IP address or hostname of your Sunshine host."
                : "Enter the 4-digit PIN shown on your host."}
            </p>
          </div>
          <button onClick={onClose} className="text-(--color-muted) transition hover:text-(--color-text)">
            <X size={20} />
          </button>
        </div>

        <AnimatePresence mode="wait">
          {step === "address" ? (
            <motion.div key="addr" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <input
                autoFocus
                value={address}
                onChange={(e) => setAddress(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && nextFromAddress()}
                placeholder="e.g. 192.168.1.20"
                className="h-11 w-full rounded-xl border border-(--color-border) bg-(--color-surface) px-4 text-sm text-(--color-text) outline-none transition placeholder:text-(--color-muted) focus:border-(--color-accent)"
              />
              <div className="mt-5 flex justify-end gap-2">
                <button
                  onClick={onClose}
                  className="rounded-full px-4 py-2 text-sm text-(--color-muted) transition hover:text-(--color-text)"
                >
                  Cancel
                </button>
                <button
                  onClick={nextFromAddress}
                  disabled={!address.trim()}
                  className="rounded-full bg-(--color-accent) px-5 py-2 text-sm font-medium text-white transition enabled:hover:brightness-110 disabled:opacity-40"
                >
                  Continue
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="pin" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="flex justify-center gap-3">
                {pin.map((d, i) => (
                  <input
                    key={i}
                    id={`pin-${i}`}
                    value={d}
                    onChange={(e) => setDigit(i, e.currentTarget.value)}
                    className="h-16 w-14 rounded-xl border border-(--color-border) bg-(--color-surface) text-center text-2xl font-semibold text-(--color-text) outline-none transition focus:border-(--color-accent)"
                    inputMode="numeric"
                    maxLength={1}
                  />
                ))}
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  onClick={() => setStep("address")}
                  className="rounded-full px-4 py-2 text-sm text-(--color-muted) transition hover:text-(--color-text)"
                >
                  Back
                </button>
                <button
                  onClick={finish}
                  disabled={pin.some((d) => !d)}
                  className="rounded-full bg-(--color-accent) px-5 py-2 text-sm font-medium text-white transition enabled:hover:brightness-110 disabled:opacity-40"
                >
                  Pair
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------- Main view ------------------------------- */

export function MoonlightView() {
  const [sub, setSub] = useState<"machines" | "settings">("machines");
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 2500);
  }

  function handlePair(_machine: Machine) {
    // Step 2: real pairing handshake. For now this is a UI placeholder.
    setModalOpen(true);
  }

  function handlePlay(machine: Machine) {
    // Step 2: launch Moonlight player for this host.
    showToast(`Launching ${machine.name}…`);
  }

  const tabs: { id: "machines" | "settings"; label: string }[] = [
    { id: "machines", label: "Machines" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="mx-auto max-w-4xl"
    >
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Moonlight</h1>
          <p className="text-base text-(--color-muted)">Your streaming hosts.</p>
        </div>
        {sub === "machines" && (
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-1.5 rounded-full bg-(--color-accent) px-4 py-2 text-sm font-medium text-white transition hover:brightness-110"
          >
            <Plus size={16} weight="bold" />
            Add machine
          </button>
        )}
      </div>

      <div className="mb-6 inline-flex items-center gap-1 rounded-full bg-(--color-surface) p-1 ring-1 ring-(--color-border)">
        {tabs.map((t) => {
          const active = sub === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setSub(t.id)}
              className={`rounded-full px-5 py-1.5 text-base font-medium transition-colors ${
                active
                  ? "bg-(--color-accent) text-white"
                  : "text-(--color-muted) hover:text-(--color-text)"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        {sub === "machines" ? (
          <motion.div
            key="machines"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="space-y-3">
              {machines.map((m) => (
                <MachineCard key={m.id} machine={m} onPair={handlePair} onPlay={handlePlay} />
              ))}
            </div>
            <div className="mt-6 rounded-2xl border border-dashed border-(--color-border) p-5 text-center text-sm text-(--color-muted)">
              Pairing & host discovery (real network functionality) will replace this UI in Step 2.
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="settings"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <MoonlightSettings />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {modalOpen && <AddMachineModal onClose={() => setModalOpen(false)} />}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-(--color-surface-2) px-5 py-2.5 text-sm text-(--color-text) shadow-lg ring-1 ring-(--color-border)"
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
