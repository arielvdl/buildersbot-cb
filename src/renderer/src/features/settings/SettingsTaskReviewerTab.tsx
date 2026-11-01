import {
  type AutoRecoveryPreference,
  DEFAULT_TASK_WATCH_PREFERENCE,
  type LoadSnapshot,
  TASK_WATCH_MAX_MINUTES,
  TASK_WATCH_MIN_MINUTES,
  type TaskWatchEvent,
  type TaskWatchPreference,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
  Info,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
  SwitchField,
} from "@openbot/ui";
import { taskWatchEventText } from "@openbot/ui/features/window/load-view";
import { useText } from "@openbot/ui/text";
import { For, Show } from "solid-js";
import { guardModelKey, guardModelName, type SettingsGuardStore } from "./settings-guard-store";

/**
 * What the page reads and changes: the load of this computer, from the same store as the ring of the
 * rail. A change here shows in the load panel at once, and the other way round.
 */
export interface TaskReviewerLoad {
  snapshot: () => LoadSnapshot | null;
  setTaskWatch: (preference: TaskWatchPreference) => Promise<void>;
  setRecovery: (preference: AutoRecoveryPreference) => Promise<void>;
}

/** The thresholds that the list offers. The saved value is added when the load panel set another one. */
const QUIET_CHOICES = [5, 10, 15, 20, 30, 45, 60, 90, 120] as const;

function quietChoices(current: number): number[] {
  const choices = new Set<number>(QUIET_CHOICES);
  if (current >= TASK_WATCH_MIN_MINUTES && current <= TASK_WATCH_MAX_MINUTES) choices.add(current);
  return [...choices].sort((left, right) => left - right);
}

/** The points of "What it does", in the order of the reviewer's tries. */
const DOES = [
  ["settings.taskReviewer.does.resume.title", "settings.taskReviewer.does.resume.description"],
  ["settings.taskReviewer.does.requeue.title", "settings.taskReviewer.does.requeue.description"],
  ["settings.taskReviewer.does.reassign.title", "settings.taskReviewer.does.reassign.description"],
  ["settings.taskReviewer.does.giveUp.title", "settings.taskReviewer.does.giveUp.description"],
] as const satisfies ReadonlyArray<readonly [AppTextKey, AppTextKey]>;

const DOES_NOT = [
  "settings.taskReviewer.doesNot.stopped",
  "settings.taskReviewer.doesNot.waiting",
  "settings.taskReviewer.doesNot.memory",
  "settings.taskReviewer.doesNot.start",
  "settings.taskReviewer.doesNot.chat",
  "settings.taskReviewer.doesNot.send",
] as const satisfies ReadonlyArray<AppTextKey>;

/** The newest action first. */
function newestFirst(events: readonly TaskWatchEvent[]): TaskWatchEvent[] {
  return [...events].sort((left, right) => (Date.parse(right.at) || 0) - (Date.parse(left.at) || 0));
}

/**
 * Settings › Task reviewer ("Fiscal" in Portuguese): the switch, the minutes before a task counts as
 * stopped, the model that it asks (the review model of the Guard) and whether that model runs now, the
 * two switches of the load panel that it follows, its last actions, and what it does and does not do.
 * The task reviewer runs on this computer, so a joined server gets a note that its own reviewer is not
 * changed here.
 */
