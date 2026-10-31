// The Guard at run time: one check for each item that enters or leaves an agent's work. It reads
// the preference at each check, runs the local check, asks the reviewer only for a suspicious item,
// and returns the decision. A check never fails: a broken reviewer gives the local decision.

import { createHash } from "node:crypto";
import {
  GUARD_JUDGE_TIMEOUT_MS,
  type GuardJudgeChoice,
  type GuardPreference,
  guardEffectiveLevel,
} from "@openbot/contracts/ipc";
import { createBuildersBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { judgeExcerpt, judgeSubject } from "./guard-excerpt";
import {
  decodeGuardJudgeReply,
  GUARD_JUDGE_SYSTEM,
  type GuardDirection,
  type GuardJudgeVerdict,
  type GuardModelPort,
  guardJudgePrompt,
} from "./guard-judge";
import { decideGuard, type GuardDecision, type GuardJudgeOutcome, guardNeedsJudge } from "./guard-policy";
import { type GuardOutboundItem, type GuardTriage, triageAction, triageContent } from "./guard-triage";

/** One item to check. `subject` names it for the reviewer and the log, such as a tool and a host. */
export type GuardItem =
  | { readonly direction: "inbound"; readonly tool: string; readonly subject: string; readonly content: string }
  | { readonly direction: "outbound"; readonly subject: string; readonly action: GuardOutboundItem };

export interface GuardResult extends GuardDecision {
  readonly durationMs: number;
  /** What the reviewer gave, for the log. */
  readonly judge: GuardJudgeOutcome["kind"];
}

/** The log of the Guard: verdict, category and time only, never the content. */
export interface GuardLog {
  info(message: string, fields: Record<string, string | number | boolean>): void;
}

export interface ToolGuardOptions {
  preference(): GuardPreference;
  /** The ways to reach a reviewer. The first that serves the chosen model is used. */
  models: readonly GuardModelPort[];
  log?: GuardLog;
  /** Tests give a shorter deadline. */
  timeoutMs?: number;
  now?: () => number;
}

/** How many reviews may run at once. A check past the limit decides with the local check. */
const MAX_REVIEWS_IN_FLIGHT = 4;
/** How long a verdict is kept for the same item, so a repeated item costs no second review. */
const VERDICT_TTL_MS = 10 * 60_000;
const VERDICT_CACHE_SIZE = 256;

const defaultLog: GuardLog = createBuildersBotLogger("guard");

/** The text of an outbound item as the reviewer reads it. */
function actionText(action: GuardOutboundItem): string {
  return [
    `Tool: ${action.tool}`,
    ...(action.command ? [`Command: ${action.command}`] : []),
    ...(action.urls && action.urls.length > 0 ? [`URLs: ${action.urls.join(" ")}`] : []),
    ...(action.payload ? [`Text sent: ${action.payload}`] : []),
  ].join("\n");
}

export class ToolGuard {
  readonly #options: ToolGuardOptions;
  readonly #log: GuardLog;
  readonly #now: () => number;
  readonly #verdicts = new Map<string, { verdict: GuardJudgeVerdict; at: number }>();
  #inFlight = 0;

  constructor(options: ToolGuardOptions) {
    this.#options = options;
    this.#log = options.log ?? defaultLog;
    this.#now = options.now ?? (() => performance.now());
  }

  /** Whether the Guard is on. Off, the hooks skip their work. */
  enabled(): boolean {
    return guardEffectiveLevel(this.#options.preference().level) !== "off";
  }

  /** Whether the chosen reviewer can run now. False with no reviewer, or with no sign-in. */
  judgeReady(): boolean {
    const choice = this.#options.preference().judge;
    if (!choice) return false;
    return this.#port(choice)?.ready(choice) ?? false;
  }

  #port(choice: GuardJudgeChoice): GuardModelPort | undefined {
    return this.#options.models.find((port) => port.serves(choice));
  }

  /** Checks one item. It never fails. */
  readonly check = Effect.fn("ToolGuard.check")(function* (this: ToolGuard, item: GuardItem) {
    const started = this.#now();
    const preference = this.#options.preference();
    const level = guardEffectiveLevel(preference.level);
    if (level === "off") {
      const off = decideGuard({ level, direction: item.direction, triage: CLEAN, judge: { kind: "not-needed" } });
      return { ...off, durationMs: 0, judge: "not-needed" } satisfies GuardResult;
    }
    const triage = item.direction === "inbound" ? triageContent(item.content) : triageAction(item.action);
    const judge: GuardJudgeOutcome = guardNeedsJudge(level, triage)
      ? yield* this.#review(preference.judge, item, triage)
      : { kind: "not-needed" };
    const decision = decideGuard({ level, direction: item.direction, triage, judge });
    const result: GuardResult = { ...decision, durationMs: Math.round(this.#now() - started), judge: judge.kind };
    if (triage.level !== "clean") {
      this.#log.info("The Guard checked an item.", {
        direction: item.direction,
        tool: item.direction === "outbound" ? item.action.tool : item.tool,
        triage: triage.level,
        action: result.action,
        category: result.category,
        by: result.by,
        judge: result.judge,
        durationMs: result.durationMs,
        truncated: triage.truncated,
      });
    }
    return result;
  });

  readonly #review = Effect.fn("ToolGuard.review")(function* (
    this: ToolGuard,
    choice: GuardJudgeChoice | null,
    item: GuardItem,
    triage: GuardTriage,
  ) {
    if (!choice) return { kind: "unavailable" } satisfies GuardJudgeOutcome;
    const port = this.#port(choice);
    if (!port?.ready(choice)) return { kind: "unavailable" } satisfies GuardJudgeOutcome;
    const subject = judgeSubject(item.subject);
    const excerpt = judgeExcerpt(item.direction === "inbound" ? item.content : actionText(item.action));
    const key = createHash("sha256")
      .update(JSON.stringify([item.direction, choice.provider, choice.model, subject, excerpt]))
      .digest("hex");
    const cached = this.#cached(key);
    if (cached) return { kind: "verdict", verdict: cached } satisfies GuardJudgeOutcome;
    if (this.#inFlight >= MAX_REVIEWS_IN_FLIGHT) return { kind: "failed", failure: "busy" } satisfies GuardJudgeOutcome;
    this.#inFlight += 1;
    const prompt = guardJudgePrompt({
      direction: item.direction,
      subject,
      findings: triage.findings.map((finding) => finding.code),
      excerpt,
    });
    const reply = yield* port.complete(choice, { system: GUARD_JUDGE_SYSTEM, prompt }).pipe(
      Effect.map((text) => ({ text })),
      // A reviewer that hangs must not hold the tool call: the local check decides.
      Effect.timeoutOrElse({
        duration: this.#options.timeoutMs ?? port.timeoutMs ?? GUARD_JUDGE_TIMEOUT_MS,
        orElse: () => Effect.succeed("timeout" as const),
      }),
      Effect.catch(() => Effect.succeed("error" as const)),
      Effect.catchDefect(() => Effect.succeed("error" as const)),
      Effect.ensuring(
        Effect.sync(() => {
          this.#inFlight -= 1;
        }),
      ),
    );
    if (reply === "timeout" || reply === "error") return { kind: "failed", failure: reply } satisfies GuardJudgeOutcome;
    const verdict = decodeGuardJudgeReply(reply.text);
    if (!verdict) return { kind: "failed", failure: "invalid" } satisfies GuardJudgeOutcome;
    this.#remember(key, verdict);
    return { kind: "verdict", verdict } satisfies GuardJudgeOutcome;
  });

  #cached(key: string): GuardJudgeVerdict | null {
    const entry = this.#verdicts.get(key);
    if (!entry) return null;
    if (this.#now() - entry.at > VERDICT_TTL_MS) {
      this.#verdicts.delete(key);
      return null;
    }
    return entry.verdict;
  }

  #remember(key: string, verdict: GuardJudgeVerdict): void {
    this.#verdicts.delete(key);
    this.#verdicts.set(key, { verdict, at: this.#now() });
    while (this.#verdicts.size > VERDICT_CACHE_SIZE) {
      const oldest = this.#verdicts.keys().next().value;
      if (oldest === undefined) break;
      this.#verdicts.delete(oldest);
    }
  }
}

const CLEAN: GuardTriage = { level: "clean", category: "none", findings: [], truncated: false };

/** The direction of an item, for callers that build one. */
export type { GuardDirection };
