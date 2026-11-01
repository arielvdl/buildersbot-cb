// The sound center: each sound that the desktop app can make, with its preference. The renderer
// plays the app sounds through one port (`src/renderer/src/sound-center.ts`) and main gives each
// macOS notification its sound through one port (`src/main/sound-port.ts`). `scripts/sound-port-guard.ts`
// fails when code makes a sound outside them.
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

/** The groups of the Sounds section, in the order it shows them. */
export const SOUND_EVENT_GROUPS = [
  "agents",
  "approvals",
  "guard",
  "taskReviewer",
  "tasksAndRoutines",
  "messages",
  "voice",
  "interface",
  "system",
  "remote",
] as const;
export type SoundEventGroup = (typeof SOUND_EVENT_GROUPS)[number];

/**
 * `app`: the app plays it in a window, so the person chooses the sound and the volume. `native`: a
 * macOS notification, so the person chooses a macOS sound and macOS sets the volume. `speech`: a
 * voice reads a text; the Voice page controls it. `info`: no sound of its own here, such as the work
 * that the task reviewer resumes or the iPhone app; the row says which sound plays or where to change it.
 */
export type SoundEventKind = "app" | "native" | "speech" | "info";

/** The cue that a sound theme plays for an event. The names are the cuelume cue names. */
export type SoundCue = "success" | "error" | "attention" | "warning" | "loading" | "navigate" | "tap" | "ready";

/** The themes of the built-in synthesized sounds, by their cuelume names. */
export const SOUND_THEME_NAMES = ["default", "mech", "bubble", "press"] as const;
export type SoundThemeName = (typeof SOUND_THEME_NAMES)[number];

/**
 * The sounds of an `app` event. `classic` is the tone that the event had before themes (for a
 * finished reply, the falling sweep). `system` is the alert sound of the operating system. `custom`
 * plays a file that the person added (`customSoundId`).
 */
export const APP_SOUND_CHOICES = ["none", "classic", ...SOUND_THEME_NAMES, "system", "custom"] as const;
export type AppSoundChoice = (typeof APP_SOUND_CHOICES)[number];

/** The sounds of a macOS notification: the default sound, none, or a sound of `/System/Library/Sounds`. */
export const NATIVE_SOUND_CHOICES = [
  "default",
  "none",
  "Basso",
  "Blow",
  "Bottle",
  "Frog",
  "Funk",
  "Glass",
  "Hero",
  "Morse",
  "Ping",
  "Pop",
  "Purr",
  "Sosumi",
  "Submarine",
  "Tink",
] as const;
export type NativeSoundChoice = (typeof NATIVE_SOUND_CHOICES)[number];

export interface SoundEventDefinition {
  id: string;
  group: SoundEventGroup;
  kind: SoundEventKind;
  /** The cue of a theme sound. Only `app` events have one. */
  cue: SoundCue | null;
  /** The sounds that the person can choose. Interface sounds come from the controls, so they take a theme only. */
  choices: readonly string[];
  defaultEnabled: boolean;
  defaultSound: string;
  /** True: it plays also while the person dictates or talks with an agent, because it is about that recording. */
  whileSpeaking: boolean;
}

const APP_CHOICES = APP_SOUND_CHOICES;
const THEME_CHOICES = ["none", ...SOUND_THEME_NAMES] as const;

function appEvent<const Id extends string>(
  id: Id,
  group: SoundEventGroup,
  cue: SoundCue,
  defaults: { enabled: boolean; sound: AppSoundChoice; whileSpeaking?: boolean; themesOnly?: boolean },
): SoundEventDefinition & { id: Id; kind: "app" } {
  return {
    id,
    group,
    kind: "app",
    cue,
    choices: defaults.themesOnly ? THEME_CHOICES : APP_CHOICES,
    defaultEnabled: defaults.enabled,
    defaultSound: defaults.sound,
    whileSpeaking: defaults.whileSpeaking ?? false,
  };
}

function nativeEvent<const Id extends string>(
  id: Id,
  group: SoundEventGroup,
): SoundEventDefinition & { id: Id; kind: "native" } {
  return {
    id,
    group,
    kind: "native",
    cue: null,
    choices: NATIVE_SOUND_CHOICES,
    defaultEnabled: true,
    defaultSound: "default",
    whileSpeaking: true,
  };
}

function otherEvent<const Id extends string, const Kind extends "speech" | "info">(
  id: Id,
  group: SoundEventGroup,
  kind: Kind,
): SoundEventDefinition & { id: Id; kind: Kind } {
  return { id, group, kind, cue: null, choices: [], defaultEnabled: true, defaultSound: "none", whileSpeaking: true };
}

/**
 * Every sound of the app. The defaults are the sounds of the versions before the sound center: the
 * finished work plays the classic tone, and the cues of the old "Sound feedback" choice are off.
 */
