// What the Guard does with one item, from the level, the local check and the reviewer. Pure: the
// same input always gives the same decision, so the policy is the part a test can hold.

import type { GuardAvailableLevel, GuardCategory } from "@openbot/contracts/ipc";
import type { GuardDirection, GuardJudgeVerdict } from "./guard-judge";
import { type GuardTriage, triageReason } from "./guard-triage";

/**
 * What happens to the item:
 * - `allow`: it passes as it is.
 * - `annotate`: content passes with a note to the agent that it is data, not instructions.
 * - `ask`: the person approves or declines first, on the approval card.
 * - `block`: it stops. No level that this version runs blocks by itself.
 */
export type GuardAction = "allow" | "annotate" | "ask" | "block";

/** Who decided: the level, the local check, the reviewer, or the local check after the reviewer gave nothing. */
export type GuardDecider = "off" | "local" | "model" | "fallback";

/** What the reviewer gave for one item. */
export type GuardJudgeOutcome =
  | { readonly kind: "not-needed" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly failure: "timeout" | "error" | "invalid" | "busy" }
  | { readonly kind: "verdict"; readonly verdict: GuardJudgeVerdict };

export interface GuardDecision {
  readonly action: GuardAction;
  readonly category: GuardCategory;
  /** A short English sentence for the person and the agent. Null when the item passes with no finding. */
  readonly reason: string | null;
  readonly by: GuardDecider;
}

/** Whether the reviewer must read this item. At Light, only an item that the local check calls suspicious. */
export function guardNeedsJudge(level: GuardAvailableLevel, triage: GuardTriage): boolean {
  return level === "light" && triage.level === "suspicious";
}

export const GUARD_ALLOW: GuardDecision = { action: "allow", category: "none", reason: null, by: "local" };

/**
 * The Light level. Its concern is prompt injection, and it must not stop the work:
 * - Clean: the item passes, and no model is asked.
 * - High: the person decides on the approval card. No model is asked, so it is fast, and a model
 *   that the same content could fool cannot clear it.
 * - Suspicious: the reviewer decides. Allow passes. Ask and block go to the person: Light never
 *   blocks by itself. With no verdict (no sign-in, a timeout, an error, a reply outside the
 *   schema), the local check decides: content passes with a note to the agent, and an action
 *   passes. The event is logged.
 */
export function decideGuard(input: {
  level: GuardAvailableLevel;
  direction: GuardDirection;
  triage: GuardTriage;
  judge: GuardJudgeOutcome;
}): GuardDecision {
  const { triage, judge } = input;
  if (input.level === "off") return { action: "allow", category: "none", reason: null, by: "off" };
  if (triage.level === "clean") return GUARD_ALLOW;
  const localReason = triageReason(triage);
  if (triage.level === "high") return { action: "ask", category: triage.category, reason: localReason, by: "local" };
  if (judge.kind === "verdict") {
    const { verdict } = judge;
    if (verdict.verdict === "allow") return { action: "allow", category: "none", reason: null, by: "model" };
    return {
      action: "ask",
      category: verdict.category === "none" ? triage.category : verdict.category,
      reason: verdict.reason,
      by: "model",
    };
  }
  return {
    action: input.direction === "inbound" ? "annotate" : "allow",
    category: triage.category,
    reason: localReason,
    by: "fallback",
  };
}
