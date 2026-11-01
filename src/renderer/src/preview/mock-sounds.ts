import {
  type BuildersBotDesktopApi,
  DEFAULT_SOUND_PREFERENCE,
  RECENT_SOUND_LIMIT,
  type SoundCenterState,
  type SoundPreference,
} from "@openbot/contracts/ipc";

type NotificationsApi = BuildersBotDesktopApi["notifications"];
type SoundMethods = Pick<
  NotificationsApi,
  | "getSounds"
  | "setSounds"
  | "reportSound"
  | "addCustomSound"
  | "readCustomSound"
  | "playSystemSound"
  | "previewNativeSound"
  | "onSoundsChanged"
>;

/**
 * The sound center of the preview and of Storybook, in memory. `initial` is the state that main
 * would read from its file, such as one that is not saved yet, so the window moves the old choices in.
 */
export function createMockSounds(initial?: Partial<SoundCenterState>): SoundMethods {
  let state: SoundCenterState = {
    preference: structuredClone(initial?.preference ?? DEFAULT_SOUND_PREFERENCE),
    saved: initial?.saved ?? false,
    customSounds: structuredClone(initial?.customSounds ?? []),
    recent: structuredClone(initial?.recent ?? []),
  };
  const listeners = new Set<(state: SoundCenterState) => void>();
  const emit = () => {
    for (const listener of listeners) listener(structuredClone(state));
  };
  return {
    getSounds: async () => structuredClone(state),
    setSounds: async (preference: SoundPreference) => {
      state = { ...state, preference: structuredClone(preference), saved: true };
      emit();
      return structuredClone(state);
    },
    reportSound: async (report) => {
      state = {
        ...state,
        recent: [{ ...report, at: new Date().toISOString() }, ...state.recent].slice(0, RECENT_SOUND_LIMIT),
      };
      emit();
    },
    // The preview has no file dialog.
    addCustomSound: async () => null,
    readCustomSound: async () => new Uint8Array(),
    playSystemSound: async () => undefined,
    previewNativeSound: async () => undefined,
    onSoundsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