export function SettingsTaskReviewerTab(props: {
  load: TaskReviewerLoad;
  guard: SettingsGuardStore;
  /** The name of the joined server that the window shows, or null while this computer is active. */
  joinedServer: string | null;
  selectMount: HTMLElement | undefined;
  onOpenGuard: () => void;
  /** Opens the load panel of the rail. Absent while the rail does not show it. */
  onOpenLoadPanel: (() => void) | undefined;
}) {
  const { t, format } = useText();
  const snapshot = () => props.load.snapshot();
  const watch = () => snapshot()?.taskWatch ?? null;
  const recovery = () => snapshot()?.recovery ?? null;
  const busy = () => snapshot() === null;
  const quietMinutes = () => watch()?.quietMinutes ?? DEFAULT_TASK_WATCH_PREFERENCE.quietMinutes;

  const setWatch = (patch: Partial<TaskWatchPreference>) => {
    const current = watch();
    if (!current) return;
    void props.load.setTaskWatch({ enabled: current.enabled, quietMinutes: current.quietMinutes, ...patch });
  };
  const setRecovery = (patch: Partial<AutoRecoveryPreference>) => {
    const current = recovery();
    if (!current) return;
    void props.load.setRecovery({
      enabled: current.enabled,
      intervalMinutes: current.intervalMinutes,
      reassign: current.reassign,
      ...patch,
    });
  };

  const stateText = () => {
    const current = watch();
    if (!current) return t("settings.taskReviewer.state.loading");
    if (!current.enabled) return t("settings.taskReviewer.state.off");
    return current.active ? t("settings.taskReviewer.state.active") : t("settings.taskReviewer.state.waiting");
  };
  const quietLabel = (minutes: number | undefined) => {
    if (minutes === undefined) return "";
    return minutes === DEFAULT_TASK_WATCH_PREFERENCE.quietMinutes
      ? t("settings.taskReviewer.quiet.suggested", { minutes })
      : t("settings.taskReviewer.quiet.value", { minutes });
  };
  const modelText = () => {
    const guard = props.guard.state.guard;
    if (!guard) return null;
    // Only the model choice of the Guard counts here, not its level: the reviewer asks it also with the Guard off.
    const judge = guard.preference.judge;
    if (judge === null) return t("settings.taskReviewer.model.localOnly");
    const row = props.guard.rows().find((candidate) => candidate.key === guardModelKey(judge));
    const model = guardModelName(row, t);
    // The reading of the load says what the reviewer sees; before it, the Guard's own state.
    const ready = watch()?.modelReady ?? guard.judgeReady;
    return ready
      ? t("settings.taskReviewer.model.ready", { model })
      : t("settings.taskReviewer.model.notReady", { model });
  };
  const recent = () => newestFirst(watch()?.recent ?? []);

  return (
    <>
      <Show when={props.joinedServer}>
        {(server) => (
          <Alert tone="neutral" role="status">
            <AlertIcon>
              <Info aria-hidden="true" />
            </AlertIcon>
            <AlertContent>
              <AlertTitle>{t("settings.thisComputerOnly.title")}</AlertTitle>
              <AlertDescription>{t("settings.taskReviewer.joined.description", { server: server() })}</AlertDescription>
            </AlertContent>
          </Alert>
        )}
      </Show>
      <SettingsSection title={t("settings.taskReviewer.section.title")}>
        <ItemGroup class="settings-modal-card">
          <SwitchField
            data-settings-row="settings.taskReviewer.enabled.title"
            checked={watch()?.enabled ?? false}
            disabled={busy()}
            onChange={(enabled) => setWatch({ enabled })}
            label={t("settings.taskReviewer.enabled.title")}
            description={t("settings.taskReviewer.enabled.description")}
          />
          <Item class="settings-modal-row" data-settings-row-skip="status of the task reviewer">
            <ItemContent>
              <ItemTitle>{t("settings.taskReviewer.state.title")}</ItemTitle>
              <ItemDescription>{stateText()}</ItemDescription>
            </ItemContent>
            <Show when={watch()?.enabled && recovery()?.enabled === false}>
              <ItemActions>
                <Button type="button" variant="outline" size="sm" onClick={() => setRecovery({ enabled: true })}>
                  {t("settings.taskReviewer.state.turnOnRecovery")}
                </Button>
              </ItemActions>
            </Show>
          </Item>
          <Item data-settings-row="settings.taskReviewer.quiet.title" class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{t("settings.taskReviewer.quiet.title")}</ItemTitle>
              <ItemDescription>{t("settings.taskReviewer.quiet.description")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Select<number>
                class="settings-modal-select"
                options={quietChoices(quietMinutes())}
                value={quietMinutes()}
                disabled={busy()}
                onChange={(minutes) => {
                  if (minutes !== null && minutes !== quietMinutes()) setWatch({ quietMinutes: minutes });
                }}
                placement="bottom-end"
                itemComponent={(itemProps) => (
                  <SelectItem item={itemProps.item}>{quietLabel(itemProps.item.rawValue)}</SelectItem>
                )}
              >
                <SelectTrigger size="sm" aria-label={t("settings.taskReviewer.quiet.title")}>
                  <SelectValue<number>>{(state) => quietLabel(state.selectedOption())}</SelectValue>
                </SelectTrigger>
                <SelectContent mount={props.selectMount} />
              </Select>
            </ItemActions>
          </Item>
          <Item data-settings-row="settings.taskReviewer.model.title" class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{t("settings.taskReviewer.model.title")}</ItemTitle>
              <ItemDescription>{t("settings.taskReviewer.model.description")}</ItemDescription>
              <Show when={modelText()}>{(text) => <ItemDescription>{text()}</ItemDescription>}</Show>
            </ItemContent>
            <ItemActions>
              <Button type="button" variant="outline" size="sm" onClick={() => props.onOpenGuard()}>
                {t("settings.taskReviewer.model.openGuard")}
              </Button>
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsSection>

      <SettingsSection
        title={t("settings.taskReviewer.load.title")}
        description={t("settings.taskReviewer.load.description")}
      >
        <ItemGroup class="settings-modal-card">
          <SwitchField
            data-settings-row="app.rail.load.recoveryTitle"
            checked={recovery()?.enabled ?? false}
            disabled={busy()}
            onChange={(enabled) => setRecovery({ enabled })}
            label={t("app.rail.load.recoveryTitle")}
            description={t("settings.taskReviewer.recovery.description", {
              minutes: recovery()?.intervalMinutes ?? 0,
            })}
          />
          <SwitchField
            data-settings-row="app.rail.load.recoveryReassign"
            checked={recovery()?.reassign ?? false}
            disabled={busy()}
            onChange={(reassign) => setRecovery({ reassign })}
            label={t("app.rail.load.recoveryReassign")}
            description={t("settings.taskReviewer.reassign.description")}
          />
          <Item data-settings-row="settings.loadPanel.title" class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{t("settings.loadPanel.title")}</ItemTitle>
              <ItemDescription>
                {props.onOpenLoadPanel ? t("settings.loadPanel.description") : t("settings.loadPanel.unavailable")}
              </ItemDescription>
            </ItemContent>
            <Show when={props.onOpenLoadPanel}>
              {(open) => (
                <ItemActions>
                  <Button type="button" variant="outline" size="sm" onClick={() => open()()}>
                    {t("common.open")}
                  </Button>
                </ItemActions>
              )}
            </Show>
          </Item>
        </ItemGroup>
      </SettingsSection>

      <SettingsSection title={t("settings.taskReviewer.recent.title")}>
        <ItemGroup class="settings-modal-card" data-settings-row="settings.taskReviewer.recent.title">
          <For
            each={recent()}
            keyed={(event) => `${event.at}:${event.action}:${event.channelName}`}
            fallback={
              <Item size="compact">
                <ItemContent>
                  <ItemDescription>{t("settings.taskReviewer.recent.empty")}</ItemDescription>
                </ItemContent>
              </Item>
            }
          >
            {(event) => (
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemTitle>{taskWatchEventText(event(), t)}</ItemTitle>
                  <ItemDescription>
                    {t("settings.taskReviewer.recent.meta", {
                      time: format.date(Date.parse(event().at) || 0, { dateStyle: "short", timeStyle: "short" }),
                      decider: t(event().by === "model" ? "app.rail.load.watchByModel" : "app.rail.load.watchByLocal"),
                    })}
                  </ItemDescription>
                </ItemContent>
              </Item>
            )}
          </For>
        </ItemGroup>
      </SettingsSection>

      <SettingsSection title={t("settings.taskReviewer.does.title")}>
        <ItemGroup class="settings-modal-card" data-settings-row="settings.taskReviewer.does.title">
          <For each={DOES}>
            {([title, description]) => (
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemTitle>{t(title)}</ItemTitle>
                  <ItemDescription>{t(description)}</ItemDescription>
                </ItemContent>
              </Item>
            )}
          </For>
        </ItemGroup>
      </SettingsSection>

      <SettingsSection title={t("settings.taskReviewer.doesNot.title")}>
        <ItemGroup class="settings-modal-card" data-settings-row="settings.taskReviewer.doesNot.title">
          <For each={DOES_NOT}>
            {(line) => (
              // A line of text with no control or title: the compact row.
              <Item size="compact">
                <ItemContent>
                  <ItemDescription>{t(line)}</ItemDescription>
                </ItemContent>
              </Item>
            )}
          </For>
        </ItemGroup>
      </SettingsSection>
    </>
  );
}
