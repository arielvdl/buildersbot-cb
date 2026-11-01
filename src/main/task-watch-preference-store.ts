import {
  DEFAULT_TASK_WATCH_PREFERENCE,
  isTaskWatchEvent,
  isTaskWatchPreference,
  TASK_WATCH_RECENT_LIMIT,
  type TaskWatchEvent,
  type TaskWatchPreference,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import {
  type PreferenceFileFailure,
  PreferenceStore,
  readPreferenceFile,
  writePreferenceFile,
} from "./preference-file";

export const TASK_WATCH_PREFERENCE_FILE = "openbot-task-watch-v1.json";
/** The last actions of the task reviewer, so the page shows them after a restart. */
export const TASK_WATCH_HISTORY_FILE = "openbot-task-watch-history-v1.json";

/**
 * The last `TASK_WATCH_RECENT_LIMIT` actions of the task reviewer: the time, the channel name, the
 * action, the reason, the minutes and who decided. Never the request or the words of an agent. A file
 * that is missing or damaged reads as no action; an event that does not decode is left out.
 */
export function createTaskWatchHistoryStore(path: string): PreferenceStore<{ events: TaskWatchEvent[] }> {
  return new PreferenceStore<{ events: TaskWatchEvent[] }>({
    path,
    defaultValue: { events: [] },
    decode: (parsed) =>
      isDynamicRecord(parsed) && parsed.version === 1 && Array.isArray(parsed.events)
        ? { events: parsed.events.filter(isTaskWatchEvent).slice(0, TASK_WATCH_RECENT_LIMIT) }
        : null,
  });
}

/**
 * The task reviewer ("Fiscal" in Portuguese): on or off, and the minutes with no sign of life before a task is
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
