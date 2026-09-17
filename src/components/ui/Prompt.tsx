import { useEffect, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { Input } from "./Input";
import { Button } from "./Button";

interface PromptProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Initial text in the input; re-asserted each time the modal opens. */
  initial: string;
  placeholder?: string;
  hint?: ReactNode;
  /**
   * Validate the trimmed input. Returning `null` (or any non-`string`) submits;
   * returning a string shows it as an error and disables the apply button.
   */
  validate?: (value: string) => string | null;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  /** Bootstrap max-width class; defaults to "max-w-sm" since this is a one-field form. */
  width?: string;
}

/**
 * Reusable single-field prompt modal. Used for the Moonlight streaming "pencil"
 * custom values (resolution / FPS / bitrate) and the app-rename modal — both
 * were open-coded copies of this same shape.
 */
export function Prompt({
  open,
  onClose,
  title,
  subtitle,
  initial,
  placeholder,
  hint,
  validate,
  submitLabel = "Apply",
  onSubmit,
  width = "max-w-sm",
}: PromptProps) {
  const [val, setVal] = useState(initial);
  useEffect(() => {
    if (open) setVal(initial);
  }, [open, initial]);

  const trimmed = val.trim();
  const error = trimmed && validate ? validate(trimmed) : null;
  const disabled = !trimmed || !!error;

  function submit() {
    if (disabled) return;
    onSubmit(trimmed);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={subtitle} width={width}>
      <Input
        value={val}
        onChange={(e) => setVal(e.currentTarget.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={placeholder}
      />
      {error ? (
        <p className="mt-2 text-xs text-(--color-danger)">{error}</p>
      ) : hint ? (
        <p className="mt-2 text-xs text-(--color-muted)">{hint}</p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="lg" onClick={onClose} className="px-4 font-normal">
          Cancel
        </Button>
        <Button size="lg" onClick={submit} disabled={disabled}>
          {submitLabel}
        </Button>
      </div>
    </Modal>
  );
}
