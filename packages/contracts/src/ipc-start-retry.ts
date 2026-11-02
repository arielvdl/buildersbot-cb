import { type AgentReasoningEffort, isReasoningEffort } from "./ipc-agent-identity";
import { type AgentModelChoice, isAgentModelChoice } from "./ipc-agents";
import { isBoolean, isDynamicRecord, isNumber, isString } from "./runtime-values";

export { isStartRetryView, type StartRetryView } from "./ipc-start-retry-view";

/**
 * What the app does when a provider does not start a turn: it tries again after a wait that grows,
 * then runs the turn on a backup model, then leaves the task to the task reviewer or the person.
 * Stored as `openbot-agent-start-retry-v1.json`; see `docs/architecture/agents.md#start-retry`.
 */
export interface StartRetrySettings {
  /** How many times a start that failed is tried again on the agent's own model, from 0 to 5. */
  retries: number;
  /** The wait before the first try again, in seconds. Each next wait is 3 times longer. */
  firstDelaySeconds: number;
  /** The longest wait between two tries, in seconds. */
  maxDelaySeconds: number;
  /**
   * True: a usage limit, such as the 5-hour window of Claude, is tried again like an outage, because an
   * account can move to another account by itself. False: a limit goes to the backup model at once.
   */
  retryAfterUsageLimit: boolean;
  /** The backup model of an agent that has no backup model of its own, or null for none. */
  defaultFallback: StartFallbackChoice | null;
  /**
   * The minutes that an agent stays on its backup model after its own model failed, one entry for each
   * failure in a row. The last entry repeats. After the wait, one turn tries the agent's own model.
   */
  breakerMinutes: number[];
  /**
   * With the advanced optimization `safe-resume` on: true also continues a channel turn after a brief
   * provider failure when an outside action of the turn, such as a post or a push, may already have
   * happened, and tells the agent to check it first. Off, or absent in a file of an earlier version,
   * such a task waits for the person.
   */
  resumeUncertainActions?: boolean;
}

/** A backup model, with the reasoning effort to use there. Absent effort keeps the agent's own when the model takes it. */
export interface StartFallbackChoice extends AgentModelChoice {
  reasoningEffort?: AgentReasoningEffort | undefined;
}

export const START_RETRY_MAX_RETRIES = 5;
export const START_RETRY_FACTOR = 3;
/** The longest time from the first failed start to the backup model, whatever tries are left. */
export const START_RETRY_BUDGET_MS = 15 * 60_000;
/** The backup model gets one start and this many tries again. */
export const START_FALLBACK_RETRIES = 1;
export const START_FALLBACK_DELAY_SECONDS = 30;
const MIN_DELAY_SECONDS = 1;
const MAX_DELAY_SECONDS = 900;
const MAX_BREAKER_MINUTES = 1440;
const BREAKER_STEPS = 6;

export const DEFAULT_START_RETRY_SETTINGS: StartRetrySettings = {
  retries: 3,
  firstDelaySeconds: 10,
  maxDelaySeconds: 300,
  retryAfterUsageLimit: true,
  defaultFallback: null,
  breakerMinutes: [5, 15, 30, 60],
};

function isWholeIn(value: unknown, min: number, max: number): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= min && value <= max;
}

export function isStartFallbackChoice(value: unknown): value is StartFallbackChoice {
  return (
    isAgentModelChoice(value) &&
    isDynamicRecord(value) &&
    (value.reasoningEffort === undefined || isReasoningEffort(value.reasoningEffort))
  );
}

