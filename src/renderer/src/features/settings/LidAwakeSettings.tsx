import {
  LID_AWAKE_BATTERY_FLOORS,
  LID_AWAKE_MODES,
  LID_AWAKE_TIME_LIMITS,
  type LidAwakeBatteryFloor,
  type LidAwakeMode,
  type LidAwakeStatus,
  type LidAwakeTimeLimit,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@openbot/ui";
import { currentText, useText } from "@openbot/ui/text";
import { createStore, onSettled, Show } from "solid-js";
import { actionToast } from "../../action-toast";
import { settingsPort } from "./settings-port";

const MODE_OPTIONS = [...LID_AWAKE_MODES];
const FLOOR_OPTIONS = [...LID_AWAKE_BATTERY_FLOORS];
const TIME_LIMIT_OPTIONS = [...LID_AWAKE_TIME_LIMITS];

const MODE_LABELS = {
  off: "settings.lidAwake.mode.off",
  plugged: "settings.lidAwake.mode.plugged",
  battery: "settings.lidAwake.mode.battery",
} as const satisfies Record<LidAwakeMode, AppTextKey>;

interface LidAwakeSettingsState {
  /** Null until main answers. */
  status: LidAwakeStatus | null;
  /** An action waits for main, or for the administrator password. */
  busy: boolean;
}

function showFailure(error: unknown, fallback: AppTextKey): void {
  const { t, errorMessage } = currentText();
  actionToast.error(errorMessage(error, t(fallback)), {
    id: "settings-lid-awake-failed",
    report: { operation: "settings", source: "action", cause_code: "unknown" },
  });
}

/**
 * Settings › General › With the lid closed. The keep-awake switch above it stops only the idle sleep;
 * this mode keeps a Mac laptop on with its lid closed. Main owns the mode and sends each change of
 * its state, so this panel only shows the status and asks for changes.
 */
export function LidAwakeSettings(props: { selectMount: HTMLElement | undefined }) {
  const { t, format } = useText();
  const [state, setState] = createStore<LidAwakeSettingsState>({ status: null, busy: false });

  onSettled(() => {
    const unsubscribe = settingsPort().lidAwake.onStatus((status) =>
      setState((draft) => {
        draft.status = status;
      }),
    );
    settingsPort()
      .lidAwake.getStatus()
      .then((status) =>
        setState((draft) => {
          draft.status = status;
        }),
      )
      .catch(() => undefined);
    return unsubscribe;
  });

  function run(action: () => Promise<LidAwakeStatus>, fallback: AppTextKey): Promise<LidAwakeStatus | null> {
    setState((draft) => {
      draft.busy = true;
    });
    return action()
      .then((status) => {
        setState((draft) => {
          draft.status = status;
        });
        return status;
      })
      .catch((error: unknown) => {
        showFailure(error, fallback);
        return null;
      })
      .finally(() =>
        setState((draft) => {
          draft.busy = false;
        }),
      );
  }

  function changeMode(mode: LidAwakeMode): void {
    void run(() => settingsPort().lidAwake.setPreference({ mode }), "settings.preferences.saveFailed").then(
      (status) => {
        // The battery mode needs the root safety service, and macOS asks for the password now.
        if (status?.preference.mode === "battery" && status.helper !== "installed")
          void run(() => settingsPort().lidAwake.installHelper(), "settings.lidAwake.helper.failed");
      },
    );
  }

  const status = () => state.status;
  const supported = () => state.status?.supported === true;
  const mode = () => state.status?.preference.mode ?? "off";
  const modeLabel = (value: LidAwakeMode | undefined) => (value ? t(MODE_LABELS[value]) : "");
  const floorLabel = (value: LidAwakeBatteryFloor | undefined) =>
    value === undefined ? "" : format.percent(value / 100);
  const timeLimitLabel = (value: LidAwakeTimeLimit | undefined) => {
    if (value === undefined) return "";
    return value === 0
      ? t("settings.lidAwake.timeLimit.none")
      : t("settings.lidAwake.timeLimit.hours", { count: value });
  };

  const stateText = (current: LidAwakeStatus): string | null => {
    switch (current.state) {
      case "off":
        return null;
      case "active-plugged":
        return t("settings.lidAwake.state.activePlugged");
      case "active-battery":
        return t("settings.lidAwake.state.activeBattery");
      case "paused-on-battery":
        return t("settings.lidAwake.state.pausedOnBattery");
      case "paused-battery-low":
        return t("settings.lidAwake.state.pausedBatteryLow", {
          percent: format.percent(current.preference.batteryFloor / 100),
        });
      case "paused-too-hot":
        return t("settings.lidAwake.state.pausedTooHot");
      case "paused-time-limit":
        return t("settings.lidAwake.state.pausedTimeLimit");
      case "paused-helper-missing":
        return t("settings.lidAwake.state.pausedHelperMissing");
      case "paused-helper-not-confirmed":
        return t("settings.lidAwake.state.pausedHelperNotConfirmed");
      case "failed":
        return t("settings.lidAwake.state.failed");
    }
  };

  const currentStateText = () => {
    const current = state.status;
    return current?.supported ? stateText(current) : null;
  };

  // The mode says that it holds, but the last test saw this Mac sleep with the lid closed.
  const notConfirmed = () => {
    const current = state.status;
    return (
      current?.supported === true &&
      (current.state === "active-plugged" || current.state === "active-battery") &&
      current.test?.verdict === "slept"
    );
  };

  const testText = (current: LidAwakeStatus): string | null => {
    const test = current.test;
    if (!test) return null;
    switch (test.verdict) {
      case "running":
        return t("settings.lidAwake.test.running");
      case "stayed-awake":
        return t("settings.lidAwake.test.stayedAwake", { count: Math.max(1, Math.round(test.closedSeconds / 60)) });
      case "slept":
        return t("settings.lidAwake.test.slept");
      case "lid-not-closed":
        return t("settings.lidAwake.test.lidNotClosed");
    }
  };

  const helperText = (current: LidAwakeStatus): string => {
    if (current.helper === "installed") return t("settings.lidAwake.helper.installed");
    if (current.helper === "outdated") return t("settings.lidAwake.helper.outdated");
    if (current.helper === "stopped") return t("settings.lidAwake.helper.stopped");
    return t("settings.lidAwake.helper.missing");
  };

  return (
    <>
      <Item data-settings-row="settings.lidAwake.title" class="settings-modal-row">
        <ItemContent>
          <ItemTitle>{t("settings.lidAwake.title")}</ItemTitle>
          <ItemDescription>{t("settings.lidAwake.description")}</ItemDescription>
          <Show when={state.status && !state.status.supported}>
            <ItemDescription>{t("settings.lidAwake.unsupported")}</ItemDescription>
          </Show>
          <Show when={currentStateText()}>{(text) => <ItemDescription>{text()}</ItemDescription>}</Show>
          <Show when={notConfirmed()}>
            <ItemDescription>{t("settings.lidAwake.state.notConfirmed")}</ItemDescription>
          </Show>
          <Show when={supported() && mode() !== "off"}>
            <ItemDescription>{t("settings.lidAwake.warning")}</ItemDescription>
          </Show>
        </ItemContent>
        <ItemActions>
          <Select<LidAwakeMode>
            class="settings-modal-select"
            options={MODE_OPTIONS}
            value={mode()}
            disabled={!supported() || state.busy}
            onChange={(value) => value && value !== mode() && changeMode(value)}
            placement="bottom-end"
            itemComponent={(selectProps) => (
              <SelectItem item={selectProps.item}>{modeLabel(selectProps.item.rawValue)}</SelectItem>
            )}
          >
            <SelectTrigger size="sm" aria-label={t("settings.lidAwake.title")}>
              <SelectValue<LidAwakeMode>>{(selectState) => modeLabel(selectState.selectedOption())}</SelectValue>
            </SelectTrigger>
            <SelectContent mount={props.selectMount} />
          </Select>
        </ItemActions>
      </Item>
      <Show when={supported() && mode() === "battery"}>
        <Item data-settings-row="settings.lidAwake.batteryFloor.title" class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{t("settings.lidAwake.batteryFloor.title")}</ItemTitle>
            <ItemDescription>{t("settings.lidAwake.batteryFloor.description")}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Select<LidAwakeBatteryFloor>
              class="settings-modal-select"
              options={FLOOR_OPTIONS}
              value={state.status?.preference.batteryFloor}
              disabled={state.busy}
              onChange={(value) =>
                value &&
                void run(
                  () => settingsPort().lidAwake.setPreference({ batteryFloor: value }),
                  "settings.preferences.saveFailed",
                )
              }
              placement="bottom-end"
              itemComponent={(selectProps) => (
                <SelectItem item={selectProps.item}>{floorLabel(selectProps.item.rawValue)}</SelectItem>
              )}
            >
              <SelectTrigger size="sm" aria-label={t("settings.lidAwake.batteryFloor.title")}>
                <SelectValue<LidAwakeBatteryFloor>>
                  {(selectState) => floorLabel(selectState.selectedOption())}
                </SelectValue>
              </SelectTrigger>
              <SelectContent mount={props.selectMount} />
            </Select>
          </ItemActions>
        </Item>
      </Show>
      <Show when={supported() && mode() !== "off"}>
        <Item data-settings-row="settings.lidAwake.timeLimit.title" class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{t("settings.lidAwake.timeLimit.title")}</ItemTitle>
            <ItemDescription>{t("settings.lidAwake.timeLimit.description")}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Select<LidAwakeTimeLimit>
              class="settings-modal-select"
              options={TIME_LIMIT_OPTIONS}
              value={state.status?.preference.timeLimitHours}
              disabled={state.busy}
              onChange={(value) =>
                value !== null &&
                void run(
                  () => settingsPort().lidAwake.setPreference({ timeLimitHours: value }),
                  "settings.preferences.saveFailed",
                )
              }
              placement="bottom-end"
              itemComponent={(selectProps) => (
                <SelectItem item={selectProps.item}>{timeLimitLabel(selectProps.item.rawValue)}</SelectItem>
              )}
            >
              <SelectTrigger size="sm" aria-label={t("settings.lidAwake.timeLimit.title")}>
                <SelectValue<LidAwakeTimeLimit>>
                  {(selectState) => timeLimitLabel(selectState.selectedOption())}
                </SelectValue>
              </SelectTrigger>
              <SelectContent mount={props.selectMount} />
            </Select>
          </ItemActions>
        </Item>
      </Show>
      <Show when={supported() && (mode() === "battery" || state.status?.helper !== "missing") ? status() : null}>
        {(current) => (
          <Item data-settings-row-skip="status of the helper" class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{t("settings.lidAwake.helper.title")}</ItemTitle>
              <ItemDescription>{t("settings.lidAwake.helper.description")}</ItemDescription>
              <ItemDescription>{helperText(current())}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Show
                when={current().helper === "installed"}
                fallback={
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={state.busy}
                    onClick={() =>
                      void run(() => settingsPort().lidAwake.installHelper(), "settings.lidAwake.helper.failed")
                    }
                  >
                    {current().helper === "outdated"
                      ? t("settings.lidAwake.helper.update")
                      : t("settings.lidAwake.helper.install")}
                  </Button>
                }
              >
                <Button
                  type="button"
                  size="sm"
                  variant="destructive-ghost"
                  disabled={state.busy}
                  onClick={() =>
                    void run(() => settingsPort().lidAwake.restoreNormalSleep(), "settings.lidAwake.helper.failed")
                  }
                >
                  {t("settings.lidAwake.helper.remove")}
                </Button>
              </Show>
            </ItemActions>
          </Item>
        )}
      </Show>
      <Show when={state.status?.sleepDisabledWithoutGrant}>
        <Item data-settings-row-skip="warning about the sleep state" class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{t("settings.lidAwake.sleepDisabled.title")}</ItemTitle>
            <ItemDescription>{t("settings.lidAwake.sleepDisabled.description")}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={state.busy}
              onClick={() =>
                void run(() => settingsPort().lidAwake.restoreNormalSleep(), "settings.lidAwake.helper.failed")
              }
            >
              {t("settings.lidAwake.sleepDisabled.restore")}
            </Button>
          </ItemActions>
        </Item>
      </Show>
      <Show when={supported() ? status() : null}>
        {(current) => (
          <Item data-settings-row="settings.lidAwake.test.title" class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{t("settings.lidAwake.test.title")}</ItemTitle>
              <ItemDescription>{t("settings.lidAwake.test.description")}</ItemDescription>
              <Show when={testText(current())}>{(text) => <ItemDescription>{text()}</ItemDescription>}</Show>
            </ItemContent>
            <ItemActions>
              <Show
                when={current().test?.verdict === "running"}
                fallback={
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={state.busy}
                    onClick={() => void run(() => settingsPort().lidAwake.startTest(), "settings.lidAwake.test.failed")}
                  >
                    {t("settings.lidAwake.test.start")}
                  </Button>
                }
              >
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={state.busy}
                  onClick={() => void run(() => settingsPort().lidAwake.finishTest(), "settings.lidAwake.test.failed")}
                >
                  {t("settings.lidAwake.test.finish")}
                </Button>
              </Show>
            </ItemActions>
          </Item>
        )}
      </Show>
    </>
  );
}
