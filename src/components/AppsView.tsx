import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { MagnifyingGlass, Plus, X, FolderOpen } from "@phosphor-icons/react";
import { PageShell } from "./PageShell";
import { Modal } from "./ui/Modal";
import { Segmented } from "./ui/Segmented";
import { useSettings } from "../settings/SettingsContext";

interface AppEntry {
  id: string;
  name: string;
  category: string;
  path: string;
}

interface Shortcut {
  name: string;
  path: string;
  category: string;
}

const PALETTE = [
  "linear-gradient(135deg,#31416b,#2b3a5e)",
  "linear-gradient(135deg,#3a3f57,#394b45)",
  "linear-gradient(135deg,#454a75,#3b3f63)",
  "linear-gradient(135deg,#563b45,#4a3a3a)",
  "linear-gradient(135deg,#333c4a,#2f4a42)",
  "linear-gradient(135deg,#3b3b52,#333c4a)",
  "linear-gradient(135deg,#4a4460,#3f3a52)",
  "linear-gradient(135deg,#3a3f66,#323c44)",
];

function gradientFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const nameFromPath = (p: string) =>
  p
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(exe|lnk)$/i, "") || "App";

/* ----------------------------- app icon ------------------------------ */

const iconCache = new Map<string, string | null>();

function useAppIcon(name: string, path: string): string | null {
  const [icon, setIcon] = useState<string | null>(iconCache.get(path) ?? null);

  useEffect(() => {
    if (iconCache.has(path)) {
      setIcon(iconCache.get(path) ?? null);
      return;
    }
    let alive = true;
    invoke<string | null>("app_icon", { path, name })
      .then((u) => {
        iconCache.set(path, u ?? null);
        if (alive) setIcon(u ?? null);
      })
      .catch(() => {
        iconCache.set(path, null);
        if (alive) setIcon(null);
      });
    return () => {
      alive = false;
    };
  }, [path, name]);

  return icon;
}

/* ------------------------------ tile ---------------------------------- */

function AppTile({
  name,
  category,
  path,
  onLaunch,
  onRemove,
}: {
  name: string;
  category: string;
  path: string;
  onLaunch: () => void;
  onRemove?: () => void;
}) {
  const icon = useAppIcon(name, path);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.15 }}
      className="group relative"
    >
      <button
        onClick={onLaunch}
        className="flex w-full flex-col gap-3 rounded-2xl p-3 text-left transition-colors hover:bg-(--color-surface)"
      >
        <div
          className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-2xl"
          style={icon ? { background: "var(--color-surface)" } : { background: gradientFor(name) }}
        >
          {icon ? (
            <img src={icon} alt="" draggable={false} className="h-3/5 w-3/5 object-contain" />
          ) : (
            <span className="text-3xl font-semibold text-white/80">{name.charAt(0)}</span>
          )}
        </div>
        <div className="px-0.5">
          <div className="truncate text-sm font-medium text-(--color-text)">{name}</div>
          {category && <div className="truncate text-xs text-(--color-muted)">{category}</div>}
        </div>
      </button>
      {onRemove && (
        <button
          onClick={onRemove}
          title="Remove"
          aria-label="Remove"
          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-(--color-overlay) text-white/70 opacity-0 transition hover:bg-(--color-danger) hover:text-white group-hover:opacity-100"
        >
          <X size={13} weight="bold" />
        </button>
      )}
    </motion.div>
  );
}

/* ---------------------------- add modal ------------------------------ */

