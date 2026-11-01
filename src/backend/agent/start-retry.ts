/**
 * The start retry of a turn: what the drain does when a provider did not start a turn. See
 * `docs/architecture/agents.md#start-retry`.
 *
 * This is a domain policy of the drain, not a generic retry wrapper (AGENTS.md, Effect). It applies
 * only to a start that sent nothing to the provider, or that the provider refused before a turn
 * existed. A `turn/start` with no answer is never tried again here, because its turn can still run.
 */
import {
  type AgentModelChoice,
  type AgentProviderId,
  breakerHoldMs,
  DEFAULT_PROVIDER_ACCOUNT_ID,
  isAgentProvider,
  START_FALLBACK_DELAY_SECONDS,
  START_FALLBACK_RETRIES,
  START_RETRY_BUDGET_MS,
  type StartBreakerView,
  type StartRetrySettings,
  type StartRetryView,
  startRetryDelayMs,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { matchingSourceKeys, type SourceMessages } from "@openbot/i18n/source";
import { type CauseCode, classifyFailure } from "@openbot/telemetry";
import { isBalanceDiagnostic, isPlanLimitDiagnostic, isUsageLimitDiagnostic } from "./provider-diagnostics";

/**
 * `retry`: a brief failure that a wait can fix. `fallback`: a failure of the provider or the model,
 * which a wait does not fix, but another model can. `terminal`: nothing that the app tries fixes it.
 */
export type StartFailureClass = "retry" | "fallback" | "terminal";

export interface StartFailure {
  class: StartFailureClass;
  cause: CauseCode;
  /** The catalog key of the error, when the error is one of the app's own, else null. */
  errorKey: string | null;
  /** A usage limit, such as the 5-hour window of Claude. */
  usageLimit: boolean;
  /** When the provider said that the limit resets, in epoch milliseconds, or null. */
  resetsAtMs: number | null;
}

/** The app's own start errors that a wait can fix: a slow or busy model call before the turn. */
const RETRY_KEYS = [
  "error.agent.profileTimedOut",
  "error.agent.profileDisconnected",
  "error.agent.profileNotStarted",
  "error.agent.profileEndpointsChanged",
  "error.agent.profileGenerationBusy",
  "error.backend.channelHistoryArriving",
  "error.backend.channelHistoryInvalid",
  "error.provider.cliTimedOut",
] as const satisfies readonly (keyof SourceMessages)[];

/** The app's own start errors that another model can fix. */
const FALLBACK_KEYS = [
  "error.agent.endpointRemoved",
  "error.provider.noModel",
  "error.backend.channelLeadModelUnavailable",
] as const satisfies readonly (keyof SourceMessages)[];

/** The app's own start errors that no try fixes: the task, the agent or the request must change. */
const TERMINAL_KEYS = [
  "error.agent.fallbackUnavailable",
  "error.agent.gone",
  "error.backend.channelAssigneeUnavailable",
  "error.backend.channelAssigneeRemoved",
  "error.backend.channelAssigneeReassign",
  "error.backend.channelContextTooLong",
  "error.backend.channelRoutingTooLong",
  "error.backend.channelRoutingUnreadable",
  "error.backend.channelLeadRequired",
  "error.backend.channelTaskMemberRequired",
  "error.backend.channelRequestMemberRequired",
  "error.backend.channelMemberRequired",
  "error.backend.channelHistoryLeadRequired",
  "error.backend.channelAssignmentStopped",
  "error.backend.channelAssignmentChanged",
  "error.backend.threadArchived",
  "error.backend.turnNotStarted",
  "error.backend.shuttingDown",
] as const satisfies readonly (keyof SourceMessages)[];

/**
 * The catalog key of the error, when its text is the English of one of `keys`. A caller can wrap the
 * text, as in "Error: …", so the part after the last colon is read too.
 */
function keyOf(keys: readonly (keyof SourceMessages)[], message: string): string | null {
  const tail = message.slice(message.lastIndexOf(": ") + 2);
  const matched = new Set([...matchingSourceKeys(message.trim()), ...matchingSourceKeys(tail.trim())]);
  return keys.find((key) => matched.has(key)) ?? null;
}

/** A refusal of the request itself, such as a content policy: another try sends the same request. */
const REQUEST_REFUSED =
  /\b(?:invalid_request_error|content[ _-]?(?:policy|filter)|request (?:was )?blocked|prompt is too long|context(?:_length| length| window) exceeded)\b/iu;
/** A provider CLI that is missing or too old for the app. */
const CLI_MISSING = /\b(?:not downloaded|is too old|not installed|command not found)\b/iu;

/** The class of a start that failed. `message` is the redacted text of the failure. */
export function classifyStartFailure(
  error: unknown,
  message: string,
  settings: Pick<StartRetrySettings, "retryAfterUsageLimit">,
  now = Date.now(),
): StartFailure {
  const cause = classifyFailure(error instanceof Error || isDynamicRecord(error) ? error : message);
  const terminalKey = keyOf(TERMINAL_KEYS, message);
  const base = { cause, usageLimit: false, resetsAtMs: null };
  if (terminalKey) return { ...base, class: "terminal", errorKey: terminalKey };
  const retryKey = keyOf(RETRY_KEYS, message);
  if (retryKey) return { ...base, class: "retry", errorKey: retryKey };
  const fallbackKey = keyOf(FALLBACK_KEYS, message);
  if (fallbackKey) return { ...base, class: "fallback", errorKey: fallbackKey };
  if (isPlanLimitDiagnostic(message) || cause === "usage_limit") {
    // An account can move to another account by itself, so the window can be open again at the next try.
    return {
      ...base,
      class: settings.retryAfterUsageLimit ? "retry" : "fallback",
      errorKey: null,
      usageLimit: true,
      resetsAtMs: resetAtMs(message, now),
    };
  }
  // Money or a quota that no wait gives back.
  if (cause === "billing" || (isUsageLimitDiagnostic(message) && isBalanceDiagnostic(message)))
    return { ...base, class: "fallback", errorKey: null };
  if (cause === "authentication" || cause === "permission" || CLI_MISSING.test(message))
    return { ...base, class: "fallback", errorKey: null };
  if (
    cause === "invalid_upload_request" ||
    cause === "attachment_type_unsupported" ||
    cause === "attachment_too_large" ||
    cause === "cancelled" ||
    cause === "storage" ||
    REQUEST_REFUSED.test(message)
  )
    return { ...base, class: "terminal", errorKey: null };
  // An outage, a throttle, a network failure, a slow answer, or an error that names nothing: tries are
  // few and short, and they never run a turn twice.
  return { ...base, class: "retry", errorKey: null };
}

const CLOCK = /\b(?:try again at|resets?(?: at)?)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/iu;
const RELATIVE = /\b(?:try again|resets?) in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/iu;

/**
 * The reset that a limit message names, in epoch milliseconds, or null. "Try again at 10:34 AM" and
 * "resets 8:40pm" are read in the local time of this computer, as the CLI writes them; "resets in 2h
 * 10m" is read from now.
 */
export function resetAtMs(message: string, now = Date.now()): number | null {
  const relative = RELATIVE.exec(message);
  if (relative && (relative[1] || relative[2])) {
    const ms = (Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0)) * 60_000;
    return ms > 0 ? now + ms : null;
  }
  const clock = CLOCK.exec(message);
  if (!clock) return null;
  let hours = Number(clock[1]);
  const minutes = Number(clock[2] ?? 0);
  const meridiem = clock[3]?.toLowerCase().replaceAll(".", "");
  if (minutes > 59 || hours > 23 || (meridiem && (hours < 1 || hours > 12))) return null;
  if (meridiem === "pm" && hours !== 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/**
 * The start retry of one delivery, stored with it (`delivery_json.startRetry`), so it stays after a
 * restart. It has no text of the message or of the error: only the catalog key and the class.
 */
export interface StartRetryMarker {
  version: 1;
  phase: "retrying" | "fallback";
  /** The tries again so far in this phase. */
  attempt: number;
  max: number;
  /** When the next start may run, or null. */
  nextAt: string | null;
  firstFailedAt: string;
  /** The starts that failed so far, on every model. */
  starts: number;
  cause: CauseCode;
  errorKey: string | null;
  /** The model the agent failed on. */
  primary: AgentModelChoice;
  /** The backup model, for `fallback`. */
  fallback: AgentModelChoice | null;
}

export function isStartRetryMarker(value: unknown): value is StartRetryMarker {
  const choice = (item: unknown): item is AgentModelChoice =>
    isDynamicRecord(item) &&
    isString(item.provider) &&
    isString(item.model) &&
    (item.providerAccountId === undefined || isString(item.providerAccountId));
  return (
    isDynamicRecord(value) &&
    value.version === 1 &&
    (value.phase === "retrying" || value.phase === "fallback") &&
    isNumber(value.attempt) &&
    isNumber(value.max) &&
    (value.nextAt === null || (isString(value.nextAt) && Number.isFinite(Date.parse(value.nextAt)))) &&
    isString(value.firstFailedAt) &&
    Number.isFinite(Date.parse(value.firstFailedAt)) &&
    isNumber(value.starts) &&
    isString(value.cause) &&
    (value.errorKey === null || isString(value.errorKey)) &&
    choice(value.primary) &&
    (value.fallback === null || choice(value.fallback))
  );
}

export function startRetryView(marker: StartRetryMarker): StartRetryView {
  return {
    phase: marker.phase,
    attempt: marker.attempt,
    max: marker.max,
    nextAt: marker.nextAt,
    ...(marker.phase === "fallback" && marker.fallback ? { fallbackModel: marker.fallback.model } : {}),
  };
}

export type StartRetryStep =
  | { type: "retry"; marker: StartRetryMarker; delayMs: number }
  | { type: "fallback"; marker: StartRetryMarker }
  | { type: "fail"; marker: StartRetryMarker | null };

export interface StartRetryInput {
  failure: StartFailure;
  /** The marker of the delivery before this failure, or undefined for its first failure. */
  marker: StartRetryMarker | undefined;
  settings: StartRetrySettings;
  /** The model this start ran on. */
  primary: AgentModelChoice;
  /** The backup model that is ready now, or null. */
  fallback: AgentModelChoice | null;
  /** True when this start was the one try of the agent's own model after its breaker wait. */
  probing: boolean;
  now: number;
  random: number;
}

/**
 * What the drain does after one failed start. On the agent's own model: up to `retries` tries again
 * with a growing wait, for a brief failure only and within `START_RETRY_BUDGET_MS` of the first
 * failure; then the backup model. A probe after the breaker wait has no try again. On the backup
 * model: one start and `START_FALLBACK_RETRIES` tries again. Then the delivery fails.
 */
export function nextStartStep(input: StartRetryInput): StartRetryStep {
  const { failure, marker, settings, now } = input;
  if (failure.class === "terminal") return { type: "fail", marker: marker ?? null };
  const firstFailedAt = marker?.firstFailedAt ?? new Date(now).toISOString();
  const common = {
    version: 1 as const,
    firstFailedAt,
    starts: (marker?.starts ?? 0) + 1,
    cause: failure.cause,
    errorKey: failure.errorKey,
  };
  if (marker?.phase === "fallback") {
    if (marker.attempt >= START_FALLBACK_RETRIES) return { type: "fail", marker };
    const delayMs = Math.round(START_FALLBACK_DELAY_SECONDS * 1000 * (0.75 + 0.5 * input.random));
    return {
      type: "retry",
      delayMs,
      marker: {
        ...marker,
        ...common,
        attempt: marker.attempt + 1,
        nextAt: new Date(now + delayMs).toISOString(),
      },
    };
  }
  const attempt = marker?.attempt ?? 0;
  const max = input.probing ? 0 : settings.retries;
  const withinBudget = now - Date.parse(firstFailedAt) < START_RETRY_BUDGET_MS;
  if (failure.class === "retry" && attempt < max && withinBudget) {
    const delayMs = startRetryDelayMs(settings, attempt + 1, input.random);
    return {
      type: "retry",
      delayMs,
      marker: {
        ...common,
        phase: "retrying",
        attempt: attempt + 1,
        max,
        nextAt: new Date(now + delayMs).toISOString(),
        primary: marker?.primary ?? input.primary,
        fallback: null,
      },
    };
  }
  if (input.fallback)
    return {
      type: "fallback",
      marker: {
        ...common,
        phase: "fallback",
        attempt: 0,
        max: START_FALLBACK_RETRIES,
        nextAt: null,
        primary: marker?.primary ?? input.primary,
        fallback: input.fallback,
      },
    };
  return {
    type: "fail",
    marker: { ...common, phase: "retrying", attempt, max, nextAt: null, primary: input.primary, fallback: null },
  };
}

/** One agent's own model that failed to start turns: its turns run on a backup until `until`. */
export interface StoredStartBreaker {
  agentId: string;
  provider: AgentProviderId;
  providerAccountId: string | null;
  model: string;
  /** The failures in a row. */
  opens: number;
  until: string;
  /** True while the one try of the own model after the wait runs. */
  probing: boolean;
  /** The channel tasks that started on the backup: the agent stays there until they end. */
  pinnedTasks: string[];
}

export function isStoredStartBreaker(value: unknown): value is StoredStartBreaker {
  return (
    isDynamicRecord(value) &&
    isString(value.agentId) &&
    isAgentProvider(value.provider) &&
    (value.providerAccountId === null || isString(value.providerAccountId)) &&
    isString(value.model) &&
    isNumber(value.opens) &&
    Number.isInteger(value.opens) &&
    value.opens >= 1 &&
    isString(value.until) &&
    Number.isFinite(Date.parse(value.until)) &&
    typeof value.probing === "boolean" &&
    Array.isArray(value.pinnedTasks) &&
    value.pinnedTasks.length <= 100 &&
    value.pinnedTasks.every(isString)
  );
}

export interface StartBreakerStorage {
  read(): readonly StoredStartBreaker[];
  write(breakers: readonly StoredStartBreaker[]): void;
}

/** The longest that a closed breaker's memory of failures stays: after this, failures count from one again. */
const BREAKER_MEMORY_MS = 24 * 60 * 60_000;
const BREAKER_LIMIT = 200;
const PINNED_LIMIT = 100;

function choiceOf(entry: StoredStartBreaker): AgentModelChoice {
  return {
    provider: entry.provider,
    model: entry.model,
    ...(entry.providerAccountId ? { providerAccountId: entry.providerAccountId } : {}),
  };
}

/** The account of a choice, null for the provider's own sign-in. */
function accountOf(choice: AgentModelChoice): string | null {
  const accountId = choice.providerAccountId;
  return accountId && accountId !== DEFAULT_PROVIDER_ACCOUNT_ID ? accountId : null;
}

function breakerKey(agentId: string, choice: AgentModelChoice): string {
  return `${agentId}\u0000${choice.provider}\u0000${accountOf(choice) ?? ""}\u0000${choice.model}`;
}

/**
 * The breakers of the agents' own models, kept in a file so that a restart keeps them (a breaker of
 * one agent and model; never global). Holds ids, models and times only.
 */
export class StartBreakers {
  readonly #storage: StartBreakerStorage | null;
  readonly #entries = new Map<string, StoredStartBreaker>();

  constructor(storage: StartBreakerStorage | null, now = Date.now()) {
    this.#storage = storage;
    for (const entry of storage?.read() ?? []) {
      if (now - Date.parse(entry.until) > BREAKER_MEMORY_MS) continue;
      this.#entries.set(breakerKey(entry.agentId, choiceOf(entry)), { ...entry });
    }
  }

  get(agentId: string, choice: AgentModelChoice): StoredStartBreaker | undefined {
    return this.#entries.get(breakerKey(agentId, choice));
  }

  list(): StoredStartBreaker[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry, pinnedTasks: [...entry.pinnedTasks] }));
  }

  /** The breakers whose wait still runs, for the settings page. */
  views(now = Date.now()): StartBreakerView[] {
    return this.list()
      .filter((entry) => entry.probing || Date.parse(entry.until) > now)
      .map((entry) => ({
        agentId: entry.agentId,
        provider: entry.provider,
        model: entry.model,
        until: entry.until,
        opens: entry.opens,
        probing: entry.probing,
      }));
  }

  /**
   * The own model failed again: the wait starts, longer for each failure in a row. Answers the wait
   * in milliseconds.
   */
  open(
    agentId: string,
    choice: AgentModelChoice,
    settings: StartRetrySettings,
    now: number,
    random: number,
    resetsAtMs: number | null,
  ): number {
    const key = breakerKey(agentId, choice);
    const previous = this.#entries.get(key);
    const opens = (previous?.opens ?? 0) + 1;
    const holdMs = breakerHoldMs(settings, opens, random, resetsAtMs, now);
    this.#entries.set(key, {
      agentId,
      provider: choice.provider,
      providerAccountId: accountOf(choice),
      model: choice.model,
      opens,
      until: new Date(now + holdMs).toISOString(),
      probing: false,
      pinnedTasks: previous?.pinnedTasks ?? [],
    });
    this.#trim();
    this.#save();
    return holdMs;
  }

  /** The one try of the own model starts. */
  probing(agentId: string, choice: AgentModelChoice): void {
    const entry = this.get(agentId, choice);
    if (!entry || entry.probing) return;
    entry.probing = true;
    this.#save();
  }

  /** The own model started a turn: its turns run there again, and failures count from one. */
  close(agentId: string, choice: AgentModelChoice): boolean {
    const entry = this.get(agentId, choice);
    if (!entry || entry.pinnedTasks.length > 0) {
      if (entry?.probing) {
        entry.probing = false;
        this.#save();
      }
      return false;
    }
    this.#entries.delete(breakerKey(agentId, choice));
    this.#save();
    return true;
  }

  /** A channel task started on the backup model of this agent: it ends there. */
  pin(agentId: string, taskKey: string): void {
    let changed = false;
    for (const entry of this.#entries.values()) {
      if (entry.agentId !== agentId || entry.pinnedTasks.includes(taskKey)) continue;
      entry.pinnedTasks = [...entry.pinnedTasks, taskKey].slice(-PINNED_LIMIT);
      changed = true;
    }
    if (changed) this.#save();
  }

  /** The tasks pinned to the backup of this agent. */
  pinned(agentId: string): string[] {
    return [
      ...new Set([...this.#entries.values()].flatMap((entry) => (entry.agentId === agentId ? entry.pinnedTasks : []))),
    ];
  }

  /** Removes the pins of tasks that ended. */
  unpin(agentId: string, open: (taskKey: string) => boolean): void {
    let changed = false;
    for (const entry of this.#entries.values()) {
      if (entry.agentId !== agentId) continue;
      const kept = entry.pinnedTasks.filter(open);
      if (kept.length === entry.pinnedTasks.length) continue;
      entry.pinnedTasks = kept;
      changed = true;
    }
    if (changed) this.#save();
  }

  /** The agent was deleted. */
  forgetAgent(agentId: string): void {
    let changed = false;
    for (const [key, entry] of this.#entries)
      if (entry.agentId === agentId) {
        this.#entries.delete(key);
        changed = true;
      }
    if (changed) this.#save();
  }

  #trim(): void {
    while (this.#entries.size > BREAKER_LIMIT) {
      const oldest = [...this.#entries].sort(([, left], [, right]) => left.until.localeCompare(right.until))[0];
      if (!oldest) break;
      this.#entries.delete(oldest[0]);
    }
  }

  #save(): void {
    this.#storage?.write(this.list());
  }
}

/** The delay of a timer that waits for `nextAt`, never below zero. */
export function untilMs(nextAt: string | null, now = Date.now()): number {
  if (nextAt === null) return 0;
  const at = Date.parse(nextAt);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}
