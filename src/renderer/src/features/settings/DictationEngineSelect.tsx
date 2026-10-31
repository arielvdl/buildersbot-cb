import { DICTATION_ENGINES, type DictationEngine } from "@openbot/contracts/ipc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";

const LABELS: Record<
  DictationEngine,
  "settings.dictation.engine.auto" | "settings.dictation.engine.system" | "settings.dictation.engine.voice"
> = {
  auto: "settings.dictation.engine.auto",
  system: "settings.dictation.engine.system",
  voice: "settings.dictation.engine.voice",
};

/** What reads the recording: the system recognition, the voice model, or whichever works. */
export function DictationEngineSelect(props: {
  value: DictationEngine;
  onChange: (engine: DictationEngine) => void;
  mount?: HTMLElement | undefined;
}): JSX.Element {
  const { t } = useText();
  return (
    <Select<DictationEngine>
      class="settings-modal-select"
      options={[...DICTATION_ENGINES]}
      value={props.value}
      onChange={(engine) => engine && props.onChange(engine)}
      placement="bottom-end"
      itemComponent={(itemProps) => <SelectItem item={itemProps.item}>{t(LABELS[itemProps.item.rawValue])}</SelectItem>}
    >
      <SelectTrigger size="sm" aria-label={t("settings.dictation.engine")}>
        <SelectValue<DictationEngine>>{(state) => t(LABELS[state.selectedOption()])}</SelectValue>
      </SelectTrigger>
      <SelectContent mount={props.mount} />
    </Select>
  );
}