export function isStartRetrySettings(value: unknown): value is StartRetrySettings {
  return (
    isDynamicRecord(value) &&
    isWholeIn(value.retries, 0, START_RETRY_MAX_RETRIES) &&
    isWholeIn(value.firstDelaySeconds, MIN_DELAY_SECONDS, MAX_DELAY_SECONDS) &&
    isWholeIn(value.maxDelaySeconds, MIN_DELAY_SECONDS, MAX_DELAY_SECONDS) &&
    value.maxDelaySeconds >= value.firstDelaySeconds &&
    isBoolean(value.retryAfterUsageLimit) &&
    (value.defaultFallback === null || isStartFallbackChoice(value.defaultFallback)) &&
    Array.isArray(value.breakerMinutes) &&
    value.breakerMinutes.length >= 1 &&
    value.breakerMinutes.length <= BREAKER_STEPS &&
    value.breakerMinutes.every((minutes) => isWholeIn(minutes, 1, MAX_BREAKER_MINUTES)) &&
    (value.resumeUncertainActions === undefined || isBoolean(value.resumeUncertainActions))
  );
}

/**
 * The wait before try `attempt` (1 for the first try again): `firstDelay × 3^(attempt − 1)`, at most
 * `maxDelay`, then 25% up or down at random, so that agents that failed together do not try together.
 * `random` is a number from 0 to 1.
 */
export function startRetryDelayMs(settings: StartRetrySettings, attempt: number, random: number): number {
  const base = Math.min(
    settings.maxDelaySeconds,
    settings.firstDelaySeconds * START_RETRY_FACTOR ** Math.max(0, attempt - 1),
  );
  return Math.round(base * 1000 * (0.75 + 0.5 * Math.min(1, Math.max(0, random))));
}

/** The waits without the random part, in seconds, for the settings page. */
export function startRetryDelaysSeconds(settings: StartRetrySettings): number[] {
  return Array.from({ length: settings.retries }, (_value, index) =>
    Math.min(settings.maxDelaySeconds, settings.firstDelaySeconds * START_RETRY_FACTOR ** index),
  );
}

/**
 * How long the agent's own model is passed over after its `opens`-th failure in a row (1 for the
 * first), 20% up or down at random. A reset that the provider named counts when it is later.
 */
export function breakerHoldMs(
  settings: StartRetrySettings,
  opens: number,
  random: number,
  resetsAtMs: number | null = null,
  now = Date.now(),
): number {
  const steps = settings.breakerMinutes;
  const minutes = steps[Math.min(Math.max(1, opens), steps.length) - 1] ?? steps.at(-1) ?? 5;
  const hold = Math.round(minutes * 60_000 * (0.8 + 0.4 * Math.min(1, Math.max(0, random))));
  return resetsAtMs !== null && resetsAtMs - now > hold ? resetsAtMs - now : hold;
}

/** An agent whose own model failed to start turns, so its turns run on a backup model until `until`. */
export interface StartBreakerView {
  agentId: string;
  provider: string;
  model: string;
  /** When one turn tries the agent's own model again. */
  until: string;
  /** The failures in a row. */
  opens: number;
  /** True while the one turn that tries the agent's own model again runs. */
  probing: boolean;
}

/** The settings and the agents that run on a backup model now. */
export interface StartRetryState {
  settings: StartRetrySettings;
  breakers: StartBreakerView[];
}

export const START_BREAKER_VIEW_LIMIT = 200;

function isStartBreakerView(value: unknown): value is StartBreakerView {
  return (
    isDynamicRecord(value) &&
    isString(value.agentId) &&
    value.agentId.length <= 200 &&
    isString(value.provider) &&
    value.provider.length <= 100 &&
    isString(value.model) &&
    value.model.length <= 200 &&
    isString(value.until) &&
    Number.isFinite(Date.parse(value.until)) &&
    isWholeIn(value.opens, 0, 10_000) &&
    isBoolean(value.probing)
  );
}

export function isStartRetryState(value: unknown): value is StartRetryState {
  return (
    isDynamicRecord(value) &&
    isStartRetrySettings(value.settings) &&
    Array.isArray(value.breakers) &&
    value.breakers.length <= START_BREAKER_VIEW_LIMIT &&
    value.breakers.every(isStartBreakerView)
  );
}
