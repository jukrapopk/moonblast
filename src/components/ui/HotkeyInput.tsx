import { useEffect, useRef, useState } from "react";

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "OS"]);

/**
 * Build a canonical shortcut string from a keydown, or `null` when the press
 * isn't a usable shortcut (a bare modifier, a modifier-less key, or an unknown
 * key). Enforces the same rules `overlay.rs::parse_hotkey` does: at least one
 * modifier, and Ctrl+Alt+Shift is reserved by Moonlight.
 */
function canonicalFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Win");

  const key = e.key;
  if (MODIFIER_KEYS.has(key)) return null;

  let name: string | null = null;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) {
    name = key;
  } else if (/^[a-zA-Z0-9]$/.test(key)) {
    name = key.toUpperCase();
  } else {
    const map: Record<string, string> = {
      " ": "Space",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Enter: "Enter",
      Tab: "Tab",
      Backspace: "Backspace",
      Delete: "Delete",
      Insert: "Insert",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      "-": "Minus",
      "=": "Equal",
      ",": "Comma",
      ".": "Period",
      "/": "Slash",
      "\\": "Backslash",
      ";": "Semicolon",
      "'": "Quote",
      "[": "BracketLeft",
      "]": "BracketRight",
      "`": "Grave",
    };
    name = map[key] ?? null;
  }
  if (!name) return null;
  if (mods.length === 0) return null;
  if (e.ctrlKey && e.altKey && e.shiftKey) return null;
  return [...mods, name].join("+");
}

/**
 * Click-to-record shortcut field. Renders a button showing the current spec;
 * clicking it swaps to a capturing input that reads the next chord. The value
 * is written verbatim — persistence + Rust re-registration happen through the
 * normal settings flow.
 */
export function HotkeyInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (spec: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (recording) inputRef.current?.focus();
  }, [recording]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setRecording(false);
      setError(null);
      return;
    }
    // Let native Tab traversal move on without capturing it.
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      setRecording(false);
      setError(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const spec = canonicalFromEvent(e.nativeEvent);
    if (spec) {
      onChange(spec);
      setRecording(false);
      setError(null);
      requestAnimationFrame(() => buttonRef.current?.focus());
    } else if (!MODIFIER_KEYS.has(e.key)) {
      setError("Add a modifier; Ctrl+Alt+Shift is reserved.");
    }
  }

  if (recording) {
    return (
      <input
        ref={inputRef}
        readOnly
        value=""
        onKeyDown={onKeyDown}
        onBlur={() => {
          setRecording(false);
          setError(null);
        }}
        placeholder={error ?? "Press a shortcut…"}
        className="h-10 w-56 rounded-full border border-(--color-accent) bg-(--color-surface-2) px-4 text-center text-sm text-(--color-text) placeholder:text-(--color-muted) outline-none"
      />
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => {
        setError(null);
        setRecording(true);
      }}
      title="Click, then press the shortcut"
      className="h-10 shrink-0 rounded-full border border-(--color-border) bg-(--color-surface-2) px-4 text-sm font-medium tabular-nums text-(--color-text) transition hover:border-(--color-accent) focus-visible:border-(--color-accent)"
    >
      {value || "Set shortcut"}
    </button>
  );
}
