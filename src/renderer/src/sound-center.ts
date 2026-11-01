// The one port of the app sounds in a window. Every sound of the renderer plays through `playSound`,
// which reads the sound center: the event's switch, its sound and volume, "Mute all", and whether the
// person dictates or talks with an agent. Each play, and each sound kept quiet, goes to Recent sounds.
// `scripts/sound-port-guard.ts` fails when other renderer code makes a sound.
//
// On desktop, main keeps the preference (`notifications.getSounds`) and sends each change to every
// window. The web client has no main process: it keeps the preference in this browser.
import {
  type AppSoundEventId,
  type CustomSound,
  DEFAULT_SOUND_PREFERENCE,
  decodeSoundCenterState,
  isAppSoundEventId,
  RECENT_SOUND_LIMIT,
  SOUND_EVENTS,
  SOUND_THEME_NAMES,
  SOUND_VOLUME_MAX,
  type SoundCenterState,
  type SoundCue,
  type SoundEventId,
  type SoundEventPreference,
  type SoundPlayOutcome,
  type SoundPreference,
  type SoundThemeName,
  soundEventDefinition,
  soundEventPreference,
} from "@openbot/contracts/ipc";
import { isOneOf } from "@openbot/contracts/runtime-values";
import { bind, type Emphasis, play as playCue, setEnabled, setTheme, unlock } from "cuelume";
import { createSignal } from "solid-js";

/** The keys of the versions before the sound center. They are still written, so an older version keeps the choices. */
const LEGACY_TASK_SOUND = "openbot:task-sound";
const LEGACY_COMPLETION_SOUND = "openbot:completion-sound-enabled";
const LEGACY_ACTION_SOUNDS = "openbot:action-sounds-enabled";
const LEGACY_ACTION_THEME = "openbot:action-sounds-theme";
/** The web client's own copy of the preference. */
const WEB_PREFERENCE_KEY = "openbot:sounds:v1";

/** A custom sound plays at most this loud at full volume: the built-in sounds peak near it. */
const CUSTOM_SOUND_PEAK = 0.6;

const EMPTY_STATE: SoundCenterState = {
  preference: DEFAULT_SOUND_PREFERENCE,
  saved: false,
  customSounds: [],
  recent: [],
};

/** Where the window keeps the sound center: main on desktop, this browser on the web. */
interface SoundBackend {
  readonly desktop: boolean;
  load(): Promise<SoundCenterState>;
  save(preference: SoundPreference): Promise<SoundCenterState>;
  report(report: { eventId: SoundEventId; outcome: SoundPlayOutcome; who: string | null; sound: string }): void;
  subscribe(listener: (state: SoundCenterState) => void): () => void;
  readCustom(id: string): Promise<Uint8Array>;
  addCustom(): Promise<CustomSound | null>;
  playSystem(): Promise<void>;
  previewNative(eventId: SoundEventId, sound: string): Promise<void>;
}

function desktopBackend(): SoundBackend | null {
  const api = typeof window === "undefined" ? undefined : window.openbot?.notifications;
  if (!api || typeof api.getSounds !== "function") return null;
  return {
    desktop: true,
    load: () => api.getSounds(),
    save: (preference) => api.setSounds(preference),
    report: (report) => void api.reportSound(report).catch(() => undefined),
    subscribe: (listener) => api.onSoundsChanged(listener),
    readCustom: (id) => api.readCustomSound(id),
    addCustom: () => api.addCustomSound(),
    playSystem: () => api.playSystemSound(),
    previewNative: (eventId, sound) => api.previewNativeSound({ eventId, sound }),
  };
}

