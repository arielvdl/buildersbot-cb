import { isDynamicRecord, isNumber, isString } from "./runtime-values";

/** A start that the app tries again, as the channel task and the queue show it. */
export interface StartRetryView {
  /** `retrying`: on the agent's own model. `fallback`: on the backup model. */
  phase: "retrying" | "fallback";
  /** The tries again so far. */
  attempt: number;
  /** The most tries again in this phase. */
  max: number;
  /** When the next try starts, or null when it starts as soon as the queue lets it. */
  nextAt: string | null;
  /** The backup model, for `fallback`. */
  fallbackModel?: string | undefined;
}

export function isStartRetryView(value: unknown): value is StartRetryView {
  return (
    isDynamicRecord(value) &&
    (value.phase === "retrying" || value.phase === "fallback") &&
    isCount(value.attempt) &&
    isCount(value.max) &&
    (value.nextAt === null || (isString(value.nextAt) && Number.isFinite(Date.parse(value.nextAt)))) &&
    (value.fallbackModel === undefined || (isString(value.fallbackModel) && value.fallbackModel.length <= 200))
  );
}

function isCount(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0 && value <= 100;
}