export const SOUND_EVENTS = [
  appEvent("agent.reply-finished", "agents", "success", { enabled: true, sound: "classic" }),
  appEvent("agent.run-failed", "agents", "error", { enabled: false, sound: "default" }),
  appEvent("approval.waiting", "approvals", "attention", { enabled: false, sound: "default" }),
  appEvent("guard.question", "guard", "attention", { enabled: false, sound: "default" }),
  otherEvent("task-reviewer.resumed-work", "taskReviewer", "info"),
  appEvent("agent.work-finished", "tasksAndRoutines", "success", { enabled: true, sound: "classic" }),
  appEvent("routine.finished", "tasksAndRoutines", "success", { enabled: true, sound: "classic" }),
  nativeEvent("notification.workflow", "tasksAndRoutines"),
  nativeEvent("notification.agent", "messages"),
  nativeEvent("notification.channel-reply", "messages"),
  appEvent("voice.limit-warning", "voice", "warning", { enabled: true, sound: "classic", whileSpeaking: true }),
  appEvent("voice.limit-stop", "voice", "error", { enabled: true, sound: "classic", whileSpeaking: true }),
  otherEvent("voice.read-aloud", "voice", "speech"),
  appEvent("interface.controls", "interface", "tap", { enabled: false, sound: "default", themesOnly: true }),
  appEvent("interface.actions", "interface", "success", { enabled: false, sound: "default" }),
  nativeEvent("notification.usage-limit", "system"),
  nativeEvent("notification.machine-alert", "system"),
  nativeEvent("notification.system", "system"),
  otherEvent("remote.phone", "remote", "info"),
] as const satisfies readonly SoundEventDefinition[];

export type SoundEventId = (typeof SOUND_EVENTS)[number]["id"];
export const SOUND_EVENT_IDS: readonly SoundEventId[] = SOUND_EVENTS.map((event): SoundEventId => event.id);
export type NativeSoundEventId = Extract<(typeof SOUND_EVENTS)[number], { kind: "native" }>["id"];
export type AppSoundEventId = Extract<(typeof SOUND_EVENTS)[number], { kind: "app" }>["id"];

export type SoundEventEntry = (typeof SOUND_EVENTS)[number];

export function soundEventDefinition(id: SoundEventId): SoundEventDefinition {
  const found = SOUND_EVENTS.find((event) => event.id === id);
  // Each id comes from SOUND_EVENTS, so the find always succeeds.
  if (!found) throw new Error(`Unknown sound event ${id}.`);
  return found;
}

export function isAppSoundEventId(id: SoundEventId): id is AppSoundEventId {
  return SOUND_EVENTS.some((event) => event.id === id && event.kind === "app");
}

export function isSoundEventId(value: unknown): value is SoundEventId {
  return isOneOf(SOUND_EVENT_IDS, value);
}

/** The highest volume. 100 is the loudness of the built-in sounds; nothing plays louder. */
export const SOUND_VOLUME_MAX = 100;
/** The most custom sound files the app keeps. */
export const CUSTOM_SOUND_LIMIT = 12;
/** The largest custom sound file, in bytes. A short alert is far smaller. */
export const CUSTOM_SOUND_MAX_BYTES = 2 * 1024 * 1024;
/** The custom sound file types, by extension. */
export const CUSTOM_SOUND_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "aiff"] as const;
/** How many plays the Recent sounds list keeps. */
export const RECENT_SOUND_LIMIT = 20;

export interface SoundEventPreference {
  enabled: boolean;
  /** One of the `choices` of the event. */
  sound: string;
  /** 0 to `SOUND_VOLUME_MAX`. */
  volume: number;
  /** The file of a `custom` sound. */
  customSoundId: string | null;
}

export interface SoundPreference {
  /** True: no sound of the app plays, and the macOS notifications are silent. */
  muteAll: boolean;
  /** The events that the person changed. A missing event has its defaults. */
  events: Partial<Record<SoundEventId, SoundEventPreference>>;
}

export const DEFAULT_SOUND_PREFERENCE: SoundPreference = { muteAll: false, events: {} };

/** A sound file that the person added. The app copied it into its own folder, under `id`. */
export interface CustomSound {
  id: string;
  /** The file name the person chose, for the menu. */
  name: string;
  bytes: number;
}

/**
 * `played`, or why the sound did not play: the event is off or has no sound, everything is muted,
 * the person dictates or talks with an agent, or the sound could not play.
 */
export type SoundPlayOutcome = "played" | "event-off" | "mute-all" | "speaking" | "failed";
export const SOUND_PLAY_OUTCOMES = ["played", "event-off", "mute-all", "speaking", "failed"] as const;

/** One entry of Recent sounds. It names the event and who caused it, never the text of a message. */
export interface RecentSound {
  eventId: SoundEventId;
  at: string;
  outcome: SoundPlayOutcome;
  /** The agent or server that caused it, when the port knew it. */
  who: string | null;
  /** The sound it played or would play. */
  sound: string;
}

