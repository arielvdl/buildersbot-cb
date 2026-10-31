import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

/**
 * The files in `userData` where earlier versions kept data for the analytics service of the upstream
 * OpenBot project: the failure report queue (with the account ID as its profile, and the temporary
 * file of its atomic write) and the day of the last inventory event.
 *
 * Builders Bot does not read them (phase 0 of `.openbot-build/bug-reports/DESIGN.md`). An earlier
 * version that opens the same profile would send the queue, so the app deletes these files on start.
 * The analytics preference file stays: its format stays readable.
 */
export const STALE_TELEMETRY_QUEUE_FILES = [
  "openbot-error-reports-v1.json",
  "openbot-error-reports-v1.json.tmp",
  "openbot-analytics-inventory-v1.json",
] as const;

/** Deletes the stale queue files. A file that is missing or that cannot be deleted does not stop the start. */
export const removeStaleTelemetryQueues = Effect.fn("removeStaleTelemetryQueues")(function* (userDataPath: string) {
  yield* Effect.forEach(
    STALE_TELEMETRY_QUEUE_FILES,
    (file) => Effect.tryPromise(() => rm(join(userDataPath, file), { force: true })).pipe(Effect.ignore),
    { concurrency: "unbounded", discard: true },
  );
});
