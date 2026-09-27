import type { ReactNode } from "react";
import {
  ArrowClockwise,
  ArrowsIn,
  ArrowsOut,
  GameController,
  Moon,
  Power,
  X,
} from "@phosphor-icons/react";

export type PowerItemId =
  | "fullscreen"
  | "immersive"
  | "close"
  | "sleep"
  | "reboot"
  | "shutdown";

export interface PowerItem {
  id: PowerItemId;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  /** draw a separator rule under this row */
  dividerAfter?: boolean;
}

/**
 * The shared Power rows. Two variants off one definition, so the launcher's
 * modal (`components/PowerMenu.tsx`) and the in-stream overlay's Power view
 * (`ui/StreamMenu.tsx`) can't drift for the rows they have in common:
 *
 * - `"launcher"` — the TopBar modal's full set: the window toggle (unless
 *   immersive), the Immersive toggle, Close Moonblast, then the system rows.
 *   Its window row's label + icon name the state you would switch *to*.
 * - `"overlay"` — the in-stream Power view, deliberately **system rows only**
 *   (Sleep / Reboot / Shutdown): everything else would act on the hidden
 *   launcher window, or — for Immersive — minimise the stream itself.
 *
 * Each caller maps `id` onto its own action: the launcher drives window state it
 * already owns, the overlay invokes the same Rust commands.
 */
export function powerItems(opts: {
  variant: "launcher" | "overlay";
  fullscreen?: boolean;
  immersive?: boolean;
}): PowerItem[] {
  const { variant, fullscreen = false, immersive = false } = opts;
  const items: PowerItem[] = [];

  if (variant === "launcher") {
    if (!immersive) {
      items.push({
        id: "fullscreen",
        label: fullscreen ? "Windowed" : "Fullscreen",
        icon: fullscreen ? (
          <ArrowsIn size={18} weight="bold" />
        ) : (
          <ArrowsOut size={18} weight="bold" />
        ),
      });
    }
    items.push({
      id: "immersive",
      label: immersive ? "Exit Immersive Mode" : "Immersive Mode",
      icon: <GameController size={18} weight="bold" />,
    });
    items.push({
      id: "close",
      label: "Close Moonblast",
      icon: <X size={18} weight="bold" />,
      dividerAfter: true,
    });
  }

  items.push({ id: "sleep", label: "Sleep", icon: <Moon size={18} weight="bold" /> });
  items.push({
    id: "reboot",
    label: "Reboot",
    icon: <ArrowClockwise size={18} weight="bold" />,
  });
  items.push({
    id: "shutdown",
    label: "Shutdown",
    icon: <Power size={18} weight="bold" />,
    danger: true,
  });

  return items;
}
