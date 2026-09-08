import { SquaresFour, Monitor, Gear } from "@phosphor-icons/react";

export type View = "apps" | "moonlight" | "settings";

const items: { id: View; label: string; nav: "left" | "right"; icon: View }[] = [
  { id: "apps", label: "Apps", nav: "left", icon: "apps" },
  { id: "moonlight", label: "Moonlight", nav: "left", icon: "moonlight" },
  { id: "settings", label: "Settings", nav: "right", icon: "settings" },
];

function Icon({ name }: { name: View }) {
  const props = { size: 24, weight: "fill" as const };
  switch (name) {
    case "apps":
      return <SquaresFour {...props} />;
    case "moonlight":
      return <Monitor {...props} />;
    case "settings":
      return <Gear {...props} />;
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
  const leftItems = items.filter((i) => i.nav === "left");
  const rightItems = items.filter((i) => i.nav === "right");

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-(--color-border) bg-(--color-surface)/60 px-4">
      <nav className="flex items-center gap-1">
        {leftItems.map((item) => (
          <TopBarButton key={item.id} item={item} view={view} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="ml-auto" />

      <nav className="flex items-center gap-1">
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
  item: { id: View; label: string; icon: View };
  view: View;
  onNavigate: (v: View) => void;
}) {
  const active = view === item.id;
  return (
    <button
      onClick={() => onNavigate(item.id)}
      title={item.label}
      aria-label={item.label}
      className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
        active
          ? "bg-(--color-accent)/20 text-(--color-accent)"
          : "text-(--color-muted) hover:text-(--color-text)"
      }`}
    >
      <Icon name={item.icon} />
    </button>
  );
}
