import { type SoundEventId, soundEventPreference } from "@openbot/contracts/ipc";
import { SOUND_THEMES, type SoundChoice, type SoundTheme } from "@openbot/ui/features/settings/app-settings";
import { previewSound, saveSoundPreference, soundCenterState, startSoundCenter } from "./sound-center";

/** The cues of the old "Sound feedback" choice, now events of the sound center. */
const FEEDBACK_EVENTS = [
  "interface.controls",
  "interface.actions",
  "agent.run-failed",
  "approval.waiting",
  "guard.question",
] as const satisfies readonly SoundEventId[];

/** Whether the control sounds are on. They are off until the person turns them on. */
export function isActionSoundEnabled(): boolean {
  const { preference } = soundCenterState();
  const controls = soundEventPreference(preference, "interface.controls");
  return controls.enabled && controls.sound !== "none";
}

export function readActionSoundTheme(): SoundTheme {
  const sound = soundEventPreference(soundCenterState().preference, "interface.controls").sound;
  return SOUND_THEMES.find((theme) => theme === sound) ?? "default";
}

/** The sound menu value of the web client: "off", or the theme. */
export function readActionSoundChoice(): SoundChoice {
  return isActionSoundEnabled() ? readActionSoundTheme() : "off";
}

/**
 * Saves a choice of the old sound menu: each cue event takes the theme, or turns off. "off" keeps the
 * theme, so the next time the person turns the sounds on, the menu shows the theme from before.
 */
export function setActionSoundChoice(choice: SoundChoice): void {
  const { preference } = soundCenterState();
  const events = { ...preference.events };
  for (const id of FEEDBACK_EVENTS) {
    const current = soundEventPreference(preference, id);
    events[id] = choice === "off" ? { ...current, enabled: false } : { ...current, enabled: true, sound: choice };
  }
  void saveSoundPreference({ ...preference, events }).catch(() => undefined);
  if (choice !== "off")
    void previewSound("interface.actions", { enabled: true, sound: choice, volume: 100, customSoundId: null }).catch(
      () => undefined,
    );
}

/** Starts the sound center and the control sounds. Later calls do nothing. */
export function startActionSounds(): void {
  void startSoundCenter();
}