/** The web client: the preference in this browser, Recent sounds in this page. */
function webBackend(): SoundBackend {
  let current: SoundCenterState = { ...EMPTY_STATE };
  const listeners = new Set<(state: SoundCenterState) => void>();
  const emit = () => {
    for (const listener of listeners) listener(current);
  };
  const read = (): SoundCenterState => {
    try {
      const saved = window.localStorage.getItem(WEB_PREFERENCE_KEY);
      if (saved === null) return { ...current, saved: false };
      const parsed = decodeSoundCenterState({ ...JSON.parse(saved), saved: true, customSounds: [], recent: [] });
      return { ...current, preference: parsed.preference, saved: true };
    } catch {
      return { ...current, saved: false };
    }
  };
  if (typeof window !== "undefined")
    window.addEventListener("storage", (event) => {
      if (event.key !== WEB_PREFERENCE_KEY) return;
      current = read();
      emit();
    });
  return {
    desktop: false,
    load: async () => {
      current = read();
      return current;
    },
    save: async (preference) => {
      try {
        window.localStorage.setItem(WEB_PREFERENCE_KEY, JSON.stringify(preference));
      } catch {
        // Blocked or full storage keeps the choice for this page only.
      }
      current = { ...current, preference, saved: true };
      emit();
      return current;
    },
    report: (report) => {
      current = {
        ...current,
        recent: [{ ...report, at: new Date().toISOString() }, ...current.recent].slice(0, RECENT_SOUND_LIMIT),
      };
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readCustom: () => Promise.reject(new Error("The web client has no custom sounds.")),
    addCustom: async () => null,
    // A browser cannot play the system alert sound, so the classic tone of the event plays.
    playSystem: () => Promise.reject(new Error("The web client cannot play the system sound.")),
    previewNative: async () => undefined,
  };
}

let backend: SoundBackend | null = null;
let started = false;
let unsubscribe: (() => void) | undefined;
const [soundState, setSoundState] = createSignal<SoundCenterState>(EMPTY_STATE);
/** Why the sounds are quiet now: one key for each dictation or voice conversation in progress. */
const speaking = new Set<string>();
let quietKeys = 0;

function currentBackend(): SoundBackend {
  backend ??= desktopBackend() ?? webBackend();
  return backend;
}

/** The sound center state, for the Sounds section. It follows the changes of every window. */
export function soundCenterState(): SoundCenterState {
  return soundState();
}

/** True on desktop: main shows macOS notifications, plays the system sound and keeps custom files. */
export function soundCenterOnDesktop(): boolean {
  return currentBackend().desktop;
}

function readLegacy(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLegacy(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked or full storage: an older version reads its default.
  }
}

const LEGACY_THEMES = SOUND_THEME_NAMES;

/**
 * The preference that the choices of the versions before the sound center give: the task sound for
 * finished work, and the old "Sound feedback" choice for the cues.
 */
export function preferenceFromLegacy(read: (key: string) => string | null = readLegacy): SoundPreference {
  const events: SoundPreference["events"] = {};
  const set = (id: SoundEventId, enabled: boolean, sound: string) => {
    events[id] = { enabled, sound, volume: SOUND_VOLUME_MAX, customSoundId: null };
  };
  const savedTask = read(LEGACY_TASK_SOUND);
  const taskOff = read(LEGACY_COMPLETION_SOUND) === "false";
  // A saved "off" with the switch on means that an older version turned the sound on again.
  const taskSound = savedTask === "classic" || isOneOf(LEGACY_THEMES, savedTask) ? savedTask : "classic";
  for (const id of ["agent.reply-finished", "agent.work-finished", "routine.finished"] as const)
    set(id, !taskOff, taskSound);
  const actionsOn = read(LEGACY_ACTION_SOUNDS) === "true";
  const savedTheme = read(LEGACY_ACTION_THEME);
  const theme: SoundThemeName = isOneOf(LEGACY_THEMES, savedTheme) ? savedTheme : "default";
  for (const id of [
    "interface.controls",
    "interface.actions",
    "agent.run-failed",
    "approval.waiting",
    "guard.question",
  ] as const)
    set(id, actionsOn, theme);
  return { muteAll: false, events };
}

/** Writes the keys of the versions before the sound center, so a downgrade keeps the main choices. */
function writeLegacyChoices(preference: SoundPreference): void {
  const reply = soundEventPreference(preference, "agent.reply-finished");
  const taskOn = !preference.muteAll && reply.enabled && reply.sound !== "none";
  writeLegacy(LEGACY_COMPLETION_SOUND, String(taskOn));
  writeLegacy(
    LEGACY_TASK_SOUND,
    taskOn ? (reply.sound === "classic" || isOneOf(LEGACY_THEMES, reply.sound) ? reply.sound : "classic") : "off",
  );
  const controls = soundEventPreference(preference, "interface.controls");
  const controlsOn = !preference.muteAll && controls.enabled && isOneOf(LEGACY_THEMES, controls.sound);
  writeLegacy(LEGACY_ACTION_SOUNDS, String(controlsOn));
  if (isOneOf(LEGACY_THEMES, controls.sound)) writeLegacy(LEGACY_ACTION_THEME, controls.sound);
}

/** The control sounds play inside cuelume, from the `data-cuelume-*` attributes of shared controls. */
function applyControlSounds(state: SoundCenterState): void {
  const controls = soundEventPreference(state.preference, "interface.controls");
  const on =
    !state.preference.muteAll && controls.enabled && isOneOf(LEGACY_THEMES, controls.sound) && speaking.size === 0;
  if (isOneOf(LEGACY_THEMES, controls.sound)) setTheme(controls.sound);
  setEnabled(on);
}

function apply(state: SoundCenterState): void {
  setSoundState(state);
  applyControlSounds(state);
}

/**
 * Reads the sound center, moves the choices of older versions in when nothing is saved yet, follows
 * the changes of the other windows, and starts the control sounds. Later calls do nothing.
 */
export function startSoundCenter(): Promise<void> {
  if (started) return Promise.resolve();
  started = true;
  const source = currentBackend();
  unsubscribe = source.subscribe(apply);
  bind();
  return source
    .load()
    .then(async (loaded) => {
      if (loaded.saved) {
        apply(loaded);
        return;
      }
      apply({ ...loaded, preference: preferenceFromLegacy() });
      apply(await source.save(preferenceFromLegacy()));
    })
    .catch(() => {
      // Without a preference the defaults play, as before the sound center.
      apply({ ...EMPTY_STATE, preference: preferenceFromLegacy() });
    });
}

/** For Storybook and the E2E check: forget the backend so that the next start reads `window.openbot` again. */
export function resetSoundCenterForStory(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  backend = null;
  started = false;
  speaking.clear();
  setSoundState(EMPTY_STATE);
}

/** Saves a new preference for every window, and keeps the keys of older versions in step. */
export async function saveSoundPreference(preference: SoundPreference): Promise<void> {
  const previous = soundState();
  apply({ ...previous, preference });
  try {
    apply(await currentBackend().save(preference));
    writeLegacyChoices(preference);
  } catch (error) {
    apply(previous);
    throw error;
  }
}

export function updateSoundEvent(id: SoundEventId, change: Partial<SoundEventPreference>): Promise<void> {
  const preference = soundState().preference;
  const current = soundEventPreference(preference, id);
  const next = { ...current, ...change };
  // A control can report its own value again when the state changes, such as a slider that turns
  // disabled. Saving that would change the state again, so an equal value saves nothing.
  if (
    preference.events[id] !== undefined &&
    next.enabled === current.enabled &&
    next.sound === current.sound &&
    next.volume === current.volume &&
    next.customSoundId === current.customSoundId
  )
    return Promise.resolve();
  return saveSoundPreference({ ...preference, events: { ...preference.events, [id]: next } });
}

export function resetSoundEvent(id: SoundEventId): Promise<void> {
  const preference = soundState().preference;
  const events = { ...preference.events };
  delete events[id];
  return saveSoundPreference({ ...preference, events });
}

export function setMuteAll(muteAll: boolean): Promise<void> {
  if (soundState().preference.muteAll === muteAll) return Promise.resolve();
  return saveSoundPreference({ ...soundState().preference, muteAll });
}

/** Opens the file dialog of main. The chosen file is copied into the app folder before it can play. */
export function addCustomSound(): Promise<CustomSound | null> {
  return currentBackend().addCustom();
}

/** A key for `setSoundsQuietFor`, one for each recorder, so one recorder does not end the quiet of another. */
export function soundQuietKey(kind: "dictation" | "voice-conversation"): string {
  quietKeys += 1;
  return `${kind}:${quietKeys}`;
}

/**
 * The person dictates or talks with an agent, or stopped. While one is active, only the sounds about
 * that recording play, so a cue does not go into the microphone or over the voice.
 */
export function setSoundsQuietFor(key: string, active: boolean): void {
  if (active) speaking.add(key);
  else speaking.delete(key);
  applyControlSounds(soundState());
}

export interface PlaySoundOptions {
  /** The agent or server that caused it, for Recent sounds. Never the text of a message. */
  who?: string | null | undefined;
  /** The cue of a theme sound, when the event has more than one, such as the result of an action. */
  cue?: SoundCue | undefined;
  emphasis?: Emphasis | undefined;
}

function outcomeFor(
  id: AppSoundEventId,
  event: SoundEventPreference,
  preference: SoundPreference,
): Exclude<SoundPlayOutcome, "failed"> {
  if (preference.muteAll) return "mute-all";
  if (!event.enabled || event.sound === "none" || event.volume === 0) return "event-off";
  if (speaking.size > 0 && !soundEventDefinition(id).whileSpeaking) return "speaking";
  return "played";
}

/**
 * Plays the sound of an event, or keeps it quiet as the sound center says, and tells Recent sounds
 * either way. The single place where the renderer makes a sound.
 */
export function playSound(id: AppSoundEventId, options: PlaySoundOptions = {}): void {
  const { preference } = soundState();
  const event = soundEventPreference(preference, id);
  const outcome = outcomeFor(id, event, preference);
  const report = (result: SoundPlayOutcome) =>
    currentBackend().report({ eventId: id, outcome: result, who: options.who ?? null, sound: event.sound });
  if (outcome !== "played") {
    report(outcome);
    return;
  }
  void render(id, event, options).then(
    () => report("played"),
    () => report("failed"),
  );
}

/**
 * Tells Recent sounds that a voice reads a reply aloud. The Voice page controls the reading; the
 * entry only helps to find a voice that the person did not expect. It names the agent, not the text.
 */
export function noteSpeechStarted(who: string | null): void {
  currentBackend().report({ eventId: "voice.read-aloud", outcome: "played", who, sound: "voice" });
}

/**
 * Plays a choice of the Sounds section without saving it, for its play button. It plays also when the
 * event is off or everything is muted: the person asked to hear it. A macOS sound shows a notification.
 */
export function previewSound(id: SoundEventId, event: SoundEventPreference): Promise<void> {
  const definition = soundEventDefinition(id);
  if (event.sound === "none") return Promise.resolve();
  if (definition.kind === "native") return currentBackend().previewNative(id, event.sound);
  if (!isAppSoundEventId(id)) return Promise.resolve();
  return render(id, event, {});
}

/** The volume as a gain from 0 to 1. Nothing plays louder than the built-in sound at full volume. */
function gainOf(event: SoundEventPreference): number {
  return Math.min(1, Math.max(0, event.volume / SOUND_VOLUME_MAX));
}

async function render(id: AppSoundEventId, event: SoundEventPreference, options: PlaySoundOptions): Promise<void> {
  const gain = gainOf(event);
  const definition = soundEventDefinition(id);
  if (isOneOf(LEGACY_THEMES, event.sound)) {
    playCue(options.cue ?? definition.cue ?? "success", {
      theme: event.sound,
      force: true,
      volume: gain,
      ...(options.emphasis ? { emphasis: options.emphasis } : {}),
    });
    return;
  }
  if (event.sound === "system") {
    try {
      await currentBackend().playSystem();
      return;
    } catch {
      // The web client has no system sound: the classic tone plays.
    }
  }
  if (event.sound === "custom" && event.customSoundId) {
    await playCustom(event.customSoundId, gain);
    return;
  }
  await playTones(CLASSIC_TONES[id], gain);
}

let context: AudioContext | undefined;

/** The one audio context of the app sounds, so that each sound does not keep its own output open. */
export async function appSoundContext(): Promise<AudioContext> {
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") await context.resume();
    return context;
  } catch (error) {
    context = undefined;
    throw error;
  }
}

