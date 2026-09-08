import { invoke } from "@tauri-apps/api/core";
import {
  ArrowsOut,
  X,
  Power,
  Moon,
  ArrowClockwise,
  Prohibit,
} from "@phosphor-icons/react";
import { Modal } from "./ui/Modal";

interface PowerMenuProps {
  open: boolean;
  onClose: () => void;
}

function MenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-base font-medium transition-colors ${
        danger
          ? "text-(--color-danger) hover:bg-(--color-danger)/10"
          : "text-(--color-text) hover:bg-(--color-surface)"
      }`}
    >
      <span className="text-current">{icon}</span>
      {label}
    </button>
  );
}

function Divider() {
  return <div className="mx-4 my-1.5 h-px bg-(--color-border)" />;
}

export function PowerMenu({ open, onClose }: PowerMenuProps) {
  async function run(command: string, payload?: Record<string, unknown>) {
    try {
      await invoke(command, payload);
      onClose();
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Power" width="max-w-xs">
      <div className="space-y-1">
        <MenuItem
          icon={<ArrowsOut size={18} weight="bold" />}
          label="Fullscreen"
          onClick={() => run("toggle_fullscreen")}
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

        <Divider />

        <MenuItem
          icon={<Prohibit size={18} weight="bold" />}
          label="Cancel"
          onClick={onClose}
        />
      </div>
    </Modal>
  );
}