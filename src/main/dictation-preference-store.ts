import {
  DEFAULT_DICTATION_PREFERENCE,
  type DictationPreference,
  type DictationPreferenceChange,
  isDictationPreference,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { PreferenceStore } from "./preference-file";

/**
 * The global dictation combination of this computer.
 *
 * It is off by default: a global combination takes a key from every other app, so the user chooses
 * whether to spend one. A file that is missing or unreadable reads as the default.
 */
export class DictationPreferenceStore {
  readonly #store: PreferenceStore<DictationPreference>;

  constructor(path: string) {
    this.#store = new PreferenceStore({
      path,
      defaultValue: DEFAULT_DICTATION_PREFERENCE,
      decode: (parsed) => {
        if (!isDynamicRecord(parsed)) return null;
        const { version: _version, ...rest } = parsed;
        // The engine arrived after the first release: a file without one keeps its other choices.
        const value = { ...rest, engine: rest.engine ?? "auto" };
        return isDictationPreference(value) ? value : null;
      },
    });
  }

  load(): Effect.Effect<void, import("./preference-file").PreferenceFileFailure> {
    return this.#store.load();
  }

  get(): DictationPreference {
    return this.#store.get();
  }

  readonly set = Effect.fn("DictationPreference.set")(function* (
    this: DictationPreferenceStore,
    change: DictationPreferenceChange,
  ) {
    const current = this.#store.get();
    return yield* this.#store.set({
      enabled: change.enabled ?? current.enabled,
      accelerator: change.accelerator ?? current.accelerator,
      mode: change.mode ?? current.mode,
      engine: change.engine ?? current.engine,
    });
  }).bind(this);
}