/**
 * Starts the audio contexts from a user action. Safari starts a context only from one, a turn can end
 * long after the last action, and iOS can interrupt a running context.
 */
export function unlockSounds(): void {
  void unlock();
  try {
    context ??= new AudioContext();
    if (context.state !== "running") void context.resume().catch(() => undefined);
  } catch {
    context = undefined;
  }
}

interface Tone {
  frequency: number;
  /** A falling or rising end frequency. */
  to?: number;
  at: number;
  duration: number;
  volume: number;
}

/**
 * The classic tone of each event. Finished work keeps the falling sweep of the versions before the
 * sound center, and the voice limit keeps its pips and its chime.
 */
const CLASSIC_TONES: Record<AppSoundEventId, readonly Tone[]> = {
  "agent.reply-finished": [{ frequency: 420, to: 160, at: 0, duration: 0.22, volume: 0.16 }],
  "agent.work-finished": [{ frequency: 420, to: 160, at: 0, duration: 0.22, volume: 0.16 }],
  "routine.finished": [{ frequency: 420, to: 160, at: 0, duration: 0.22, volume: 0.16 }],
  "agent.run-failed": [
    { frequency: 330, at: 0, duration: 0.14, volume: 0.12 },
    { frequency: 220, at: 0.13, duration: 0.24, volume: 0.12 },
  ],
  "approval.waiting": [
    { frequency: 988, at: 0, duration: 0.12, volume: 0.1 },
    { frequency: 1319, at: 0.14, duration: 0.2, volume: 0.1 },
  ],
  "guard.question": [
    { frequency: 880, at: 0, duration: 0.12, volume: 0.1 },
    { frequency: 660, at: 0.14, duration: 0.12, volume: 0.1 },
    { frequency: 880, at: 0.28, duration: 0.16, volume: 0.1 },
  ],
  "voice.limit-warning": [
    { frequency: 880, at: 0, duration: 0.09, volume: 0.08 },
    { frequency: 880, at: 0.16, duration: 0.09, volume: 0.08 },
  ],
  "voice.limit-stop": [
    { frequency: 784, at: 0, duration: 0.18, volume: 0.14 },
    { frequency: 523, at: 0.16, duration: 0.32, volume: 0.14 },
  ],
  "interface.controls": [{ frequency: 1200, at: 0, duration: 0.04, volume: 0.05 }],
  "interface.actions": [{ frequency: 660, at: 0, duration: 0.08, volume: 0.08 }],
};

