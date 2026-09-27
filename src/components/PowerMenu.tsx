import { Fragment } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./ui/Modal";
import { powerItems, type PowerItemId } from "./ui/powerItems";

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

  // Rows come from the shared definition; this context supplies the actions.
  const actions: Record<PowerItemId, () => void> = {
    fullscreen: onToggleFullscreen,
    immersive: onToggleImmersive,
    close: () => void run("close_app"),
    sleep: () => void run("system_power", { action: "sleep" }),
    reboot: () => void run("system_power", { action: "reboot" }),
    shutdown: () => void run("system_power", { action: "shutdown" }),
  };

  return (
    <Modal open={open} onClose={onClose} title="Power">
      <div className="space-y-1">
        {powerItems({ variant: "launcher", immersive, fullscreen }).map((item) => (
          <Fragment key={item.id}>
            <MenuItem
              icon={item.icon}
              label={item.label}
              danger={item.danger}
              onClick={actions[item.id]}
            />
            {item.dividerAfter && <Divider />}
          </Fragment>
        ))}
      </div>
    </Modal>
  );
}
