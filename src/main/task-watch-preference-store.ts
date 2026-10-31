import { DEFAULT_TASK_WATCH_PREFERENCE, isTaskWatchPreference, type TaskWatchPreference } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

export const TASK_WATCH_PREFERENCE_FILE = "openbot-task-watch-v1.json";

/**
 * The task reviewer ("Revisor"): on or off, and the minutes with no sign of life before a task is
 * slow. It is experimental and off until the person turns it on. A file that is missing, damaged, of
 * another version or shape, or with a value out of range reads as the default, which is off. Writes
 * are chained, as the other preference stores chain theirs.
 */
export class TaskWatchPreferenceStore {
  readonly #path: string;
  #preference: TaskWatchPreference = { ...DEFAULT_TASK_WATCH_PREFERENCE };
  #writes = Semaphore.makeUnsafe(1);

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): TaskWatchPreference | null =>
          isDynamicRecord(parsed) && parsed.version === 1 && isTaskWatchPreference(parsed)
            ? { enabled: parsed.enabled, quietMinutes: parsed.quietMinutes }
            : null,
        ),
      );
      if (Result.isSuccess(loaded)) {
        if (loaded.success) this.#preference = loaded.success;
      } else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get(): TaskWatchPreference {
    return { ...this.#preference };
  }

  readonly set = Effect.fn("TaskWatchPreference.set")(function* (
    this: TaskWatchPreferenceStore,
    preference: TaskWatchPreference,
  ) {
    // The parser of the IPC input checks this first, so a value out of range here is a bug of the caller.
    if (!isTaskWatchPreference(preference)) return yield* Effect.die(new Error("Invalid task reviewer preference."));
    const next: TaskWatchPreference = { enabled: preference.enabled, quietMinutes: preference.quietMinutes };
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
