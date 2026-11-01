import {
  NATIVE_SOUND_CHOICES,
  RECENT_SOUND_LIMIT,
  type RecentSound,
  SOUND_EVENT_GROUPS,
  SOUND_EVENTS,
  type SoundEventDefinition,
  type SoundEventEntry,
  type SoundEventGroup,
  type SoundEventId,
  type SoundEventPreference,
  type SoundPlayOutcome,
  soundEventPreference,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Badge,
  Button,
  IconButton,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Play,
  RotateCcw,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
  SliderField,
  Switch,
  SwitchField,
  toast,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For, Show } from "solid-js";
import {
  addCustomSound,
  previewSound,
  resetSoundEvent,
  setMuteAll,
  soundCenterOnDesktop,
  soundCenterState,
  updateSoundEvent,
} from "../../sound-center";

const GROUP_TITLE = {
  agents: "settings.sounds.group.agents",
  approvals: "settings.sounds.group.approvals",
  guard: "settings.sounds.group.guard",
  taskReviewer: "settings.sounds.group.taskReviewer",
  tasksAndRoutines: "settings.sounds.group.tasksAndRoutines",
  messages: "settings.sounds.group.messages",
  voice: "settings.sounds.group.voice",
  interface: "settings.sounds.group.interface",
  system: "settings.sounds.group.system",
  remote: "settings.sounds.group.remote",
} as const satisfies Record<SoundEventGroup, AppTextKey>;

const EVENT_TEXT = {
  "agent.reply-finished": [
    "settings.sounds.event.replyFinished.title",
    "settings.sounds.event.replyFinished.description",
  ],
  "agent.run-failed": ["settings.sounds.event.runFailed.title", "settings.sounds.event.runFailed.description"],
  "approval.waiting": [
    "settings.sounds.event.approvalWaiting.title",
    "settings.sounds.event.approvalWaiting.description",
  ],
  "guard.question": ["settings.sounds.event.guardQuestion.title", "settings.sounds.event.guardQuestion.description"],
  "task-reviewer.resumed-work": [
    "settings.sounds.event.reviewerResumedWork.title",
    "settings.sounds.event.reviewerResumedWork.description",
  ],
  "agent.work-finished": ["settings.sounds.event.workFinished.title", "settings.sounds.event.workFinished.description"],
  "routine.finished": [
    "settings.sounds.event.routineFinished.title",
    "settings.sounds.event.routineFinished.description",
  ],
  "notification.workflow": [
    "settings.sounds.event.workflowNotification.title",
    "settings.sounds.event.workflowNotification.description",
  ],
  "notification.agent": [
    "settings.sounds.event.agentNotification.title",
    "settings.sounds.event.agentNotification.description",
  ],
  "notification.channel-reply": [
    "settings.sounds.event.channelReplyNotification.title",
    "settings.sounds.event.channelReplyNotification.description",
  ],
  "voice.limit-warning": [
    "settings.sounds.event.voiceLimitWarning.title",
    "settings.sounds.event.voiceLimitWarning.description",
  ],
  "voice.limit-stop": [
    "settings.sounds.event.voiceLimitStop.title",
    "settings.sounds.event.voiceLimitStop.description",
  ],
  "voice.read-aloud": ["settings.sounds.event.readAloud.title", "settings.sounds.event.readAloud.description"],
  "interface.controls": [
    "settings.sounds.event.interfaceControls.title",
    "settings.sounds.event.interfaceControls.description",
  ],
  "interface.actions": [
    "settings.sounds.event.interfaceActions.title",
    "settings.sounds.event.interfaceActions.description",
  ],
  "notification.usage-limit": [
    "settings.sounds.event.usageLimitNotification.title",
    "settings.sounds.event.usageLimitNotification.description",
  ],
  "notification.machine-alert": [
    "settings.sounds.event.machineAlertNotification.title",
    "settings.sounds.event.machineAlertNotification.description",
  ],
  "notification.system": [
    "settings.sounds.event.systemNotification.title",
    "settings.sounds.event.systemNotification.description",
  ],
  "remote.phone": ["settings.sounds.event.remotePhone.title", "settings.sounds.event.remotePhone.description"],
} as const satisfies Record<SoundEventId, readonly [AppTextKey, AppTextKey]>;

const APP_CHOICE_NAME = {
  none: "settings.sounds.choice.none",
  classic: "settings.soundTheme.classic",
  default: "settings.soundTheme.warm",
  mech: "settings.soundTheme.mech",
  bubble: "settings.soundTheme.bubble",
  press: "settings.soundTheme.press",
  system: "settings.sounds.choice.system",
} as const satisfies Record<string, AppTextKey>;

const OUTCOME_TEXT = {
  played: "settings.sounds.recent.played",
  "event-off": "settings.sounds.recent.eventOff",
  "mute-all": "settings.sounds.recent.muteAll",
  speaking: "settings.sounds.recent.speaking",
  failed: "settings.sounds.recent.failed",
} as const satisfies Record<SoundPlayOutcome, AppTextKey>;

