import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { MagnifyingGlass, Plus, FolderOpen, Image, ArrowClockwise, PencilSimple, ClipboardText } from "@phosphor-icons/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { PageShell } from "./PageShell";
import { Modal } from "./ui/Modal";
import { Segmented } from "./ui/Segmented";
import { useContextMenu } from "./ui/ContextMenu";
import { Toast } from "./ui/Toast";
import { Input } from "./ui/Input";
import { FilterList } from "./ui/FilterList";
import { useSettings } from "../settings/SettingsContext";

interface AppEntry {
  id: string;
  name: string;
  source: string; // "" | "Store" | "Steam"
  path: string;
  kind: string; // "exe" | "store" | "steam"
}

interface Shortcut {
  name: string;
  path: string;
  source: string; // "" | "Store" | "Steam"
  kind: string; // "exe" | "store" | "steam"
  display_name: string | null; // null/empty → use name
  custom_icon: string | null;
  use_desktop_icon: boolean;
  steamgrid_icon: string | null;
}

/** Effective display label: display_name overrides the original name. */
const labelOf = (s: { name: string; display_name: string | null }) => s.display_name || s.name;

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

function useAppIcon(
  name: string,
  path: string,
  bust: number,
  forceDesktop: boolean,
  skip: boolean,
): string | null {
  const [icon, setIcon] = useState<string | null>(skip ? null : (iconCache.get(path) ?? null));

  useEffect(() => {
    if (skip) return;
    if (iconCache.has(path)) {
      setIcon(iconCache.get(path) ?? null);
      return;
    }
    let alive = true;
    invoke<string | null>("app_icon", { path, name, forceDesktop })
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
  }, [path, name, bust, forceDesktop, skip]);

  return skip ? null : icon;
}

/* ------------------------------ tile ---------------------------------- */

