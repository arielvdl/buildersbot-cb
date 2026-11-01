// What the Guard does with one item, from the level, the local check and the reviewer. Pure: the
// same input always gives the same decision, so the policy is the part a test can hold.

import type { GuardAvailableLevel, GuardCategory } from "@openbot/contracts/ipc";
import type { GuardDirection, GuardJudgeVerdict } from "./guard-judge";
import {
  type GuardTriage,
  guardFindingNeedsReview,
  strongerCategory,
  triageDenies,
  triageNamesSecretLeak,
  triageReason,
} from "./guard-triage";

/**
 * What happens to the item:
 * - `allow`: it passes as it is.
 * - `annotate`: content passes with a note to the agent that it is data, not instructions.
 * - `ask`: the person approves or declines first, on the approval card.
 * - `block`: it stops. Only one finding blocks by itself: a cookie, a session or a sign-in token that
 *   an action would send to a third party (`triageDenies`). The owner's rule is that these never leave
 *   this computer, so no card can let one go.
 */
export type GuardAction = "allow" | "annotate" | "ask" | "block";

/** Who decided: the level, the local check, the reviewer, or the local check after the reviewer gave nothing. */
export type GuardDecider = "off" | "local" | "model" | "fallback";

/** What the reviewer gave for one item. */
export type GuardJudgeOutcome =
  | { readonly kind: "not-needed" }
  | { readonly kind: "unavailable" }
  /**
   * `busy`: every review slot stayed taken until the deadline. An agent can cause that on purpose,
   * with many calls at once, so an action that ends busy goes to the person.
   */
  | { readonly kind: "failed"; readonly failure: "timeout" | "error" | "invalid" | "busy" }
  /**
   * `covered` is false when the excerpt did not show every place that the local check marked. The
   * reviewer can then make the item ask, but it cannot clear it.
   */
  | { readonly kind: "verdict"; readonly verdict: GuardJudgeVerdict; readonly covered: boolean };

export interface GuardDecision {
  readonly action: GuardAction;
  readonly category: GuardCategory;
  /**
   * A short English sentence of the local check, for the person and the agent. Null when the item
   * passes with no finding. It never holds text of the reviewer: the agent reads it, and text that
   * the item chose must not reach the agent in the voice of the Guard.
   */
  readonly reason: string | null;
  readonly by: GuardDecider;
  /**
   * Only the owner may answer. It comes from the local findings: a secret that the local check sees
   * leaving stays the owner's question whatever category the reviewer gives. The reviewer can make a
   * question the owner's, never take it from the owner.
   */
  readonly ownerOnly: boolean;
  /** The reviewer's own reason, for the approval card only. Null when the reviewer did not ask. */
  readonly modelReason: string | null;
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

export const GUARD_ALLOW: GuardDecision = {
  action: "allow",
  category: "none",
  reason: null,
  by: "local",
  ownerOnly: false,
  modelReason: null,
};

/**
 * The Light level. Its concern is prompt injection, and it must not stop the work:
 * - An action that sends a cookie, a session or a sign-in token to a third party: it stops, and no
 *   model or card can let it go.
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
 *   An action whose review found every slot taken goes to the person. The event is logged.
 */
export function decideGuard(input: {
  level: GuardAvailableLevel;
  direction: GuardDirection;
  triage: GuardTriage;
  judge: GuardJudgeOutcome;
}): GuardDecision {
  const { triage, judge } = input;
  if (input.level === "off") return { ...GUARD_ALLOW, by: "off" };
  if (triage.level === "clean") return GUARD_ALLOW;
  const reason = triageReason(triage);
  const ownerOnly = triageNamesSecretLeak(triage);
  const local = { category: triage.category, reason, ownerOnly, modelReason: null } as const;
  if (input.direction === "outbound" && triageDenies(triage)) return { action: "block", ...local, by: "local" };
  if (triage.level === "high") return { action: "ask", ...local, by: "local" };
  const outbound = input.direction === "outbound";
  if (outbound && triage.incomplete) return { action: "ask", ...local, by: "local" };
  if (judge.kind === "verdict") {
    const { verdict } = judge;
    if (verdict.verdict !== "allow") {
      // The reviewer can raise the category, never lower it below what the local check found.
      const category =
        verdict.category === "none" ? triage.category : strongerCategory(verdict.category, triage.category);
      return {
        action: "ask",
        category,
        reason,
        by: "model",
        ownerOnly: ownerOnly || category === "secret-leak",
        modelReason: verdict.reason,
      };
    }
    if (judge.covered) return { ...GUARD_ALLOW, by: "model" };
    if (outbound) return { action: "ask", ...local, by: "model" };
  }
  if (outbound && judge.kind === "failed" && judge.failure === "busy")
    return { action: "ask", ...local, by: "fallback" };
  return {
    action: input.direction === "inbound" ? "annotate" : "allow",
    ...local,
    by: judge.kind === "not-needed" ? "local" : "fallback",
  };
}
