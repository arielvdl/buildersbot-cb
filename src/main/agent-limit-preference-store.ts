import {
  type AgentLimitPreference,
  DEFAULT_AGENT_LIMIT_PREFERENCE,
  isAgentLimitPreference,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

/**
 * The cap on the agents that run at the same time: on or off, and the most agents. It is off until
 * the person turns it on. A file that is missing, damaged, of another shape, or with a value out of
 * range reads as the default, which is off. Writes are chained, as the other preference stores chain
 * theirs.
 */
export class AgentLimitPreferenceStore {
  readonly #path: string;
  #preference: AgentLimitPreference = { ...DEFAULT_AGENT_LIMIT_PREFERENCE };
  #writes = Semaphore.makeUnsafe(1);

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): AgentLimitPreference | null =>
          isDynamicRecord(parsed) && parsed.version === 1 && isAgentLimitPreference(parsed)
            ? { enabled: parsed.enabled, max: parsed.max }
            : null,
        ),
      );
      if (Result.isSuccess(loaded)) {
        if (loaded.success) this.#preference = loaded.success;
      } else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get(): AgentLimitPreference {
    return { ...this.#preference };
  }

  /** The most agents that may run now, or null while the cap is off. */
  limit(): number | null {
    return this.#preference.enabled ? this.#preference.max : null;
  }

  readonly set = Effect.fn("AgentLimitPreference.set")(function* (
    this: AgentLimitPreferenceStore,
    preference: AgentLimitPreference,
  ) {
    // The parser of the IPC input checks this first, so a value out of range here is a bug of the caller.
    if (!isAgentLimitPreference(preference)) return yield* Effect.die(new Error("Invalid agent limit preference."));
    const next: AgentLimitPreference = { enabled: preference.enabled, max: preference.max };
    yield* this.#writes.withPermit(
      Effect.uninterruptible(
        writePreferenceFile(this.#path, { version: 1, ...next }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.#preference = next;
            }),
          ),
        ),
      ),
    );
    return this.get();
  });
}
