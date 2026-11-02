// The advanced optimizations (beta): switches that change how the app runs agents, each one off until
// the person turns it on. With every switch off the app behaves as before the switches existed. The
// host process that runs the agents reads them (`optimizationEnabled` of `src/backend/optimizations.ts`),
// and each host keeps its own file. See `docs/architecture/optimizations.md`.
import { isBoolean, isDynamicRecord } from "./runtime-values";

/**
 * The closed list of switches, in the order the Settings page shows them. Each one is off by default. A
 * new switch is one line here, its text in the `settings` catalog, and the code that reads it. An id
 * that is not in this list is not a switch of this version: a payload with one is refused, and a state
 * or a file with one reads without it, so an older app ignores a newer switch.
 */
export const OPTIMIZATION_IDS = [
  "queue-priority-user",
  "idle-release-low",
  "fiscal-resume-grace",
  "turn-start-unify",
  "channel-context-spill",
  "safe-resume",
  "routing",
  "streaming-checkpoints",
] as const;
export type OptimizationId = (typeof OPTIMIZATION_IDS)[number];

/** What the Settings page reads and what a change answers: the switches that are on, in list order. */
export interface OptimizationState {
  on: OptimizationId[];
}

/** One switch to set. A switch that a change does not name keeps its value. */
export interface OptimizationChange {
  id: OptimizationId;
  enabled: boolean;
}

/** A change of one or more switches, such as one switch, or every switch for "Turn all on". */
export interface SetOptimizationsInput {
  changes: OptimizationChange[];
}

export function isOptimizationId(value: unknown): value is OptimizationId {
  return OPTIMIZATION_IDS.some((id) => id === value);
}

/** The known ids of a list, once each and in list order. Any other value is left out. */
export function knownOptimizationIds(value: unknown): OptimizationId[] {
  if (!Array.isArray(value)) return [];
  const listed = new Set(value);
  return OPTIMIZATION_IDS.filter((id) => listed.has(id));
}

/** The answer of main. An id that this version does not know is left out by `knownOptimizationIds`. */
export function isOptimizationState(value: unknown): value is OptimizationState {
  return isDynamicRecord(value) && Array.isArray(value.on) && value.on.every((id) => typeof id === "string");
}

/** A change from the renderer: one to `OPTIMIZATION_IDS.length` known ids, each one at most once. */
export function isSetOptimizationsInput(value: unknown): value is SetOptimizationsInput {
  if (!isDynamicRecord(value) || !Array.isArray(value.changes)) return false;
  const { changes } = value;
  if (changes.length === 0 || changes.length > OPTIMIZATION_IDS.length) return false;
  const seen = new Set<unknown>();
  for (const change of changes) {
    if (!isDynamicRecord(change) || !isOptimizationId(change.id) || !isBoolean(change.enabled)) return false;
    if (seen.has(change.id)) return false;
    seen.add(change.id);
  }
  return true;
}
