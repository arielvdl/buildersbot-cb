import {
  DEFAULT_SECURITY_GUARD_PREFERENCE,
  isSecurityGuardPreference,
  type SecurityGuardPreference,
  type SecurityGuardPreferenceChange,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { PreferenceStore } from "./preference-file";

/**
 * The security reviewer setting of this computer.
 *
 * It is on by default, and a file that is missing or unreadable reads as the default. The reviewer
 * reads every message the user sends until the user turns it off or narrows it to messages that a
 * local scan marks.
 */
export class SecurityGuardService {
  readonly #store: PreferenceStore<SecurityGuardPreference>;

  constructor(path: string) {
    this.#store = new PreferenceStore({
      path,
      defaultValue: DEFAULT_SECURITY_GUARD_PREFERENCE,
      decode: (parsed) => {
        if (!isDynamicRecord(parsed)) return null;
        const { version: _version, ...rest } = parsed;
        return isSecurityGuardPreference(rest) ? rest : null;
      },
    });
  }

  load(): Effect.Effect<void, import("./preference-file").PreferenceFileFailure> {
    return this.#store.load();
  }

  get(): SecurityGuardPreference {
    return this.#store.get();
  }

  readonly set = Effect.fn("SecurityGuard.set")(function* (
    this: SecurityGuardService,
    change: SecurityGuardPreferenceChange,
  ) {
    const current = this.#store.get();
    return yield* this.#store.set({
      enabled: change.enabled ?? current.enabled,
      scope: change.scope ?? current.scope,
      mode: change.mode ?? current.mode,
      minLevel: change.minLevel ?? current.minLevel,
      model: change.model === undefined ? current.model : change.model,
      timeoutMs: change.timeoutMs ?? current.timeoutMs,
    });
  }).bind(this);
}
