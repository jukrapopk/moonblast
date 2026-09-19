import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { MagnifyingGlass, Plus, FolderOpen, Image, ArrowClockwise, PencilSimple, ClipboardText, CheckFat, DotsSixVertical } from "@phosphor-icons/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PageShell } from "./PageShell";
import { Modal } from "./ui/Modal";
import { Prompt } from "./ui/Prompt";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { useContextMenu } from "./ui/ContextMenu";
import { Toast, useToast } from "./ui/Toast";
import { Input } from "./ui/Input";
import { FilterList } from "./ui/FilterList";
import { LoadingChip } from "./ui/LoadingChip";
import { EmptyMessage } from "./ui/EmptyMessage";
import { gradientFor } from "./ui/gradients";
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
  auto_launch: boolean; // launch at sign-in when auto_immersive boots the shell stub
}

/** Effective display label: display_name overrides the original name. */
const labelOf = (s: { name: string; display_name: string | null }) => s.display_name || s.name;

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
  reorderMode,
  onLaunch,
  onContextMenu,
}: {
  name: string;
  path: string;
  customIcon: string | null;
  steamgridIcon: string | null;
  useDesktopIcon: boolean;
  bust: number;
  reorderMode: boolean;
  onLaunch: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  // dnd-kit sortable bindings. `attributes` exposes the ARIA
  // attributes the library expects on a draggable (role, tabindex,
  // aria-roledescription, etc.). `listeners` is the bag of pointer
  // / keyboard event handlers — spread onto the button so press /
  // drag activate from anywhere on the tile. `setNodeRef` attaches
  // the DOM ref dnd-kit uses to measure the tile's geometry. The
  // library is no-op when reorderMode is off (`disabled` flag), so
  // the listeners don't interfere with normal launch clicks.
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: path,
    disabled: !reorderMode,
  });

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

  // The tile is a `<button>` so the LRUD spatial library picks it up
  // natively (it scans `button` / `input` / `[tabindex]` / `a`). The
  // outer `<motion.div>` is for the entry/exit animation only — it
  // isn't itself focusable and isn't marked `lrud-ignore` because the
  // library's "ignore if contained in" rule would filter out its
  // child button.
  return (
    <motion.div
      ref={setNodeRef}
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.15 }}
      // `transform` from useSortable positions the tile while it's
      // being dragged or when its slot is animating. `transition` is
      // the CSS transition string for the post-drop settle (a brief
      // ease-out so tiles slide into place rather than teleport).
      // `CSS.Transform.toString` is the helper dnd-kit ships for
      // serializing the typed transform value to a CSS string.
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      // `data-context-menu` marks the element as having an
      // `onContextMenu` handler. The App-level "Back/Refresh" fallback
      // (src/App.tsx) checks for this attribute on the event target's
      // ancestor chain so it can step out of the way when an
      // element-specific menu is registered — otherwise right-click
      // (and the Shift+F10 / ContextMenu-key shortcut) would always
      // land on the generic menu instead of the focused element's
      // actual actions.
      data-context-menu
      // While a drag is active, fade the source tile so the user sees
      // the held content via the DragOverlay instead — same visual
      // as desktop file managers when you grab an icon.
      className={`group ${isDragging ? "opacity-40" : ""}`}
      onContextMenu={onContextMenu}
    >
      <button
        // The dnd-kit listeners override the button's own click while
        // reorder mode is on: pointerdown + small movement starts a
        // drag (PointerSensor activation distance). When the user
        // releases without moving (a real click on the tile), the
        // drag never activates and the native click fires — but only
        // when reorder mode is off. In reorder mode we explicitly
        // suppress launch so a click is treated as a no-op (the user
        // is supposed to drag, not click); they can still launch via
        // Done → click tile. Keyboard activation is gated on
        // reorderMode by the parent: we drop listeners when reorder
        // is off, and the keyboard sensor intercepts Space / Enter
        // when on.
        onClick={reorderMode ? undefined : onLaunch}
        // Spread dnd-kit's listeners + ARIA attributes onto the
        // button. `{...listeners}` includes the onPointerDown that
        // starts the drag (after the activation distance is met) and
        // the keyboard handler for Space / Enter pickup-and-drop.
        {...listeners}
        {...attributes}
        aria-label={name}
        className={`relative block w-full overflow-hidden rounded-2xl p-3 outline-none transition-all duration-150 focus-visible:bg-(--color-accent-soft) focus-visible:shadow-[0_12px_32px_-12px_var(--color-overlay)] ${reorderMode ? "cursor-grab active:cursor-grabbing" : ""}`}
      >
        <div
          className={`relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-md text-3xl font-semibold text-(--color-text) transition-transform group-focus-visible:scale-[1.04]`}
          style={icon ? undefined : { background: gradientFor(name) }}
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

