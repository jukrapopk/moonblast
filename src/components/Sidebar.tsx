export type View = "home" | "library" | "settings";

const items: { id: View; label: string; icon: string }[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "library", label: "Library", icon: "library" },
  { id: "settings", label: "Settings", icon: "settings" },
];

function Icon({ name }: { name: string }) {
  // Minimal inline SVG icons (no external icon dependency needed)
  switch (name) {
    case "home":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
          <path d="M3 10.5 12 3l9 7.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 9.5V21h14V9.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 21v-6h6v6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "library":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
          <rect x="4" y="4" width="7" height="7" rx="1.5" />
          <rect x="13" y="4" width="7" height="7" rx="1.5" />
          <rect x="4" y="13" width="7" height="7" rx="1.5" />
          <rect x="13" y="13" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "settings":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
        </svg>
      );
    default:
      return null;
  }
}

export function Sidebar({
  view,
  onNavigate,
}: {
  view: View;
  onNavigate: (v: View) => void;
}) {
  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-(--color-border) bg-(--color-surface)/60 px-3 py-5">
      <div className="mb-8 flex items-center gap-2.5 px-2">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-xl text-white shadow-lg"
          style={{ background: "linear-gradient(135deg,#7c6cff,#23d8c6)" }}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
            <path d="M12 2l1.9 5.6a2 2 0 0 0 1.19 1.19L20.7 10l-5.61 1.9a2 2 0 0 0-1.19 1.19L12 18.7l-1.9-5.61a2 2 0 0 0-1.19-1.19L3.3 10l5.61-1.9a2 2 0 0 0 1.19-1.19L12 2z" />
          </svg>
        </div>
        <span className="text-lg font-semibold tracking-tight">Moonblast</span>
      </div>

      <nav className="flex flex-col gap-1">
        {items.map((item) => {
          const active = view === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-(--color-accent)/15 text-(--color-text)"
                  : "text-(--color-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)"
              }`}
            >
              <span className={active ? "text-(--color-accent)" : ""}>
                <Icon name={item.icon} />
              </span>
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto px-2 text-xs text-(--color-muted)">v0.1.0 · Step 1</div>
    </aside>
  );
}