/** The menu value of a custom file: `custom:<id>`. "add" opens the file dialog. */
const ADD_FILE = "add";
const CUSTOM_PREFIX = "custom:";

interface SettingsSoundsSectionProps {
  /** Opens the macOS Notifications page. Absent where the system has no such page. */
  onOpenSystemSettings?: (() => void | Promise<void>) | undefined;
  menuMount?: HTMLElement | undefined;
}

/**
 * Settings › Notifications › Sounds: every sound of the app on this computer, grouped by where it
 * comes from, with "Mute all" at the top and Recent sounds at the end. Nothing plays when the page
 * opens: only the play buttons and the person's own changes play a sound.
 */
export function SettingsSoundsSection(props: SettingsSoundsSectionProps) {
  const { t, format } = useText();
  const state = soundCenterState;
  const desktop = soundCenterOnDesktop();
  const title = (id: SoundEventId) => t(EVENT_TEXT[id][0]);
  const report = (key: "settings.sounds.saveFailed" | "settings.sounds.previewFailed" | "settings.sounds.addFailed") =>
    toast.error(t(key), { report: { operation: "settings", source: "system", cause_code: "unknown" } });
  const save = (change: Promise<void>) => void change.catch(() => report("settings.sounds.saveFailed"));
  const events = (group: SoundEventGroup) => SOUND_EVENTS.filter((event) => event.group === group);

  const choiceName = (definition: SoundEventDefinition, value: string): string => {
    if (value === ADD_FILE) return t("settings.sounds.choice.addFile");
    if (value.startsWith(CUSTOM_PREFIX)) {
      const id = value.slice(CUSTOM_PREFIX.length);
      return state().customSounds.find((sound) => sound.id === id)?.name ?? t("settings.sounds.choice.none");
    }
    if (definition.kind === "native") {
      if (value === "default") return t("settings.sounds.choice.macosDefault");
      if (value === "none") return t("settings.sounds.choice.none");
      // The names of the macOS sounds are names, as System Settings shows them.
      return value;
    }
    const known = Object.entries(APP_CHOICE_NAME).find(([choice]) => choice === value);
    return known ? t(known[1]) : value;
  };

  /** The menu values of an event: its choices, the custom files, and "Add a sound file". */
  const options = (definition: SoundEventDefinition): string[] => {
    const base = definition.choices.filter((choice) => choice !== "custom" && (desktop || choice !== "system"));
    if (definition.kind !== "app" || !definition.choices.includes("custom") || !desktop) return base;
    return [...base, ...state().customSounds.map((sound) => `${CUSTOM_PREFIX}${sound.id}`), ADD_FILE];
  };
  const menuValue = (event: SoundEventPreference) =>
    event.sound === "custom" && event.customSoundId ? `${CUSTOM_PREFIX}${event.customSoundId}` : event.sound;

  const choose = (id: SoundEventId, value: string) => {
    if (value === ADD_FILE) {
      void addCustomSound().then(
        (added) => {
          if (added) save(updateSoundEvent(id, { enabled: true, sound: "custom", customSoundId: added.id }));
        },
        () => report("settings.sounds.addFailed"),
      );
      return;
    }
    if (value.startsWith(CUSTOM_PREFIX))
      save(updateSoundEvent(id, { sound: "custom", customSoundId: value.slice(CUSTOM_PREFIX.length) }));
    else save(updateSoundEvent(id, { sound: value, customSoundId: null }));
  };

  const listen = (id: SoundEventId) => {
    const event = soundEventPreference(state().preference, id);
    void previewSound(id, { ...event, enabled: true }).catch(() => report("settings.sounds.previewFailed"));
  };

  const recentText = (entry: RecentSound) => {
    const time = format.date(new Date(entry.at), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return entry.who ? `${time} · ${t("settings.sounds.recent.who", { who: entry.who })}` : time;
  };

  const SoundRow = (rowProps: { definition: SoundEventEntry }) => {
    const id = rowProps.definition.id;
    const event = () => soundEventPreference(state().preference, id);
    const changed = () => state().preference.events[id] !== undefined;
    return (
      <Item data-settings-row={EVENT_TEXT[id][0]} class="settings-modal-row settings-sound-row">
        <ItemContent>
          <ItemTitle>{title(id)}</ItemTitle>
          <ItemDescription>{t(EVENT_TEXT[id][1])}</ItemDescription>
          <Show when={rowProps.definition.kind === "native"}>
            <ItemDescription>{t("settings.sounds.volumeByMacos")}</ItemDescription>
          </Show>
          <Show when={rowProps.definition.kind === "app"}>
            <SliderField
              class="settings-sound-volume"
              label={t("settings.sounds.volumeFor")}
              value={event().volume}
              minValue={0}
              maxValue={100}
              step={5}
              disabled={!event().enabled || state().preference.muteAll}
              formatValue={(value) => `${value}%`}
              onChangeEnd={(volume) => save(updateSoundEvent(id, { volume }))}
            />
          </Show>
        </ItemContent>
        <ItemActions>
          <Show
            when={rowProps.definition.kind === "app" || rowProps.definition.kind === "native"}
            fallback={
              <Show when={rowProps.definition.kind === "speech"}>
                <Badge variant="outline">{t("settings.sounds.voicePage")}</Badge>
              </Show>
            }
          >
            <Switch
              aria-label={t("settings.sounds.enabled", { name: title(id) })}
              checked={event().enabled}
              onChange={(enabled: boolean) => save(updateSoundEvent(id, { enabled }))}
            />
            <Select<string>
              class="settings-modal-select"
              options={options(rowProps.definition)}
              optionTextValue={(value) => choiceName(rowProps.definition, value)}
              value={menuValue(event())}
              onChange={(value) => value && choose(id, value)}
              placement="bottom-end"
              itemComponent={(itemProps) => (
                <SelectItem item={itemProps.item}>
                  {choiceName(rowProps.definition, itemProps.item.rawValue)}
                </SelectItem>
              )}
            >
              <SelectTrigger size="sm" aria-label={t("settings.sounds.soundFor", { name: title(id) })}>
                <SelectValue<string>>
                  {(select) => choiceName(rowProps.definition, select.selectedOption())}
                </SelectValue>
              </SelectTrigger>
              <SelectContent mount={props.menuMount} />
            </Select>
            <IconButton
              variant="ghost"
              label={t("settings.sounds.preview", { name: title(id) })}
              disabled={event().sound === "none"}
              onClick={() => listen(id)}
            >
              <Play />
            </IconButton>
            <IconButton
              variant="ghost"
              label={t("settings.sounds.resetFor", { name: title(id) })}
              tooltip={t("settings.sounds.reset")}
              disabled={!changed()}
              onClick={() => save(resetSoundEvent(id))}
            >
              <RotateCcw />
            </IconButton>
          </Show>
        </ItemActions>
      </Item>
    );
  };

  return (
    <>
      <SettingsSection
        data-settings-row="settings.sounds.title"
        title={t("settings.sounds.title")}
        description={t("settings.sounds.description")}
      >
        <ItemGroup class="settings-modal-card">
          <SwitchField
            data-settings-row="settings.sounds.muteAll.title"
            checked={state().preference.muteAll}
            onChange={(muteAll: boolean) => save(setMuteAll(muteAll))}
            label={t("settings.sounds.muteAll.title")}
            description={t("settings.sounds.muteAll.description")}
          />
        </ItemGroup>
      </SettingsSection>

      <For each={SOUND_EVENT_GROUPS}>
        {(group) => (
          <SettingsSection title={t(GROUP_TITLE[group])} class="settings-sound-group">
            <ItemGroup class="settings-modal-card">
              <For each={events(group)}>{(definition) => <SoundRow definition={definition} />}</For>
            </ItemGroup>
          </SettingsSection>
        )}
      </For>

      <Show when={desktop && props.onOpenSystemSettings}>
        {(open) => (
          <SettingsSection title={t("settings.sounds.macos.title")}>
            <ItemGroup class="settings-modal-card">
              <Item data-settings-row="settings.sounds.macos.title" class="settings-modal-row">
                <ItemContent>
                  <ItemDescription>{t("settings.sounds.macos.description")}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void Promise.resolve()
                        .then(() => open()())
                        .catch(() => report("settings.sounds.saveFailed"))
                    }
                  >
                    {t("settings.sounds.macos.open")}
                  </Button>
                </ItemActions>
              </Item>
            </ItemGroup>
          </SettingsSection>
        )}
      </Show>

      <SettingsSection
        data-settings-row="settings.sounds.recent.title"
        title={t("settings.sounds.recent.title")}
        description={t("settings.sounds.recent.description", { limit: String(RECENT_SOUND_LIMIT) })}
      >
        <ItemGroup class="settings-modal-card" aria-live="polite">
          <Show
            when={state().recent.length > 0}
            fallback={
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemDescription>{t("settings.sounds.recent.empty")}</ItemDescription>
                </ItemContent>
              </Item>
            }
          >
            <For each={state().recent}>
              {(entry) => (
                <Item class="settings-modal-row settings-sound-recent">
                  <ItemContent>
                    <ItemTitle>{title(entry.eventId)}</ItemTitle>
                    <ItemDescription>{recentText(entry)}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Badge variant={entry.outcome === "played" ? "secondary" : "outline"}>
                      {t(OUTCOME_TEXT[entry.outcome])}
                    </Badge>
                  </ItemActions>
                </Item>
              )}
            </For>
          </Show>
        </ItemGroup>
      </SettingsSection>
    </>
  );
}

/** The macOS sounds, for a check that every choice has a name. */
export const NATIVE_SOUND_NAMES = NATIVE_SOUND_CHOICES;
