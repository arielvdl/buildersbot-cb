// What the Guard does with one item, from the level, the local check and the reviewer. Pure: the
// same input always gives the same decision, so the policy is the part a test can hold.

import type { GuardAvailableLevel, GuardCategory } from "@openbot/contracts/ipc";
import type { GuardDirection, GuardJudgeVerdict } from "./guard-judge";
import { type GuardTriage, guardFindingNeedsReview, triageReason } from "./guard-triage";

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
  /**
   * `covered` is false when the excerpt did not show every place that the local check marked. The
   * reviewer can then make the item ask, but it cannot clear it.
   */
  | { readonly kind: "verdict"; readonly verdict: GuardJudgeVerdict; readonly covered: boolean };

export interface GuardDecision {
  readonly action: GuardAction;
  readonly category: GuardCategory;
  /** A short English sentence for the person and the agent. Null when the item passes with no finding. */
  readonly reason: string | null;
  readonly by: GuardDecider;
}

/**
 * Whether the reviewer must read this item. At Light, only an item that the local check calls
 * suspicious, and that has a marked place to show. An item that is suspicious only because it was not
 * read in full, or for a finding with no place, gives the reviewer nothing to judge: the local check
 * decides it, and nothing is sent. An action that was not read in full goes to the person, so it
 * needs no review either.
 */
export function guardNeedsJudge(level: GuardAvailableLevel, direction: GuardDirection, triage: GuardTriage): boolean {
  if (level !== "light" || triage.level !== "suspicious") return false;
  if (direction === "outbound" && triage.incomplete) return false;
  return triage.hits.some((hit) => guardFindingNeedsReview(hit.code));
}

export const GUARD_ALLOW: GuardDecision = { action: "allow", category: "none", reason: null, by: "local" };

/**
 * The Light level. Its concern is prompt injection, and it must not stop the work:
 * - Clean: the item passes, and no model is asked.
 * - High: the person decides on the approval card. No model is asked, so it is fast, and a model
 *   that the same content could fool cannot clear it.
 * - An action that the check could not read in full: the person decides. Light still never stops
 *   ordinary work: no real action comes near the limits, and reading one is fast.
 * - Suspicious: the reviewer decides. Allow passes, but only when the excerpt showed every marked
 *   place. Ask and block go to the person: Light never blocks by itself. An allow on an excerpt that
 *   did not show everything does not clear the item: content passes with a note to the agent, and an
 *   action goes to the person. With no verdict (no sign-in, a timeout, an error, a reply outside the
 *   schema), the local check decides: content passes with a note to the agent, and an action passes.
 *   The event is logged.
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
  const outbound = input.direction === "outbound";
  if (outbound && triage.incomplete)
    return { action: "ask", category: triage.category, reason: localReason, by: "local" };
  if (judge.kind === "verdict") {
    const { verdict } = judge;
    if (verdict.verdict !== "allow")
      return {
        action: "ask",
        category: verdict.category === "none" ? triage.category : verdict.category,
        reason: verdict.reason,
        by: "model",
      };
    if (judge.covered) return { action: "allow", category: "none", reason: null, by: "model" };
    if (outbound) return { action: "ask", category: triage.category, reason: localReason, by: "model" };
  }
  return {
    action: input.direction === "inbound" ? "annotate" : "allow",
    category: triage.category,
    reason: localReason,
    by: judge.kind === "not-needed" ? "local" : "fallback",
  };
}
