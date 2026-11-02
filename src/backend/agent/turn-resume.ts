/**
 * The safe resume of a channel turn after a brief provider failure. See
 * `docs/architecture/agents.md#safe-turn-resume`.
 *
 * A 529 or a lost connection in the middle of a channel task used to stop the task until a person or
 * the task reviewer resumed it. With the advanced optimization `safe-resume` on, the turn continues by
 * itself in the same provider session, but only when the effect journal of the turn (`turn-effects.ts`)
 * says that nothing can happen twice. This file holds the pure part: the decision, the stored marker,
 * and the note that the continued turn reads.
 */
import type { AgentProviderId, StartRetryView } from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { CauseCode } from "@openbot/telemetry";
import type { EffectReach, EffectState, OwnToolCall, TurnEffect } from "./turn-effects";

/**
 * The app's own tools that reach people or other agents, and that the generic path of the tool router
 * runs for every provider. The router records each call (`OwnToolCalls`), so the app knows whether it
 * ran, and a resumed turn that calls one again with the same arguments gets "already done" in place
 * of a second action. A site change asks the person in another path, and a browser or Hub call has its
 * own path: the effect journal reads those from the provider's items, as outside steps.
 */
export const OWN_EXTERNAL_TOOLS: ReadonlySet<string> = new Set([
  "openbot.send_message",
  "openbot.channel_assign",
  "openbot.channel_transfer",
  "openbot.channel_result",
  "openbot.messaging_post",
  "openbot.create_agent",
  "openbot.update_agents",
  "openbot.interrupt_agent",
  "openbot.test_routine",
]);

/** The first line of the resume note that the continued turn reads before the request. */
export const TURN_RESUME_NOTE_START = "--- resume after a brief provider failure ---";
/** The last line of the resume note. */
export const TURN_RESUME_NOTE_END = "--- end of resume note ---";

/** The most continuations of one delivery. After them the task stops, as before, for the task reviewer. */
export const TURN_RESUME_MAX = 3;
/** The waits before each continuation, in seconds, 25% up or down at random. */
export const TURN_RESUME_DELAYS_SECONDS: readonly number[] = [15, 30, 60];

/**
 * The providers whose session the app keeps after a failed turn, so the continuation goes back into
 * it: Codex keeps its thread, Claude its session file, the ACP agents and Pi their sessions. A provider
 * session that is gone opens a new one with the Builders Bot transcript, as any turn does. A custom ACP
 * agent (`acp`) is left out: what it keeps after a failure is not known.
 */
export const TURN_RESUME_PROVIDERS: ReadonlySet<AgentProviderId> = new Set<AgentProviderId>([
  "codex",
  "claude",
  "grok",
  "opencode",
  "antigravity",
  "cursor",
  "cline",
  "pi",
  "muse",
  "inception",
  "deepseek",
  "openrouter",
  "cultura-builder",
]);

/** The brief failures that a wait can fix. A usage limit, a refusal or a sign-in is never one. */
export const TURN_RESUME_CAUSES: ReadonlySet<CauseCode> = new Set<CauseCode>([
  "provider_unavailable",
  "network",
  "timeout",
  "rate_limit",
]);

/** One step of the interrupted turns, as the note and the card read it. */
export interface ResumeEffect {
  /** A short name with no arguments: `git push`, `openbot.channel_assign`, `MCP slack.post_message`. */
  label: string;
  reach: EffectReach;
  state: EffectState;
  /** The redacted command of a shell step, for the provider. */
  detail?: string;
  /** A read-only command that shows whether it already ran. */
  check?: string;
}

/** A call to an own outside tool that ended with a result, for the repeat guard of the continued turn. */
export interface ResumeDoneCall {
  tool: string;
  digest: string;
}

/**
 * The safe resume of one delivery, stored with it (`delivery_json.turnResume`), so a restart keeps the
 * wait and the count. It keeps no text of the request, of a tool result or of the provider's error.
 */
export interface TurnResumeMarker {
  version: 1;
  /** The continuations so far, from 1. */
  attempt: number;
  max: number;
  /** When the continuation may start, or null when it started. */
  nextAt: string | null;
  firstFailedAt: string;
  cause: CauseCode;
  /** The provider turns of this delivery that failed, oldest first. */
  turnIds: string[];
  /** The local and outside steps of the failed turns, newest last. Reads are only counted. */
  effects: ResumeEffect[];
  /** The reads of the failed turns, which are safe to run again. */
  reads: number;
  doneCalls: ResumeDoneCall[];
  /**
   * The turn stopped for the person, because an outside step may already have happened. When the
   * person resumes the task, its next turn reads the note too (`ChannelService.carriedTurnResume`).
   */
  forPerson?: true;
}