function AppTile({
  name,
  path,
  customIcon,
  steamgridIcon,
  useDesktopIcon,
  bust,
  focused,
  onLaunch,
  onContextMenu,
}: {
  name: string;
  path: string;
  customIcon: string | null;
  steamgridIcon: string | null;
  useDesktopIcon: boolean;
  bust: number;
  focused: boolean;
  onLaunch: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  // Custom file icon > pinned SteamGridDB icon > desktop/auto.
  const hasOverride = !!(customIcon || steamgridIcon);
  const forceDesktop = useDesktopIcon && !hasOverride;
  const fetchedIcon = useAppIcon(name, path, bust, forceDesktop, hasOverride);
  // steamgrid_icon is a local `.icons` cache path (or a legacy remote URL that
  // gets localized by the migration effect — prefer raw while still remote).
  const steamgridSrc = steamgridIcon
    ? steamgridIcon.startsWith("http")
      ? steamgridIcon
      : convertFileSrc(steamgridIcon)
    : null;
  const icon = customIcon ? convertFileSrc(customIcon) : (steamgridSrc ?? fetchedIcon);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.15 }}
      className={`group relative rounded-2xl p-3 transition-all duration-150 ${
        focused
          ? "z-10 scale-[1.08] bg-(--color-accent-soft) shadow-[0_12px_32px_-12px_var(--color-overlay)]"
          : ""
      }`}
      onContextMenu={onContextMenu}
    >
      <button
        onClick={onLaunch}
        className="block w-full outline-none focus:outline-none"
      >
        <div
          className={`relative flex aspect-square items-center justify-center overflow-hidden rounded-2xl text-3xl font-semibold ${icon ? "" : "w-full text-white/80"}`}
          style={
            icon
              ? { width: "calc(100% + 0.75rem)", marginInline: "-0.375rem" }
              : { background: gradientFor(name) }
          }
        >
          {icon ? (
            <img src={icon} alt="" draggable={false} className="h-full w-full object-cover" />
          ) : (
            name.charAt(0)
          )}
        </div>
        <div className="mt-2 truncate text-center text-xs font-medium text-(--color-text)">
          {name}
        </div>
      </button>
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
  onAdd: (a: { name: string; path: string; source?: string; kind: string }) => void;
  existingPaths: Set<string>;
}) {
  const [tab, setTab] = useState<"installed" | "browse">("installed");
  const [installed, setInstalled] = useState<AppEntry[]>([]);

  useEffect(() => {
    if (!open) return;
    setTab("installed");
    invoke<AppEntry[]>("discover_apps").then(setInstalled).catch(() => setInstalled([]));
  }, [open]);

  function pick(a: { name: string; path: string; source?: string; kind: string }) {
    onAdd({ name: a.name, path: a.path, source: a.source ?? "", kind: a.kind });
    onClose();
  }

  async function browse() {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Applications", extensions: ["exe", "lnk"] }],
    });
    if (typeof picked === "string" && picked) {
      pick({ name: nameFromPath(picked), path: picked, kind: "exe" });
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
        <FilterList
          items={installed}
          options={{
            getKey: (a) => a.path,
            getLabel: (a) => a.name,
            getSource: (a) => a.source ?? "",
            exclude: (a) => existingPaths.has(a.path),
          }}
          searchPlaceholder="Search installed apps…"
          empty={<p className="py-8 text-center text-sm text-(--color-muted)">Nothing to add.</p>}
          render={(a) => (
            <button
              onClick={() => pick(a)}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-(--color-text) transition-colors hover:bg-(--color-surface)"
            >
              <span className="truncate font-medium">{a.name}</span>
              {a.source && (
                <span className="ml-auto shrink-0 text-xs text-(--color-muted)">{a.source}</span>
              )}
            </button>
          )}
        />
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

/* -------------------------- SteamGridDB modal ------------------------ */

interface SgTitle {
  id: number;
  name: string;
}
interface SgIcon {
  id: number;
  url: string;
}

function SteamGridModal({
  app,
  onClose,
  onSetIcon,
}: {
  app: Shortcut | null;
  onClose: () => void;
  onSetIcon: (path: string, url: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [titles, setTitles] = useState<SgTitle[]>([]);
  const [icons, setIcons] = useState<SgIcon[]>([]);
  const [selected, setSelected] = useState<SgTitle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (app) {
      setQuery(app.name);
      setTitles([]);
      setIcons([]);
      setSelected(null);
      setError(null);
    }
  }, [app]);

  async function search() {
    const t = query.trim();
    if (!t || !app) return;
    setBusy(true);
    setError(null);
    setIcons([]);
    setSelected(null);
    try {
      const idMatch = /^\d+$/.test(t);
      if (idMatch) {
        const id = Number(t);
        setSelected({ id, name: `Game #${id}` });
        setIcons(await invoke<SgIcon[]>("steamgrid_icons", { gameId: id }));
      } else {
        setTitles(await invoke<SgTitle[]>("steamgrid_search", { query: t }));
      }
    } catch (e) {
      setError(String(e));
      setTitles([]);
      setIcons([]);
    } finally {
      setBusy(false);
    }
  }

  async function pickTitle(t: SgTitle) {
    setSelected(t);
    setBusy(true);
    setError(null);
    try {
      setIcons(await invoke<SgIcon[]>("steamgrid_icons", { gameId: t.id }));
    } catch (e) {
      setError(String(e));
      setIcons([]);
    } finally {
      setBusy(false);
    }
  }

  async function choose(icon: SgIcon) {
    if (!app) return;
    // Persist the chosen icon to the `.icons` cache so it's offline-stable.
    const local = await invoke<string | null>("cache_steamgrid_icon", { url: icon.url }).catch(
      () => null,
    );
    onSetIcon(app.path, local ?? icon.url);
    onClose();
  }

  return (
    <Modal
      open={!!app}
      onClose={onClose}
      title="SteamGridDB icon"
      subtitle={app ? `for ${app.name}` : ""}
      width="max-w-lg"
    >
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Search by name, or enter a game id…"
          />
        </div>
        <button
          onClick={search}
          disabled={!query.trim() || busy}
          className="rounded-full border border-(--color-accent) px-4 py-1.5 text-sm font-medium text-(--color-accent) transition enabled:hover:bg-(--color-accent-soft) disabled:opacity-40"
        >
          Search
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-(--color-danger)">{error}</p>}

      {selected ? (
        <div className="mt-3">
          <button
            onClick={() => {
              setSelected(null);
              setIcons([]);
            }}
            className="text-xs text-(--color-muted) transition hover:text-(--color-text)"
          >
            ← back to results
          </button>
          <div className="mt-2 grid max-h-64 grid-cols-4 gap-2 overflow-y-auto">
            {icons.length === 0 && !busy ? (
              <p className="col-span-full py-6 text-center text-sm text-(--color-muted)">
                No icons for “{selected.name}”.
              </p>
            ) : (
              icons.map((ic) => (
                <button
                  key={ic.id}
                  onClick={() => choose(ic)}
                  className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface) transition hover:border-(--color-accent)"
                >
                  <img src={ic.url} alt="" loading="lazy" className="h-full w-full object-contain" />
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="mt-3 max-h-64 space-y-1 overflow-y-auto">
          {titles.length === 0 && !busy ? (
            <p className="py-4 text-center text-sm text-(--color-muted)">
              Type a query to find a title.
            </p>
          ) : (
            titles.map((t) => (
              <button
                key={t.id}
                onClick={() => pickTitle(t)}
                className="w-full rounded-lg px-3 py-2 text-left text-sm text-(--color-text) transition-colors hover:bg-(--color-surface)"
              >
                {t.name}
              </button>
            ))
          )}
        </div>
      )}

      {app?.steamgrid_icon && (
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => {
              onSetIcon(app.path, null);
              onClose();
            }}
            className="text-sm text-(--color-danger) transition hover:underline"
          >
            Clear icon
          </button>
        </div>
      )}
    </Modal>
  );
}

/* --------------------------- rename modal ----------------------------- */

function RenameModal({
  shortcut,
  onClose,
  onSave,
}: {
  shortcut: Shortcut | null;
  onClose: () => void;
  onSave: (path: string, value: string) => void;
}) {
  const [val, setVal] = useState("");
  useEffect(() => setVal(shortcut?.display_name ?? ""), [shortcut]);

  function save() {
    if (shortcut) onSave(shortcut.path, val);
    onClose();
  }

  return (
    <Modal
      open={!!shortcut}
      onClose={onClose}
      title="Rename app"
      subtitle={shortcut ? `Original: ${shortcut.name}` : ""}
      width="max-w-sm"
    >
      <Input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.currentTarget.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
        placeholder={shortcut?.name ?? "…"}
      />
      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-full px-4 py-1.5 text-sm text-(--color-muted) transition hover:text-(--color-text)"
        >
          Cancel
        </button>
        <button
          onClick={save}
          className="rounded-full bg-(--color-accent) px-5 py-1.5 text-sm font-medium text-white transition hover:brightness-110"
        >
          Save
        </button>
      </div>
      <p className="mt-2 text-xs text-(--color-muted)">Leave empty to use the original name.</p>
    </Modal>
  );
}

/* ------------------------------ main ------------------------------ */

export function AppsView() {
  const { settings, update } = useSettings();
  const shortcuts = settings.app_shortcuts;
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [bust, setBust] = useState(0);
  const ctx = useContextMenu();
  const [sgApp, setSgApp] = useState<Shortcut | null>(null);
  const [renameApp, setRenameApp] = useState<Shortcut | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  // Keyboard / gamepad grid navigation.
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusIdx, setFocusIdx] = useState(-1);
  const COLS = 6;

  useEffect(() => {
    gridRef.current?.focus();
  }, [query, shortcuts.length]);

  useEffect(() => {
    if (focusIdx >= 0 && gridRef.current) {
      (gridRef.current.children[focusIdx] as HTMLElement | undefined)?.scrollIntoView({
        block: "nearest",
      });
    }
  }, [focusIdx]);

  function onGridKey(e: React.KeyboardEvent) {
    const n = filtered.length;
    if (n === 0) return;
    let idx = focusIdx < 0 ? 0 : focusIdx;
    let moved = true;
    switch (e.key) {
      case "ArrowRight":
        idx = Math.min(n - 1, idx + 1);
        break;
      case "ArrowLeft":
        idx = Math.max(0, idx - 1);
        break;
      case "ArrowDown":
        idx = Math.min(n - 1, idx + COLS);
        break;
      case "ArrowUp":
        idx = Math.max(0, idx - COLS);
        break;
      case "Enter":
      case " ": {
        const a = filtered[idx];
        if (a) launch(a);
        return;
      }
      default:
        moved = false;
    }
    if (moved) {
      e.preventDefault();
      setFocusIdx(idx);
    }
  }

  const existingPaths = new Set(shortcuts.map((s) => s.path.toLowerCase()));

  function addShortcut(a: { name: string; path: string; source?: string; kind: string }) {
    const entry: Shortcut = { name: a.name, path: a.path, source: a.source ?? "", kind: a.kind, display_name: null, custom_icon: null, use_desktop_icon: false, steamgrid_icon: null };
    if (existingPaths.has(entry.path.toLowerCase())) return;
    update((s) => ({ ...s, app_shortcuts: [...s.app_shortcuts, entry] }));
  }
  function removeShortcut(path: string) {
    update((s) => ({ ...s, app_shortcuts: s.app_shortcuts.filter((x) => x.path !== path) }));
  }
  function setCustomIcon(path: string, value: string | null) {
    update((s) => ({
      ...s,
      app_shortcuts: s.app_shortcuts.map((x) => (x.path === path ? { ...x, custom_icon: value } : x)),
    }));
  }
  async function pickCustomIcon(a: Shortcut) {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "ico", "bmp", "gif"] }],
    });
    if (typeof picked === "string" && picked) {
      // Copy into the `.icons` cache so the icon survives the source file moving.
      const local = await invoke<string | null>("import_app_icon", { src: picked }).catch(
        () => null,
      );
      setCustomIcon(a.path, local ?? picked);
    }
  }
  async function applyClipboardIcon(a: Shortcut) {
    const local = await invoke<string | null>("clipboard_icon_import").catch((e) => {
      setToast(`Clipboard: ${e}`);
      return null;
    });
    if (local) {
      setCustomIcon(a.path, local);
      setToast("Icon copied from clipboard");
    }
  }
  // Clipboard is probed before the menu opens so the action is grayed out when
  // there's nothing usable (no text / empty / files-only). preventDefault must
  // happen synchronously to keep the native context menu away during the await.
  async function openAppMenu(e: React.MouseEvent, a: Shortcut) {
    e.preventDefault();
    e.stopPropagation();
    const hint = await invoke<string>("clipboard_icon_hint").catch(() => "none");
    ctx.open(e, [
      {
        icon: <PencilSimple size={14} weight="bold" />,
        label: "Rename…",
        onClick: () => setRenameApp(a),
      },
      {
        icon: <MagnifyingGlass size={14} weight="bold" />,
        label: "Search SteamGridDB",
        onClick: () => setSgApp(a),
      },
      { icon: <Image size={14} weight="bold" />, label: "Use Custom Icon", onClick: () => pickCustomIcon(a) },
      {
        icon: <ClipboardText size={14} weight="bold" />,
        label: "Copy From Clipboard",
        disabled: hint === "none",
        onClick: () => applyClipboardIcon(a),
      },
      ...(a.custom_icon
        ? [{ label: "Clear custom icon", onClick: () => setCustomIcon(a.path, null) }]
        : []),
      {
        icon: <ArrowClockwise size={14} weight="bold" />,
        label: "Use Desktop Icon",
        onClick: () => {
          setUseDesktopIcon(a.path, true);
          refreshIcon(a);
        },
      },
      { label: "Remove", danger: true, onClick: () => removeShortcut(a.path) },
    ]);
  }
  function refreshIcon(a: Shortcut) {
    iconCache.delete(a.path);
    void invoke("clear_cached_icon", { path: a.path });
    setBust((b) => b + 1);
  }
  function setUseDesktopIcon(path: string, v: boolean) {
    update((s) => ({
      ...s,
      app_shortcuts: s.app_shortcuts.map((x) => (x.path === path ? { ...x, use_desktop_icon: v } : x)),
    }));
  }
  function setSteamgridIcon(path: string, url: string | null) {
    update((s) => ({
      ...s,
      app_shortcuts: s.app_shortcuts.map((x) =>
        x.path === path ? { ...x, steamgrid_icon: url, use_desktop_icon: false } : x,
      ),
    }));
  }
  function setDisplayName(path: string, value: string) {
    const d = value.trim();
    update((s) => ({
      ...s,
      app_shortcuts: s.app_shortcuts.map((x) =>
        x.path === path ? { ...x, display_name: d ? d : null } : x,
      ),
    }));
  }
  async function launch(a: Shortcut) {
    try {
      await invoke("launch_app", { path: a.path, kind: a.kind || "exe" });
    } catch {
      // ignore launch errors
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? shortcuts.filter((a) => `${labelOf(a)} ${a.source}`.toLowerCase().includes(q))
    : shortcuts;

  // One-time migration: localize legacy steamgrid URLs and out-of-cache custom
  // files into the `.icons` cache so they're stable and offline-safe.
  useEffect(() => {
    for (const a of shortcuts) {
      if (a.steamgrid_icon && a.steamgrid_icon.startsWith("http")) {
        void invoke<string | null>("cache_steamgrid_icon", { url: a.steamgrid_icon }).then(
          (p) => {
            if (p) setSteamgridIcon(a.path, p);
          },
        );
      } else if (a.custom_icon && !/\.icons[\\/]/.test(a.custom_icon)) {
        void invoke<string | null>("import_app_icon", { src: a.custom_icon }).then((p) => {
          if (p && p !== a.custom_icon) setCustomIcon(a.path, p);
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortcuts]);

  return (
    <>
      <PageShell
        title="Apps"
        subtitle="Your curated apps. Click to launch."
        actions={
          <div className="flex items-center gap-2">
            <div className="w-56">
              <Input
                icon={<MagnifyingGlass size={16} weight="bold" />}
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="Search apps…"
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
              Use the Add button to pick something from the installed list or browse to an .exe.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-(--color-muted)">No apps match “{query}”.</div>
        ) : (
          <div
          ref={gridRef}
          tabIndex={-1}
          onKeyDown={onGridKey}
          className="grid grid-cols-4 gap-4 outline-none sm:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8"
        >
          <AnimatePresence>
            {filtered.map((a, i) => (
              <AppTile
                key={a.path}
                name={labelOf(a)}
                path={a.path}
                customIcon={a.custom_icon}
                steamgridIcon={a.steamgrid_icon}
                useDesktopIcon={a.use_desktop_icon}
                bust={bust}
                focused={i === focusIdx}
                onLaunch={() => launch(a)}
                onContextMenu={(e) => openAppMenu(e, a)}
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

      <SteamGridModal app={sgApp} onClose={() => setSgApp(null)} onSetIcon={setSteamgridIcon} />

      <RenameModal shortcut={renameApp} onClose={() => setRenameApp(null)} onSave={setDisplayName} />

      <Toast message={toast} />
    </>
  );
}