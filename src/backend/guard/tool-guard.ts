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
import { Effect, Semaphore } from "effect";
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

/**
 * How many reviews may run at once. A check past the limit waits for a free slot within the same
 * deadline as the review itself; when none comes free, the review counts as `busy`.
 */
const MAX_REVIEWS_IN_FLIGHT = 4;
/** How long a verdict is kept for the same item, so a repeated item costs no second review. */
const VERDICT_TTL_MS = 10 * 60_000;
const VERDICT_CACHE_SIZE = 256;

const defaultLog: GuardLog = createBuildersBotLogger("guard");

export class ToolGuard {
  readonly #options: ToolGuardOptions;
  readonly #log: GuardLog;
  readonly #now: () => number;
  readonly #verdicts = new Map<string, { verdict: GuardJudgeVerdict; at: number }>();
  readonly #slots = Semaphore.makeUnsafe(MAX_REVIEWS_IN_FLIGHT);

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
    const judge: GuardJudgeOutcome = guardNeedsJudge(level, item.direction, triage)
      ? yield* this.#review(preference.judge, item, triage)
      : { kind: "not-needed" };
    const decision = decideGuard({ level, direction: item.direction, triage, judge });
    const result: GuardResult = { ...decision, durationMs: Math.round(this.#now() - started), judge: judge.kind };
    // Every finding is logged, an incomplete read too, with no content: names, verdicts and times only.
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
        incomplete: triage.incomplete,
        unplaced: triage.unplaced,
        ...(judge.kind === "verdict" ? { covered: judge.covered } : {}),
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
    const excerpt = judgeExcerpt(triage);
    // The key holds the whole text that the check read, not only the excerpt: two items with the
    // same excerpt can differ outside it, and a verdict on one must not answer for the other.
    const content = createHash("sha256").update(triage.text).digest("hex");
    const key = createHash("sha256")
      .update(JSON.stringify([item.direction, choice.provider, choice.model, subject, content, excerpt.text]))
      .digest("hex");
    const cached = this.#cached(key);
    if (cached) return { kind: "verdict", verdict: cached, covered: excerpt.covered } satisfies GuardJudgeOutcome;
    const prompt = guardJudgePrompt({
      direction: item.direction,
      subject,
      findings: triage.findings.map((finding) => finding.code),
      excerpt: excerpt.text,
    });
    // The wait for a slot counts in the deadline: a check never waits longer than one review.
    let started = false;
    const review = Effect.suspend(() => {
      started = true;
      return port.complete(choice, { system: GUARD_JUDGE_SYSTEM, prompt });
    }).pipe(Effect.map((text) => ({ text })));
    const reply = yield* this.#slots
      .withPermits(1)(review)
      .pipe(
        // A reviewer that hangs must not hold the tool call: the local check decides.
        Effect.timeoutOrElse({
          duration: this.#options.timeoutMs ?? port.timeoutMs ?? GUARD_JUDGE_TIMEOUT_MS,
          orElse: () => Effect.succeed(started ? ("timeout" as const) : ("busy" as const)),
        }),
        Effect.catch(() => Effect.succeed("error" as const)),
        Effect.catchDefect(() => Effect.succeed("error" as const)),
      );
    if (reply === "busy") return { kind: "failed", failure: "busy" } satisfies GuardJudgeOutcome;
    if (reply === "timeout" || reply === "error") return { kind: "failed", failure: reply } satisfies GuardJudgeOutcome;
    const verdict = decodeGuardJudgeReply(reply.text);
    if (!verdict) return { kind: "failed", failure: "invalid" } satisfies GuardJudgeOutcome;
    this.#remember(key, verdict);
    return { kind: "verdict", verdict, covered: excerpt.covered } satisfies GuardJudgeOutcome;
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

const CLEAN: GuardTriage = {
  level: "clean",
  category: "none",
  findings: [],
  hits: [],
  text: "",
  incomplete: false,
  unplaced: false,
};

/** The direction of an item, for callers that build one. */
export type { GuardDirection };
