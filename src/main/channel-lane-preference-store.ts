import {
  DEFAULT_LOAD_LANE_PREFERENCE,
  isLoadLanePreference,
  LOAD_LANE_ORDER_LIMIT,
  type LoadLanePreference,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

/** One entry of each channel, in the order given, and no more than the limit. */
function normalized(preference: LoadLanePreference): LoadLanePreference {
  return { enabled: preference.enabled, order: [...new Set(preference.order)].slice(0, LOAD_LANE_ORDER_LIMIT) };
}

/**
 * The one-channel-at-a-time mode and the order of the channels the user chose first. The channel
 * service reads it each time it decides which channel starts, so it is held in memory after `load`.
 *
 * A file that is missing, unreadable as JSON or of another shape reads as the mode off, which is
 * how every channel ran before the setting existed. Writes are chained, as the other preference
 * stores chain theirs: an earlier write that lands last would store the value the user just changed.
 */
export class ChannelLanePreferenceStore {
  readonly #path: string;
  #preference: LoadLanePreference = { ...DEFAULT_LOAD_LANE_PREFERENCE };
  #writes = Semaphore.makeUnsafe(1);

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): LoadLanePreference | null =>
          isDynamicRecord(parsed) && parsed.version === 1 && isLoadLanePreference(parsed)
            ? normalized({ enabled: parsed.enabled, order: parsed.order })
            : null,
        ),
      );
      if (Result.isSuccess(loaded)) {
        if (loaded.success) this.#preference = loaded.success;
      } else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get(): LoadLanePreference {
    return { enabled: this.#preference.enabled, order: [...this.#preference.order] };
  }

  readonly set = Effect.fn("ChannelLanePreference.set")(function* (
    this: ChannelLanePreferenceStore,
    preference: LoadLanePreference,
  ) {
    const next = normalized(preference);
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
