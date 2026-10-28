import { currentText } from "@openbot/ui/text";
import { Show } from "solid-js";
import { createGlobalDictation, dictationState, dictationText } from "./global-dictation";

/**
 * The bar of a global dictation. It sits over the bottom of the window, where the composer is, so
 * the recording is visible in the app that had the focus before the combination was pressed.
 *
 * The combination works while this window is hidden too: the bar is the feedback when it is not.
 */
export function DictationOverlay() {
  createGlobalDictation();
  return (
    <Show when={dictationState().phase !== "idle"}>
      <div class="dictation-bar" role="status" aria-live="polite" data-phase={dictationState().phase}>
        <span class="dictation-dot" aria-hidden="true" />
        <span class="dictation-text">{dictationText(dictationState())}</span>
        <Show when={dictationState().phase === "recording"}>
          <kbd class="dictation-hint">{currentText().t("app.dictation.stop")}</kbd>
        </Show>
      </div>
    </Show>
  );
}
