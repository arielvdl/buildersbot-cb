// The one place where main makes a sound: each macOS notification of the app is made here, with the
// sound that the sound center gives its event. `scripts/sound-port-guard.ts` fails when other main
// code calls `new Notification(...)`, `shell.beep()` or a command that plays audio.
import {
  type NativeSoundEventId,
  type SoundEventId,
  type SoundPlayOutcome,
  type SoundPreference,
  soundEventPreference,
} from "@openbot/contracts/ipc";
import { Notification, type NotificationConstructorOptions, shell } from "electron";

/** What the sound center gives this port: the preference, and the Recent sounds list. */
export interface NativeSoundSource {
  preference(): SoundPreference;
  report(report: { eventId: SoundEventId; outcome: SoundPlayOutcome; who: string | null; sound: string }): void;
}

let source: NativeSoundSource | null = null;

/** Main sets the sound center once its file is read. Before that, a notification plays the macOS default. */
export function setNativeSoundSource(next: NativeSoundSource | null): void {
  source = next;
}

/**
 * The sound options of a notification of `eventId`: silent when everything is muted, the event is
 * off or has no sound; the macOS default sound; or a named sound of `/System/Library/Sounds`. macOS
 * can still keep it quiet: the Notifications page of System Settings has a sound switch for each app.
 */
export function nativeSoundOptions(
  eventId: NativeSoundEventId,
  preference: SoundPreference,
): { options: Pick<NotificationConstructorOptions, "silent" | "sound">; outcome: SoundPlayOutcome; sound: string } {
  const event = soundEventPreference(preference, eventId);
  if (preference.muteAll) return { options: { silent: true }, outcome: "mute-all", sound: event.sound };
  if (!event.enabled || event.sound === "none")
    return { options: { silent: true }, outcome: "event-off", sound: event.sound };
  if (event.sound === "default") return { options: {}, outcome: "played", sound: event.sound };
  return { options: { sound: event.sound }, outcome: "played", sound: event.sound };
}

/**
 * A macOS notification of an event of the sound center. `who` names the agent or server, for Recent
 * sounds; it is never the text of a message.
 */
export function appNotification(
  eventId: NativeSoundEventId,
  options: { title: string; body: string },
  who: string | null = null,
): Notification {
  const current = source;
  if (!current) return new Notification(options);
  const sound = nativeSoundOptions(eventId, current.preference());
  current.report({ eventId, outcome: sound.outcome, who, sound: sound.sound });
  return new Notification({ ...options, ...sound.options });
}

/** A notification that plays one macOS sound now, so the person hears a choice in Settings. */
export function previewNotification(options: { title: string; body: string }, sound: string): Notification {
  return new Notification(
    sound === "none" ? { ...options, silent: true } : sound === "default" ? options : { ...options, sound },
  );
}

/** The alert sound of the operating system, for an app event whose chosen sound is "system". */
export function playSystemAlertSound(): void {
  shell.beep();
}