function AddAppModal({
  open,
  onClose,
  onAdd,
  existingPaths,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (a: Shortcut) => void;
  existingPaths: Set<string>;
}) {
  const [tab, setTab] = useState<"installed" | "browse">("installed");
  const [installed, setInstalled] = useState<AppEntry[]>([]);
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setTab("installed");
    invoke<AppEntry[]>("discover_apps").then(setInstalled).catch(() => setInstalled([]));
    setTimeout(() => searchRef.current?.focus(), 30);
  }, [open]);

  const shown = installed.filter(
    (a) =>
      !existingPaths.has(a.path) &&
      (!q || `${a.name} ${a.category}`.toLowerCase().includes(q.toLowerCase())),
  );

  function pick(a: { name: string; path: string; category?: string }) {
    onAdd({ name: a.name, path: a.path, category: a.category ?? "" });
    onClose();
  }

  async function browse() {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Applications", extensions: ["exe", "lnk"] }],
    });
    if (typeof picked === "string" && picked) {
      pick({ name: nameFromPath(picked), path: picked });
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add app" subtitle="Pick an installed app or browse to one." width="max-w-lg">
      <div className="mb-3">
        <Segmented
          variant="tabs"
          value={tab}
          onChange={setTab}
          options={[
            { id: "installed", label: "Installed" },
            { id: "browse", label: "Browse" },
          ]}
        />
      </div>

      {tab === "installed" ? (
        <>
          <div className="relative mb-3">
            <MagnifyingGlass
              size={16}
              weight="bold"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-(--color-muted)"
            />
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              placeholder="Search installed apps…"
              className="h-10 w-full rounded-xl border border-(--color-border) bg-(--color-surface) pl-9 pr-4 text-sm text-(--color-text) outline-none transition placeholder:text-(--color-muted) focus:border-(--color-accent)"
            />
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {shown.length === 0 ? (
              <p className="py-8 text-center text-sm text-(--color-muted)">Nothing to add.</p>
            ) : (
              shown.map((a) => (
                <button
                  key={a.path}
                  onClick={() => pick(a)}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-(--color-text) transition-colors hover:bg-(--color-surface)"
                >
                  <span className="truncate font-medium">{a.name}</span>
                  {a.category && (
                    <span className="ml-auto shrink-0 text-xs text-(--color-muted)">{a.category}</span>
                  )}
                </button>
              ))
            )}
          </div>
        </>
      ) : (
        <div className="py-6 text-center">
          <button
            onClick={browse}
            className="inline-flex items-center gap-2 rounded-full bg-(--color-accent) px-5 py-2.5 text-sm font-medium text-white transition hover:brightness-110"
          >
            <FolderOpen size={16} weight="bold" />
            Choose an .exe or .lnk…
          </button>
          <p className="mt-3 text-xs text-(--color-muted)">Pick any application on disk to add it.</p>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------ main ---------------------------------- */

export function AppsView() {
  const { settings, update } = useSettings();
  const shortcuts = settings.app_shortcuts;
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState("");

  const existingPaths = new Set(shortcuts.map((s) => s.path.toLowerCase()));

  function addShortcut(a: Shortcut) {
    if (existingPaths.has(a.path.toLowerCase())) return;
    update((s) => ({ ...s, app_shortcuts: [...s.app_shortcuts, a] }));
  }
  function removeShortcut(path: string) {
    update((s) => ({ ...s, app_shortcuts: s.app_shortcuts.filter((x) => x.path !== path) }));
  }
  async function launch(a: Shortcut) {
    try {
      await invoke("launch_app", { path: a.path });
    } catch {
      // ignore launch errors
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? shortcuts.filter((a) => `${a.name} ${a.category}`.toLowerCase().includes(q))
    : shortcuts;

  return (
    <>
      <PageShell
        title="Apps"
        subtitle="Your curated apps. Click to launch."
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <MagnifyingGlass
                size={18}
                weight="bold"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-(--color-muted)"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="Search apps…"
                className="h-9 w-56 rounded-full border border-(--color-border) bg-(--color-surface) pl-9 pr-4 text-sm text-(--color-text) outline-none transition placeholder:text-(--color-muted) focus:border-(--color-accent)"
              />
            </div>
            <button
              onClick={() => setAddOpen(true)}
              className="flex h-9 items-center gap-1.5 rounded-full bg-(--color-accent) px-4 text-sm font-medium text-white transition hover:brightness-110"
            >
              <Plus size={16} weight="bold" />
              Add
            </button>
          </div>
        }
      >
        {shortcuts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-(--color-border) p-12 text-center">
            <p className="text-(--color-muted)">No apps yet.</p>
            <p className="mt-1 text-sm text-(--color-muted)/70">
              Add a few from the installed list or browse to an .exe.
            </p>
            <button
              onClick={() => setAddOpen(true)}
              className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-(--color-accent) px-5 py-2 text-sm font-medium text-white transition hover:brightness-110"
            >
              <Plus size={16} weight="bold" />
              Add an app
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-(--color-muted)">No apps match “{query}”.</div>
        ) : (
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            <AnimatePresence>
              {filtered.map((a) => (
                <AppTile
                  key={a.path}
                  name={a.name}
                  category={a.category}
                  path={a.path}
                  onLaunch={() => launch(a)}
                  onRemove={() => removeShortcut(a.path)}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </PageShell>

      <AddAppModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={addShortcut}
        existingPaths={existingPaths}
      />
    </>
  );
}