export interface SoundPlayReport {
  eventId: SoundEventId;
  outcome: SoundPlayOutcome;
  who: string | null;
  sound: string;
}

export interface SoundCenterState {
  preference: SoundPreference;
  /** False until a preference is saved. The window then moves the choices of older versions in. */
  saved: boolean;
  customSounds: CustomSound[];
  /** Newest first. */
  recent: RecentSound[];
}

export interface NativeSoundPreview {
  eventId: SoundEventId;
  sound: string;
}

const WHO_MAX_LENGTH = 120;
const CUSTOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp3|wav|m4a|ogg|aiff)$/u;

export function isCustomSoundId(value: unknown): value is string {
  return isString(value) && CUSTOM_ID.test(value);
}

/** The preference of an event, with the defaults for what the person did not change. */
export function soundEventPreference(preference: SoundPreference, id: SoundEventId): SoundEventPreference {
  const definition = soundEventDefinition(id);
  return (
    preference.events[id] ?? {
      enabled: definition.defaultEnabled,
      sound: definition.defaultSound,
      volume: SOUND_VOLUME_MAX,
      customSoundId: null,
    }
  );
}

function decodeEventPreference(id: SoundEventId, value: unknown): SoundEventPreference | null {
  if (!isDynamicRecord(value)) return null;
  const { enabled, sound, volume, customSoundId } = value;
  const definition = soundEventDefinition(id);
  if (!isBoolean(enabled) || !isString(sound) || !definition.choices.includes(sound)) return null;
  if (!isNumber(volume) || !Number.isFinite(volume)) return null;
  const custom = isCustomSoundId(customSoundId) ? customSoundId : null;
  if (sound === "custom" && custom === null) return null;
  return {
    enabled,
    sound,
    volume: Math.round(Math.min(SOUND_VOLUME_MAX, Math.max(0, volume))),
    customSoundId: custom,
  };
}

/**
 * Decodes a sound preference. An event that this version does not know, or a choice that it cannot
 * play, is dropped, so a file of a newer version still reads.
 */
export function decodeSoundPreference(value: unknown): SoundPreference {
  if (!isDynamicRecord(value) || !isBoolean(value.muteAll)) throw new Error("Invalid sound preference.");
  const events: Partial<Record<SoundEventId, SoundEventPreference>> = {};
  if (isDynamicRecord(value.events)) {
    for (const id of SOUND_EVENT_IDS) {
      const decoded = decodeEventPreference(id, value.events[id]);
      if (decoded) events[id] = decoded;
    }
  }
  return { muteAll: value.muteAll, events };
}

function decodeCustomSound(value: unknown): CustomSound {
  if (
    !isDynamicRecord(value) ||
    !isCustomSoundId(value.id) ||
    !isString(value.name) ||
    !isNumber(value.bytes) ||
    value.bytes < 0
  ) {
    throw new Error("Invalid custom sound.");
  }
  return { id: value.id, name: value.name.slice(0, WHO_MAX_LENGTH), bytes: value.bytes };
}

export function decodeCustomSoundOrNull(value: unknown): CustomSound | null {
  return value === null ? null : decodeCustomSound(value);
}

function decodeWho(value: unknown): string | null {
  return isString(value) && value.trim() ? value.trim().slice(0, WHO_MAX_LENGTH) : null;
}

export function decodeSoundPlayReport(value: unknown): SoundPlayReport {
  if (
    !isDynamicRecord(value) ||
    !isSoundEventId(value.eventId) ||
    !isOneOf(SOUND_PLAY_OUTCOMES, value.outcome) ||
    !isString(value.sound) ||
    value.sound.length > 64
  ) {
    throw new Error("Invalid sound report.");
  }
  return { eventId: value.eventId, outcome: value.outcome, who: decodeWho(value.who), sound: value.sound };
}

function decodeRecentSound(value: unknown): RecentSound {
  const report = decodeSoundPlayReport(value);
  if (!isDynamicRecord(value) || !isString(value.at)) throw new Error("Invalid recent sound.");
  return { ...report, at: value.at };
}

export function decodeSoundCenterState(value: unknown): SoundCenterState {
  if (
    !isDynamicRecord(value) ||
    !isBoolean(value.saved) ||
    !Array.isArray(value.customSounds) ||
    !Array.isArray(value.recent)
  ) {
    throw new Error("Invalid sound center state.");
  }
  return {
    preference: decodeSoundPreference(value.preference),
    saved: value.saved,
    customSounds: value.customSounds.map(decodeCustomSound),
    recent: value.recent.slice(0, RECENT_SOUND_LIMIT).map(decodeRecentSound),
  };
}

export function decodeNativeSoundPreview(value: unknown): NativeSoundPreview {
  if (!isDynamicRecord(value) || !isSoundEventId(value.eventId) || !isOneOf(NATIVE_SOUND_CHOICES, value.sound)) {
    throw new Error("Invalid sound preview.");
  }
  return { eventId: value.eventId, sound: value.sound };
}
