import { DICTATION_MODES, type DictationMode } from "@openbot/contracts/ipc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";

const LABELS: Record<DictationMode, "settings.dictation.mode.paste" | "settings.dictation.mode.copy"> = {
  paste: "settings.dictation.mode.paste",
  copy: "settings.dictation.mode.copy",
};

/** What the transcript does when the recording ends: pasted into the app, or left on the clipboard. */
export function DictationModeSelect(props: {
  value: DictationMode;
  onChange: (mode: DictationMode) => void;
  mount?: HTMLElement | undefined;
}): JSX.Element {
  const { t } = useText();
  return (
    <Select<DictationMode>
      class="settings-modal-select"
      options={[...DICTATION_MODES]}
      value={props.value}
      onChange={(mode) => mode && props.onChange(mode)}
      placement="bottom-end"
      itemComponent={(itemProps) => <SelectItem item={itemProps.item}>{t(LABELS[itemProps.item.rawValue])}</SelectItem>}
    >
      <SelectTrigger size="sm" aria-label={t("settings.dictation.mode")}>
        <SelectValue<DictationMode>>{(state) => t(LABELS[state.selectedOption()])}</SelectValue>
      </SelectTrigger>
      <SelectContent mount={props.mount} />
    </Select>
  );
}
