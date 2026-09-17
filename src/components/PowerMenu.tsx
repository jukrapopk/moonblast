import { invoke } from "@tauri-apps/api/core";
import {
  ArrowsOut,
  ArrowsIn,
  X,
  Power,
  Moon,
  ArrowClockwise,
  GameController,
} from "@phosphor-icons/react";
import { Modal } from "./ui/Modal";

interface PowerMenuProps {
  open: boolean;
  onClose: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  immersive: boolean;
  onToggleImmersive: () => void;
}

function MenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-base font-medium transition-colors ${
        danger
          ? "text-(--color-danger) focus-visible:bg-(--color-danger)/10"
          : "text-(--color-text) focus-visible:bg-(--color-surface)"
      }`}
    >
      {icon && (
        <span className="flex w-5 shrink-0 items-center justify-center text-current">
          {icon}
        </span>
      )}
      {label}
    </button>
  );
}

function Divider() {
  return <div className="mx-4 my-1.5 h-px bg-(--color-border)" />;
}

export function PowerMenu({
  open,
  onClose,
  fullscreen,
  onToggleFullscreen,
  immersive,
  onToggleImmersive,
}: PowerMenuProps) {
  async function run(command: string, payload?: Record<string, unknown>) {
    try {
      await invoke(command, payload);
      onClose();
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Power">
      <div className="space-y-1">
        {!immersive && (
          <MenuItem
            icon={fullscreen ? <ArrowsIn size={18} weight="bold" /> : <ArrowsOut size={18} weight="bold" />}
            label={fullscreen ? "Windowed" : "Fullscreen"}
            onClick={onToggleFullscreen}
          />
        )}
        <MenuItem
          icon={<GameController size={18} weight="bold" />}
          label={immersive ? "Exit Immersive Mode" : "Immersive Mode"}
          onClick={onToggleImmersive}
        />
        <MenuItem
          icon={<X size={18} weight="bold" />}
          label="Close Moonblast"
          onClick={() => run("close_app")}
        />

        <Divider />

        <MenuItem
          icon={<Moon size={18} weight="bold" />}
          label="Sleep"
          onClick={() => run("system_power", { action: "sleep" })}
        />
        <MenuItem
          icon={<ArrowClockwise size={18} weight="bold" />}
          label="Reboot"
          onClick={() => run("system_power", { action: "reboot" })}
        />
        <MenuItem
          icon={<Power size={18} weight="bold" />}
          label="Shutdown"
          danger
          onClick={() => run("system_power", { action: "shutdown" })}
        />
      </div>
    </Modal>
  );
}