const EFFECT_LIMIT = 24;
const DONE_CALL_LIMIT = 50;
const TURN_LIMIT = 10;
const LABEL_LIMIT = 80;
const DETAIL_LIMIT = 240;

const isEffectState = (value: unknown): value is EffectState =>
  value === "done" || value === "failed" || value === "uncertain";
const isReach = (value: unknown): value is EffectReach => value === "read" || value === "local" || value === "external";

function isResumeEffect(value: unknown): value is ResumeEffect {
  return (
    isDynamicRecord(value) &&
    isString(value.label) &&
    value.label.length <= LABEL_LIMIT &&
    isReach(value.reach) &&
    isEffectState(value.state) &&
    (value.detail === undefined || (isString(value.detail) && value.detail.length <= DETAIL_LIMIT)) &&
    (value.check === undefined || (isString(value.check) && value.check.length <= DETAIL_LIMIT))
  );
}

const isCount = (value: unknown, max: number): value is number =>
  isNumber(value) && Number.isInteger(value) && value >= 0 && value <= max;
const isTime = (value: unknown): value is string => isString(value) && Number.isFinite(Date.parse(value));

export function isTurnResumeMarker(value: unknown): value is TurnResumeMarker {
  return (
    isDynamicRecord(value) &&
    value.version === 1 &&
    isCount(value.attempt, 100) &&
    isCount(value.max, 100) &&
    (value.nextAt === null || isTime(value.nextAt)) &&
    isTime(value.firstFailedAt) &&
    isString(value.cause) &&
    Array.isArray(value.turnIds) &&
    value.turnIds.length <= TURN_LIMIT &&
    value.turnIds.every(isString) &&
    Array.isArray(value.effects) &&
    value.effects.length <= EFFECT_LIMIT &&
    value.effects.every(isResumeEffect) &&
    isCount(value.reads, 100_000) &&
    Array.isArray(value.doneCalls) &&
    value.doneCalls.length <= DONE_CALL_LIMIT &&
    value.doneCalls.every((call) => isDynamicRecord(call) && isString(call.tool) && isString(call.digest)) &&
    (value.forPerson === undefined || value.forPerson === true)
  );
}

/** The wait of a delivery that continues, as the channel task shows it ("resuming"). */
export function turnResumeView(marker: TurnResumeMarker): StartRetryView {
  return { phase: "resuming", attempt: marker.attempt, max: marker.max, nextAt: marker.nextAt };
}

/** The wait before continuation `attempt` (1 for the first), 25% up or down at random. */
export function turnResumeDelayMs(delays: readonly number[], attempt: number, random: number): number {
  const seconds = delays[Math.min(Math.max(1, attempt), delays.length) - 1] ?? TURN_RESUME_DELAYS_SECONDS[0] ?? 15;
  return Math.round(seconds * 1000 * (0.75 + 0.5 * Math.min(1, Math.max(0, random))));
}

export type TurnResumePlan =
  /** Continue: the steps that the note lists, and the own calls that the repeat guard knows. */
  | { kind: "resume"; effects: ResumeEffect[]; reads: number; doneCalls: ResumeDoneCall[]; uncertain: number }
  /** Stop for the person: these outside steps may already have happened. */
  | {
      kind: "ask";
      uncertain: ResumeEffect[];
      effects: ResumeEffect[];
      reads: number;
      doneCalls: ResumeDoneCall[];
    };

function resumeEffect(effect: Pick<TurnEffect, "label" | "reach" | "state" | "detail" | "check">): ResumeEffect {
  return {
    label: effect.label.slice(0, LABEL_LIMIT),
    reach: effect.reach,
    state: effect.state,
    ...(effect.detail ? { detail: effect.detail.slice(0, DETAIL_LIMIT) } : {}),
    ...(effect.check ? { check: effect.check.slice(0, DETAIL_LIMIT) } : {}),
  };
}

/**
 * Decides what a failed turn may do. `effects` is the journal of the turn; `ownCalls` is what the app's
 * tool router saw of its own outside tools, which replaces the provider's items of those tools: a call
 * that never reached the router did not run, and one whose handler returned a result is done. A handler
 * that failed or did not return is uncertain.
 *
 * The turn continues when each step is a read, a local change, or an outside step with a result. An
 * outside step with no result stops the task for the person, unless `resumeUncertain` is on: then the
 * note marks it, with the order to check it first.
 */