async function playTones(tones: readonly Tone[], gain: number): Promise<void> {
  const audio = await appSoundContext();
  const startedAt = audio.currentTime;
  for (const tone of tones) {
    const start = startedAt + tone.at;
    const oscillator = audio.createOscillator();
    const envelope = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(tone.frequency, start);
    if (tone.to) oscillator.frequency.exponentialRampToValueAtTime(tone.to, start + tone.duration * 0.8);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, tone.volume * gain), start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration);
    oscillator.connect(envelope);
    envelope.connect(audio.destination);
    oscillator.addEventListener(
      "ended",
      () => {
        oscillator.disconnect();
        envelope.disconnect();
      },
      { once: true },
    );
    oscillator.start(start);
    oscillator.stop(start + tone.duration);
  }
}

/** Decoded custom sounds by id, with the gain that brings each one's peak to `CUSTOM_SOUND_PEAK`. */
const customBuffers = new Map<string, Promise<{ buffer: AudioBuffer; normalize: number }>>();

function decodeCustom(id: string): Promise<{ buffer: AudioBuffer; normalize: number }> {
  const known = customBuffers.get(id);
  if (known) return known;
  const loading = (async () => {
    const bytes = await currentBackend().readCustom(id);
    const audio = await appSoundContext();
    const buffer = await audio.decodeAudioData(bytes.slice().buffer);
    let peak = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      for (const sample of buffer.getChannelData(channel)) peak = Math.max(peak, Math.abs(sample));
    }
    return { buffer, normalize: peak > 0 ? Math.min(1, CUSTOM_SOUND_PEAK / peak) : 0 };
  })();
  customBuffers.set(id, loading);
  loading.catch(() => customBuffers.delete(id));
  return loading;
}

async function playCustom(id: string, gain: number): Promise<void> {
  const { buffer, normalize } = await decodeCustom(id);
  const audio = await appSoundContext();
  const source = audio.createBufferSource();
  const volume = audio.createGain();
  source.buffer = buffer;
  // The peak never passes CUSTOM_SOUND_PEAK, whatever the file's own loudness.
  volume.gain.value = normalize * gain;
  source.connect(volume);
  volume.connect(audio.destination);
  source.addEventListener(
    "ended",
    () => {
      source.disconnect();
      volume.disconnect();
    },
    { once: true },
  );
  source.start();
}

/** The events of the Sounds section, in the order of the registry. */
export const SOUND_CENTER_EVENTS = SOUND_EVENTS;
