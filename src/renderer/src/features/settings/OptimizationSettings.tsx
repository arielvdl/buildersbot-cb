import { OPTIMIZATION_IDS, type OptimizationChange, type OptimizationId } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SettingsSection,
  SwitchField,
} from "@openbot/ui";
import { currentText, useText } from "@openbot/ui/text";
import { createStore, For, onSettled } from "solid-js";
import { actionToast } from "../../action-toast";
import { settingsPort } from "./settings-port";

/** The name and the plain words of each switch: what it changes, and its risk. */
const OPTIMIZATION_TEXT = {
  "queue-priority-user": {
    title: "settings.optimizations.queuePriorityUser.title",
    description: "settings.optimizations.queuePriorityUser.description",
  },
  "idle-release-low": {
    title: "settings.optimizations.idleReleaseLow.title",
    description: "settings.optimizations.idleReleaseLow.description",
  },
  "fiscal-resume-grace": {
    title: "settings.optimizations.fiscalResumeGrace.title",
    description: "settings.optimizations.fiscalResumeGrace.description",
  },
  "turn-start-unify": {
    title: "settings.optimizations.turnStartUnify.title",
    description: "settings.optimizations.turnStartUnify.description",
  },
  "channel-context-spill": {
    title: "settings.optimizations.channelContextSpill.title",
    description: "settings.optimizations.channelContextSpill.description",
  },
  "safe-resume": {
    title: "settings.optimizations.safeResume.title",
    description: "settings.optimizations.safeResume.description",
  },
  routing: {
    title: "settings.optimizations.routing.title",
    description: "settings.optimizations.routing.description",
  },
  "streaming-checkpoints": {
    title: "settings.optimizations.streamingCheckpoints.title",
    description: "settings.optimizations.streamingCheckpoints.description",
  },
} as const satisfies Record<OptimizationId, { title: AppTextKey; description: AppTextKey }>;

interface OptimizationSettingsState {
  /** The switches that are on. Null until main answers. */
  on: OptimizationId[] | null;
  /** A change waits for main. */
  busy: boolean;
}

/**
 * Settings › General › Advanced optimizations (beta). One switch for each optimization of this computer,
 * each one off until the person turns it on, and two buttons that turn all of them on or off. Main owns
 * the file; this section reads it when it opens and shows the answer of each change.
 */
export function OptimizationSettings() {
  const { t } = useText();
  const [state, setState] = createStore<OptimizationSettingsState>({ on: null, busy: false });

  onSettled(() => {
    settingsPort()
      .getOptimizations()
      .then((answer) =>
        setState((draft) => {
          draft.on = answer.on;
        }),
      )
      .catch(() => undefined);
  });

  function change(changes: OptimizationChange[]): void {
    setState((draft) => {
      draft.busy = true;
    });
    settingsPort()
      .setOptimizations({ changes })
      .then((answer) =>
        setState((draft) => {
          draft.on = answer.on;
        }),
      )
      .catch((error: unknown) => {
        const text = currentText();
        actionToast.error(text.errorMessage(error, text.t("settings.preferences.saveFailed")), {
          id: "settings-optimizations-failed",
          report: { operation: "settings", source: "action", cause_code: "unknown" },
        });
      })
      .finally(() =>
        setState((draft) => {
          draft.busy = false;
        }),
      );
  }

  const isOn = (id: OptimizationId) => state.on?.includes(id) === true;
  const locked = () => state.on === null || state.busy;
  const setAll = (enabled: boolean) => change(OPTIMIZATION_IDS.map((id) => ({ id, enabled })));

  return (
    <SettingsSection title={t("settings.optimizations.section")}>
      <ItemGroup class="settings-modal-card">
        <Item data-settings-row="settings.optimizations.title" class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{t("settings.optimizations.title")}</ItemTitle>
            <ItemDescription>{t("settings.optimizations.description")}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button type="button" variant="outline" size="sm" disabled={locked()} onClick={() => setAll(true)}>
              {t("settings.optimizations.allOn")}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={locked()} onClick={() => setAll(false)}>
              {t("settings.optimizations.allOff")}
            </Button>
          </ItemActions>
        </Item>
        <For each={OPTIMIZATION_IDS}>
          {(id) => (
            <SwitchField
              checked={isOn(id)}
              disabled={locked()}
              onChange={(checked) => change([{ id, enabled: checked }])}
              label={t(OPTIMIZATION_TEXT[id].title)}
              description={t(OPTIMIZATION_TEXT[id].description)}
            />
          )}
        </For>
      </ItemGroup>
    </SettingsSection>
  );
}
