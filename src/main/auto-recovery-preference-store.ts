import {
  type AutoRecoveryPreference,
  DEFAULT_AUTO_RECOVERY_PREFERENCE,
  isAutoRecoveryPreference,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

/**
 * The automatic recovery of stopped work: on or off, how many minutes before a stopped task starts
 * again, and whether it may go to another agent. It is off until the person turns it on. A file that is
 * missing, damaged, of another shape, or with a value out of range reads as the default, which is off.
 * Writes are chained, as the other preference stores chain theirs.
 */
export class AutoRecoveryPreferenceStore {
  readonly #path: string;
  #preference: AutoRecoveryPreference = { ...DEFAULT_AUTO_RECOVERY_PREFERENCE };
  #writes = Semaphore.makeUnsafe(1);

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): AutoRecoveryPreference | null =>
          isDynamicRecord(parsed) && parsed.version === 1 && isAutoRecoveryPreference(parsed)
            ? { enabled: parsed.enabled, intervalMinutes: parsed.intervalMinutes, reassign: parsed.reassign }
            : null,
        ),
      );
      if (Result.isSuccess(loaded)) {
        if (loaded.success) this.#preference = loaded.success;
      } else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get(): AutoRecoveryPreference {
    return { ...this.#preference };
  }

  readonly set = Effect.fn("AutoRecoveryPreference.set")(function* (
    this: AutoRecoveryPreferenceStore,
    preference: AutoRecoveryPreference,
  ) {
    // The parser of the IPC input checks this first, so a value out of range here is a bug of the caller.
    if (!isAutoRecoveryPreference(preference)) return yield* Effect.die(new Error("Invalid recovery preference."));
    const next: AutoRecoveryPreference = {
      enabled: preference.enabled,
      intervalMinutes: preference.intervalMinutes,
      reassign: preference.reassign,
    };
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
