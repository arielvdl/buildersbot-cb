import { isDictationAccelerator } from "@openbot/contracts/ipc";
import { Input } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal } from "solid-js";

/**
 * The combination of a global dictation, taken from the keyboard rather than typed.
 *
 * A press with a modifier fills the field, so the user never has to spell Electron's names. The
 * field holds the focus until a valid combination arrives, and shows what the keys mean.
 */
export function DictationKeyField(props: {
  value: string;
  disabled?: boolean;
  onChange: (accelerator: string) => void;
}) {
  const text = useText();
  const [capturing, setCapturing] = createSignal(false);
  let field!: HTMLInputElement;

  function name(key: string): string | null {
    if (/^Key[A-Z]$/u.test(key)) return key.slice(3);
    if (/^Digit\d$/u.test(key)) return key.slice(5);
    if (/^F([1-9]|1\d|2[0-4])$/u.test(key)) return key;
    const named: Record<string, string> = {
      Space: "Space",
      Tab: "Tab",
      Backspace: "Backspace",
      Delete: "Delete",
      Insert: "Insert",
      Enter: "Return",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      NumpadAdd: "Plus",
      NumpadSubtract: "numsub",
      NumpadMultiply: "nummult",
      NumpadDivide: "numdiv",
      NumpadDecimal: "numdec",
    };
    if (/^Numpad\d$/u.test(key)) return `num${key.slice(6)}`;
    return named[key] ?? null;
  }

  function take(event: KeyboardEvent): void {
    if (props.disabled) return;
    event.preventDefault();
    if (event.key === "Escape") {
      setCapturing(false);
      field.blur();
      return;
    }
    const parts: string[] = [];
    if (event.metaKey) parts.push("Command");
    if (event.ctrlKey) parts.push("Control");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    const key = name(event.code);
    // A modifier on its own is half a combination: wait for the key that follows.
    if (!key) {
      setCapturing(true);
      return;
    }
    const accelerator = [...parts, key].join("+");
    if (!isDictationAccelerator(accelerator)) {
      setCapturing(true);
      return;
    }
    setCapturing(false);
    props.onChange(accelerator);
    field.blur();
  }

  const shown = () =>
    props.value
      .replace("CommandOrControl", "⌘/Ctrl")
      .replace("Command", "⌘")
      .replace("Control", "Ctrl")
      .replace("Alt", "Alt")
      .replace("Shift", "⇧")
      .replaceAll("+", " + ");

  // The field takes a combination, not text, so it plays no keystroke cue.
  return (
    <Input
      ref={field}
      class="dictation-key"
      data-cuelume-type={undefined}
      data-capturing={capturing() ? "" : undefined}
      readonly
      disabled={props.disabled}
      value={capturing() ? text.t("settings.dictation.press") : shown()}
      aria-label={text.t("settings.dictation.key")}
      onFocus={() => void setCapturing(true)}
      onBlur={() => void setCapturing(false)}
      onKeyDown={take}
    />
  );
}