/* --------------------------- drag overlay ---------------------------- */

/**
 * Tile rendered inside the `<DragOverlay>` while a drag is in flight.
 * Mirrors the visual of an AppTile (icon + label, rounded-2xl) so
 * the held content matches what the user just grabbed. The overlay
 * is positioned by dnd-kit at the pointer (mouse) or focused slot
 * (keyboard) — we don't manage its transform here.
 */
function DragOverlayTile({ shortcut, bust }: { shortcut: Shortcut; bust: number }) {
  const hasOverride = !!(shortcut.custom_icon || shortcut.steamgrid_icon);
  const forceDesktop = shortcut.use_desktop_icon && !hasOverride;
  const fetchedIcon = useAppIcon(
    labelOf(shortcut),
    shortcut.path,
    bust,
    forceDesktop,
    hasOverride,
  );
  const steamgridSrc = shortcut.steamgrid_icon
    ? shortcut.steamgrid_icon.startsWith("http")
      ? shortcut.steamgrid_icon
      : convertFileSrc(shortcut.steamgrid_icon)
    : null;
  const icon = shortcut.custom_icon
    ? convertFileSrc(shortcut.custom_icon)
    : (steamgridSrc ?? fetchedIcon);
  const name = labelOf(shortcut);
  return (
    <div className="rounded-2xl border border-(--color-accent) bg-(--color-surface) p-3 shadow-[0_20px_50px_-12px_var(--color-overlay)]">
      <div
        className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-md text-3xl font-semibold text-(--color-text)"
        style={icon ? undefined : { background: gradientFor(name) }}
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
    </div>
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
  const [installed, setInstalled] = useState<AppEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setInstalled([]);
    setLoading(true);
    invoke<AppEntry[]>("discover_apps")
      .then(setInstalled)
      .catch(() => setInstalled([]))
      .finally(() => setLoading(false));
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
    <Modal open={open} onClose={onClose} title="Add app" subtitle="Pick an installed app or browse to one. Some apps won't launch in Immersive Mode." width="max-w-lg">
      <FilterList
        items={installed}
        loading={loading}
        options={{
          getKey: (a) => a.path,
          getLabel: (a) => a.name,
          getSource: (a) => a.source ?? "",
          exclude: (a) => existingPaths.has(a.path),
        }}
        searchPlaceholder="Search installed apps"
        empty={<p className="py-8 text-center text-sm text-(--color-muted)">Nothing to add</p>}
        loadingPlaceholder={
          <div className="flex items-center justify-center py-6">
            <LoadingChip label="Loading apps" variant="plain" />
          </div>
        }
        headerAction={
          <Button
            variant="outline"
            size="md"
            onClick={browse}
            icon={<FolderOpen size={14} weight="bold" />}
            className="h-10 px-4"
          >
            Browse
          </Button>
        }
        render={(a) => (
          <button
            onClick={() => pick(a)}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-(--color-text) transition-colors focus:bg-(--color-surface) focus:outline-none"
          >
            <span className="truncate font-medium">{a.name}</span>
            {a.source && (
              <span className="ml-auto shrink-0 text-xs text-(--color-muted)">{a.source}</span>
            )}
          </button>
        )}
      />
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
      initialFocus="button"
    >
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search by name or game id"
          />
        </div>
        <Button
          variant="outline-accent"
          size="md"
          onClick={search}
          disabled={!query.trim() || busy}
          className="px-4 py-1.5"
        >
          Search
        </Button>
      </div>

      {error && <p className="mt-2 text-sm text-(--color-danger)">{error}</p>}

      {selected ? (
        <div className="mt-3">
          <button
            onClick={() => {
              setSelected(null);
              setIcons([]);
            }}
            className="text-xs text-(--color-muted) transition focus-visible:text-(--color-text)"
          >
            ← back to results
          </button>
          <div className="lrud-container mt-2 grid max-h-64 grid-cols-4 gap-2 overflow-y-auto p-1">
            {icons.length === 0 && !busy ? (
              <p className="col-span-full py-6 text-center text-sm text-(--color-muted)">
                No icons for "{selected.name}"
              </p>
            ) : (
              icons.map((ic) => (
                <button
                  key={ic.id}
                  onClick={() => choose(ic)}
                  className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface) transition focus:border-(--color-accent) focus:outline-none"
                >
                  <img src={ic.url} alt="" loading="lazy" className="h-full w-full object-contain" />
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="mt-3 max-h-64 space-y-1 overflow-y-auto p-1">
          {titles.length === 0 && !busy ? (
            <EmptyMessage>Type a query to find a title.</EmptyMessage>
          ) : (
            titles.map((t) => (
              <button
                key={t.id}
                onClick={() => pickTitle(t)}
                className="w-full rounded-lg px-3 py-2 text-left text-sm text-(--color-text) transition-colors focus:bg-(--color-surface) focus:outline-none"
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
            className="text-sm text-(--color-danger) transition focus-visible:underline"
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
  return (
    <Prompt
      open={!!shortcut}
      onClose={onClose}
      title="Rename app"
      subtitle={shortcut ? `Original: ${shortcut.name}` : ""}
      initial={shortcut?.display_name ?? ""}
      placeholder={shortcut?.name ?? "…"}
      submitLabel="Save"
      hint="Leave empty to use the original name."
      onSubmit={(v) => shortcut && onSave(shortcut.path, v)}
    />
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
  const { message: toast, show: setToast } = useToast(2600);

  // Reorder mode — toggled by the header "Reorder" button. While
  // on, dnd-kit's drag sensors are enabled (PointerSensor for mouse,
  // KeyboardSensor for keyboard / gamepad). Off by default so a
  // plain click on a tile launches the app without any activation
  // distance to wait out.
  const [reorderMode, setReorderMode] = useState(false);
  // The shortcut currently being dragged (for the DragOverlay's
  // floating preview). Null when nothing is held.
  const [activeDragShortcut, setActiveDragShortcut] = useState<Shortcut | null>(null);

  // PointerSensor activation constraint: 5px of movement before a
  // press counts as a drag. Without this, the simple "press and
  // release" would start a drag and steal the click — clicking a
  // tile in reorder mode would silently do nothing instead of
  // dropping on it. 5px is short enough that a real drag still feels
  // instant but long enough to keep clicks clicks.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // KeyboardSensor with `sortableKeyboardCoordinates` gives the
    // standard accessible behaviour out of the box: Space / Enter
    // picks up, arrow keys move the focused indicator through the
    // grid, Space / Enter again drops, Escape cancels. Gamepad A
    // synthesises Enter via the gamepad adapter, so it routes
    // through this sensor automatically.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart(event: DragStartEvent) {
    const path = String(event.active.id);
    const found = shortcuts.find((s) => s.path === path);
    setActiveDragShortcut(found ?? null);
  }

  // On drop: move the dragged tile to the hovered position. With
  // `rectSortingStrategy` (configured on SortableContext below),
  // dnd-kit shifts non-active items aside while you drag — the
  // user sees the held content slide through the grid as tiles
  // animate out of its way, then settle into the new order on
  // drop. `arrayMove` does the array splice (removes from old
  // index, inserts at new index, shifting items in between).
  function handleDragEnd(event: DragEndEvent) {
    setActiveDragShortcut(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    update((s) => {
      const oldIndex = s.app_shortcuts.findIndex((x) => x.path === active.id);
      const newIndex = s.app_shortcuts.findIndex((x) => x.path === over.id);
      if (oldIndex < 0 || newIndex < 0) return s;
      return { ...s, app_shortcuts: arrayMove(s.app_shortcuts, oldIndex, newIndex) };
    });
  }

  function handleDragCancel() {
    setActiveDragShortcut(null);
  }

  const existingPaths = new Set(shortcuts.map((s) => s.path.toLowerCase()));

  function addShortcut(a: { name: string; path: string; source?: string; kind: string }) {
    const entry: Shortcut = { name: a.name, path: a.path, source: a.source ?? "", kind: a.kind, display_name: null, custom_icon: null, use_desktop_icon: false, steamgrid_icon: null, auto_launch: false };
    if (existingPaths.has(entry.path.toLowerCase())) return;
    update((s) => ({ ...s, app_shortcuts: [...s.app_shortcuts, entry] }));
  }
  function removeShortcut(path: string) {
    update((s) => ({ ...s, app_shortcuts: s.app_shortcuts.filter((x) => x.path !== path) }));
  }

  // Patch a single field on the shortcut whose `path` matches. Centralizes
  // the `app_shortcuts.map(...)` walk so every per-field setter below stays
  // a one-liner.
  function updateShortcut(path: string, patch: Partial<Shortcut>) {
    update((s) => ({
      ...s,
      app_shortcuts: s.app_shortcuts.map((x) => (x.path === path ? { ...x, ...patch } : x)),
    }));
  }
  const setCustomIcon = (path: string, value: string | null) => updateShortcut(path, { custom_icon: value });
  const setUseDesktopIcon = (path: string, v: boolean) => updateShortcut(path, { use_desktop_icon: v });
  const setAutoLaunch = (path: string, v: boolean) => updateShortcut(path, { auto_launch: v });
  // Picking a SteamGridDB icon implicitly reverts to the SGDB-served
  // artwork, so the "use desktop icon" override must drop.
  const setSteamgridIcon = (path: string, url: string | null) =>
    updateShortcut(path, { steamgrid_icon: url, use_desktop_icon: false });
  // An empty rename clears the override and falls back to the original
  // `name`.
  const setDisplayName = (path: string, value: string) => {
    const d = value.trim();
    updateShortcut(path, { display_name: d ? d : null });
  };
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
        label: "Rename",
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
        label: "Paste From Clipboard",
        disabled: hint === "none",
        onClick: () => applyClipboardIcon(a),
      },
      ...(a.custom_icon
        ? [{ label: "Clear Custom Icon", onClick: () => setCustomIcon(a.path, null) }]
        : []),
      {
        icon: <ArrowClockwise size={14} weight="bold" />,
        label: "Use Desktop Icon",
        onClick: () => {
          setUseDesktopIcon(a.path, true);
          refreshIcon(a);
        },
      },
      ...(settings.fullscreen.auto_immersive
        ? [
            {
              // When toggled on, a filled `CheckFat` (fill weight) confirms
              // the intent; when off, no icon — keeps the row visually
              // identical to other menu items. 16px gives presence against
              // the long label. Hidden entirely when Auto Immersive Mode is
              // off because the toggle is a no-op then (the shell stub
              // never fires).
              icon: a.auto_launch ? <CheckFat size={16} weight="fill" /> : null,
              label: "Launch with Immersive Mode",
              onClick: () => setAutoLaunch(a.path, !a.auto_launch),
            },
          ]
        : []),
      { label: "Remove", danger: true, onClick: () => removeShortcut(a.path) },
    ]);
  }
  function refreshIcon(a: Shortcut) {
    iconCache.delete(a.path);
    void invoke("clear_cached_icon", { path: a.path });
    setBust((b) => b + 1);
  }
  async function launch(a: Shortcut) {
    try {
      await invoke("launch_app", { path: a.path, kind: a.kind || "exe" });
    } catch (e) {
      // Surface launch failures (Store / ms-settings URIs under Immersive Mode
      // return a "needs desktop shell" message from the Rust side). The
      // previous `// ignore launch errors` made launches look frozen when
      // they were just silently failing. `String(e)` matches the rest of
      // the codebase's IPC-error extraction.
      setToast(String(e));
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? shortcuts.filter((a) => `${labelOf(a)} ${a.source}`.toLowerCase().includes(q))
    : shortcuts;

  // One-time migration: localize legacy steamgrid URLs and out-of-cache custom
  // files into the `.icons` cache so they're stable and offline-safe.
  useEffect(() => {
    // Migrate legacy shortcut icon refs (HTTP SteamGridDB URLs and
    // out-of-tree custom paths) into the local .icons/ cache. The
    // `alive` flag prevents in-flight invokes from writing settings
    // after the view unmounts (which would no-op via React but burn
    // an IPC round-trip per migration).
    let alive = true;
    for (const a of shortcuts) {
      if (a.steamgrid_icon && a.steamgrid_icon.startsWith("http")) {
        const path = a.path;
        const url = a.steamgrid_icon;
        void invoke<string | null>("cache_steamgrid_icon", { url }).then((p) => {
          if (alive && p) setSteamgridIcon(path, p);
        });
      } else if (a.custom_icon && !/\.icons[\\/]/.test(a.custom_icon)) {
        const path = a.path;
        const src = a.custom_icon;
        void invoke<string | null>("import_app_icon", { src }).then((p) => {
          if (alive && p && p !== src) setCustomIcon(path, p);
        });
      }
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortcuts]);

  return (
    <>
      <PageShell
        title="Apps"
        subtitle="Shortcuts to your apps and games."
        actions={
          <div className="flex items-center gap-2">
            {/* Search input is mouse-only — `tabIndex={-1}` removes it
             *  from the spatial-nav focusable list AND from native Tab
             *  traversal, so the LRUD library can't get stuck trying
             *  to find Left/Right candidates from inside a text input.
             *  The user can still click into it and type; mouse works
             *  exactly like before. */}
            <div className="w-56">
              <Input
                icon={<MagnifyingGlass size={16} weight="bold" />}
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="Search apps"
              />
            </div>
            <Button
              // Reorder toggle. While active, dnd-kit's sensors are
              // enabled on every tile (PointerSensor + KeyboardSensor)
              // and the user can drag / keyboard-pickup to swap.
              // Outline by default, switches to filled (primary)
              // while active so the mode is obvious at a glance.
              // Disabled when there are fewer than 2 apps — nothing
              // to swap.
              variant={reorderMode ? "primary" : "outline"}
              onClick={() => setReorderMode((on) => !on)}
              icon={<DotsSixVertical size={16} weight="bold" />}
              className="h-9 px-4"
              disabled={shortcuts.length < 2}
            >
              {reorderMode ? "Done" : "Reorder"}
            </Button>
            <Button
              onClick={() => setAddOpen(true)}
              icon={<Plus size={16} weight="bold" />}
              className="h-9 px-4"
            >
              Add
            </Button>
          </div>
        }
      >
        {shortcuts.length === 0 ? (
          <Card dashed className="p-12 text-center">
            <p className="text-(--color-muted)">No apps yet</p>
            <p className="mt-1 text-sm text-(--color-muted)/70">
              Use Add to pick an installed app or browse to one.
            </p>
          </Card>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-(--color-muted)">No apps match "{query}"</div>
        ) : (
          <>
            {/* DndContext wraps the sortable grid. sensors is built once
             *  via useSensors at the top of the component and is the
             *  source of truth for which input devices drive drag.
             *  `closestCenter` is the right collision strategy for a
             *  variable-column grid (4/5/6/8 cols at different
             *  breakpoints): a tile is "over" when the cursor / focus
             *  indicator is nearest its center. Announcements are off
             *  by default; the project doesn't ship a live region and
             *  a screen-reader user would hear raw dnd-kit strings
             *  ("Draggable item Notepad") which isn't useful here.
             *
             *  The DragOverlay renders the active shortcut at the
             *  cursor (mouse) or at the focused slot (keyboard) while
             *  a drag is in flight, so the user always sees what
             *  they're holding regardless of input modality. */}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              {/* `lrud-container` opts the grid into the LRUD library:
               *  arrows stay scoped to the tiles, and the last-focused
               *  tile is remembered via `data-focus` so coming back
               *  to the view restores focus to that tile. */}
              <SortableContext
                items={filtered.map((a) => a.path)}
                strategy={rectSortingStrategy}
              >
                <div className="lrud-container grid grid-cols-4 gap-4 sm:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
                  <AnimatePresence>
                    {filtered.map((a) => (
                      <AppTile
                        key={a.path}
                        name={labelOf(a)}
                        path={a.path}
                        customIcon={a.custom_icon}
                        steamgridIcon={a.steamgrid_icon}
                        useDesktopIcon={a.use_desktop_icon}
                        bust={bust}
                        reorderMode={reorderMode}
                        onLaunch={() => launch(a)}
                        onContextMenu={(e) => openAppMenu(e, a)}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </SortableContext>
              {/* Floating preview. Renders the held shortcut at the
               *  cursor / focus while a drag is active. The overlay
               *  doesn't participate in the SortableContext (it
               *  doesn't have an id), so it doesn't accidentally
               *  register as a drop target. dropAnimation null is
               *  fine — the source tile's CSS transform animates
               *  back into place via the transition returned by
               *  useSortable. */}
              <DragOverlay dropAnimation={null}>
                {activeDragShortcut && <DragOverlayTile shortcut={activeDragShortcut} bust={bust} />}
              </DragOverlay>
            </DndContext>
          </>
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