export function planTurnResume(input: {
  effects: readonly TurnEffect[];
  ownCalls: readonly OwnToolCall[];
  resumeUncertain: boolean;
}): TurnResumePlan {
  const steps: ResumeEffect[] = [];
  let reads = 0;
  for (const effect of input.effects) {
    // The router's record decides for these tools, below.
    if (effect.ownTool !== null && OWN_EXTERNAL_TOOLS.has(effect.ownTool)) continue;
    if (effect.reach === "read") reads += 1;
    else steps.push(resumeEffect(effect));
  }
  // A handler that returned an error may have acted in part, as a long post sends more than one
  // message: only a call that ended with a result is done.
  for (const call of input.ownCalls)
    steps.push({ label: call.tool, reach: "external", state: call.state === "done" ? "done" : "uncertain" });
  const uncertain = steps.filter((step) => step.reach === "external" && step.state === "uncertain");
  const doneCalls = input.ownCalls.flatMap((call) =>
    call.state === "done" ? [{ tool: call.tool, digest: call.digest }] : [],
  );
  if (uncertain.length > 0 && !input.resumeUncertain)
    return { kind: "ask", uncertain, effects: steps, reads, doneCalls };
  return { kind: "resume", effects: steps, reads, doneCalls, uncertain: uncertain.length };
}

/** The next marker of a delivery after one more failure, merged with what the earlier failures did. */
export function nextTurnResumeMarker(input: {
  previous: TurnResumeMarker | undefined;
  plan: Pick<TurnResumePlan, "effects" | "reads" | "doneCalls">;
  turnId: string;
  cause: CauseCode;
  delays: readonly number[];
  now: number;
  random: number;
}): { marker: TurnResumeMarker; delayMs: number } {
  const { previous, plan } = input;
  const attempt = (previous?.attempt ?? 0) + 1;
  const delayMs = turnResumeDelayMs(input.delays, attempt, input.random);
  const doneCalls = [...(previous?.doneCalls ?? []), ...plan.doneCalls];
  return {
    delayMs,
    marker: {
      version: 1,
      attempt,
      max: TURN_RESUME_MAX,
      nextAt: new Date(input.now + delayMs).toISOString(),
      firstFailedAt: previous?.firstFailedAt ?? new Date(input.now).toISOString(),
      cause: input.cause,
      turnIds: [...(previous?.turnIds ?? []), input.turnId].slice(-TURN_LIMIT),
      effects: [...(previous?.effects ?? []), ...plan.effects].slice(-EFFECT_LIMIT),
      reads: (previous?.reads ?? 0) + plan.reads,
      doneCalls: doneCalls
        .filter((call, index) => doneCalls.findIndex((other) => other.digest === call.digest) === index)
        .slice(-DONE_CALL_LIMIT),
    },
  };
}

/** The outside steps that may already have happened, as the card names them: "git push, MCP slack.post_message". */
export function uncertainActions(effects: readonly ResumeEffect[]): string {
  return [...new Set(effects.map((effect) => effect.label))].slice(0, 5).join(", ");
}

function line(effect: ResumeEffect): string {
  const detail = effect.detail && effect.detail !== effect.label ? `: ${effect.detail}` : "";
  return `- ${effect.label}${detail}`;
}

/**
 * The note that the continued turn reads before the request, in the same provider session. It names
 * what the failed turns did, so the model checks the state and does not do it again.
 */
export function turnResumeNote(marker: TurnResumeMarker): string {
  const done = marker.effects.filter((effect) => effect.state === "done");
  const failed = marker.effects.filter((effect) => effect.state === "failed");
  const uncertain = marker.effects.filter((effect) => effect.state === "uncertain");
  return [
    TURN_RESUME_NOTE_START,
    marker.forPerson
      ? `The provider failed in the middle of this task (${marker.cause}). The person was told that an outside step may already have happened, and the person resumed the task. This is the same task, not a new request.`
      : `The provider failed in the middle of this task (${marker.cause}), and Builders Bot continues it in the same session (try ${marker.attempt} of ${marker.max}). This is the same task, not a new request.`,
    "Check the current state before any outside action, such as a message, a post, a push, a pull request or a payment. Do not repeat anything that the list below says is done. Continue only with what is still missing. When the task is already complete, give its result.",
    ...(done.length > 0 ? ["Done before the failure, with a result:", ...done.map(line)] : []),
    ...(marker.reads > 0 ? [`Reads before the failure: ${marker.reads}. They are safe to run again.`] : []),
    ...(failed.length > 0
      ? ["Tried before the failure, and it failed, so it did not happen:", ...failed.map(line)]
      : []),
    ...(uncertain.length > 0
      ? [
          "No result came back for these outside steps, so they may already have happened. Before you do one again, check with a read-only step whether it happened, and do it only when it did not:",
          ...uncertain.map((effect) => `${line(effect)}${effect.check ? ` (check: ${effect.check})` : ""}`),
        ]
      : []),
    TURN_RESUME_NOTE_END,
  ].join("\n");
}

/** Whether `OWN_EXTERNAL_TOOLS` has this qualified tool name. */
export function isOwnExternalTool(tool: string): boolean {
  return OWN_EXTERNAL_TOOLS.has(tool);
}
