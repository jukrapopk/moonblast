export type View = "home" | "library" | "settings";

const items: { id: View; label: string; icon: string }[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "library", label: "Library", icon: "library" },
  { id: "settings", label: "Settings", icon: "settings" },
];

function Icon({ name }: { name: string }) {
  switch (name) {
    case "home":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4.5 w-4.5">
          <path d="M3 10.5 12 3l9 7.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 9.5V21h14V9.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 21v-6h6v6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "library":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4.5 w-4.5">
          <rect x="4" y="4" width="7" height="7" rx="1.5" />
          <rect x="13" y="4" width="7" height="7" rx="1.5" />
          <rect x="4" y="13" width="7" height="7" rx="1.5" />
          <rect x="13" y="13" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "settings":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4.5 w-4.5">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
        </svg>
      );
    default:
      return null;
  }
}

export function TopBar({
  view,
  onNavigate,
}: {
  view: View;
  onNavigate: (v: View) => void;
}) {
  const leftItems = items.filter((i) => i.id !== "settings");
  const rightItems = items.filter((i) => i.id === "settings");

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-(--color-border) bg-(--color-surface)/60 px-4">
      <nav className="flex items-center gap-1 rounded-full bg-(--color-surface-2)/70 p-1">
        {leftItems.map((item) => (
          <TopBarButton key={item.id} item={item} view={view} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="ml-auto" />

      <nav className="flex items-center gap-1 rounded-full bg-(--color-surface-2)/70 p-1">
        {rightItems.map((item) => (
          <TopBarButton key={item.id} item={item} view={view} onNavigate={onNavigate} />
        ))}
      </nav>
    </header>
  );
}

function TopBarButton({
  item,
  view,
  onNavigate,
}: {
  item: { id: View; label: string; icon: string };
  view: View;
  onNavigate: (v: View) => void;
}) {
  const active = view === item.id;
  return (
    <button
      onClick={() => onNavigate(item.id)}
      title={item.label}
      aria-label={item.label}
      className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
        active
          ? "bg-(--color-accent)/25 text-(--color-text)"
          : "text-(--color-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)"
      }`}
    >
      <span className={active ? "text-(--color-accent)" : ""}>
        <Icon name={item.icon} />
      </span>
    </button>
  );
}
