import {
  DEFAULT_GUARD_PREFERENCE,
  type GuardPreference,
  type GuardPreferenceChange,
  isGuardPreference,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { type PreferenceFileFailure, PreferenceStore } from "./preference-file";

/** The file of the Guard preference in the user data directory. */
export const GUARD_PREFERENCE_FILE = "openbot-guard-v1.json";

/**
 * The Guard setting of this computer: its level and its reviewer model.
 *
 * The Guard is on by default, at Light, with the fast Cultura Builder model as the reviewer. A file
 * that is missing, damaged, of another version or of another shape reads as the default, so a broken
 * file never turns the Guard off. Only the person turns it off.
 */
export class GuardPreferenceStore {
  readonly #store: PreferenceStore<GuardPreference>;

  constructor(path: string) {
    this.#store = new PreferenceStore({
      path,
      defaultValue: DEFAULT_GUARD_PREFERENCE,
      decode: (parsed) => {
        if (!isDynamicRecord(parsed) || parsed.version !== 1) return null;
        const value = { level: parsed.level, judge: parsed.judge };
        return isGuardPreference(value) ? value : null;
      },
    });
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return this.#store.load();
  }

  get(): GuardPreference {
    const value = this.#store.get();
    return { level: value.level, judge: value.judge ? { ...value.judge } : null };
  }

  readonly set = Effect.fn("GuardPreference.set")(function* (
    this: GuardPreferenceStore,
    change: GuardPreferenceChange,
  ) {
    const current = this.get();
    const next: GuardPreference = {
      level: change.level ?? current.level,
      judge: change.judge === undefined ? current.judge : change.judge,
    };
    // The IPC parser checks the change first, so a value of another shape here is a bug of the caller.
    if (!isGuardPreference(next)) return yield* Effect.die(new Error("Invalid Guard preference."));
    yield* this.#store.set(next);
    return this.get();
  });
}
