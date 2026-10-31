/**
 * When the steps of a turn are open. The "Show agent steps" setting opens them while the turn runs,
 * so the person sees the work as it happens. When the turn ends, the setting closes them again, so
 * the answer shows under one short row. A choice of the person wins over the setting, before and
 * after the end of the turn.
 */

/** A turn that runs, or one that ended: completed, failed or stopped. */
export type TurnPhase = "running" | "finished";

/** What keeps the steps open: the setting, or a click of the person. */
export type StepsOpenedBy = "setting" | "person";

/**
 * Whether the setting opens the steps of a turn when they first show. A finished turn, such as one
 * that a chat loads from its history, starts closed.
 */
export function stepsOpenAtStart(phase: TurnPhase, showSteps: boolean): boolean {
  return phase === "running" && showSteps;
}

/** What keeps the steps open now, or null when they are closed. */
export function stepsOpenedBy(choice: boolean | undefined, openBySetting: boolean): StepsOpenedBy | null {
  if (choice !== undefined) return choice ? "person" : null;
  return openBySetting ? "setting" : null;
}

/**
 * True when the steps close by themselves: the turn ended, and the setting, not the person, kept
 * them open. A list that the person opened stays open, also when they opened it while the turn ran.
 */
export function shouldAutoCollapse(previous: TurnPhase, next: TurnPhase, openedBy: StepsOpenedBy | null): boolean {
  return previous === "running" && next === "finished" && openedBy === "setting";
}

/** The most turns whose choice a chat keeps. */
export const STEP_CHOICE_LIMIT = 200;

/**
 * The choices with `open` for each turn in `turnIds`. A turn that is chosen again moves to the end,
 * and the oldest choices go first when there are more than `STEP_CHOICE_LIMIT`.
 */
export function rememberStepChoice(
  choices: ReadonlyMap<string, boolean>,
  turnIds: readonly string[],
  open: boolean,
): ReadonlyMap<string, boolean> {
  if (turnIds.length === 0) return choices;
  const next = new Map(choices);
  for (const turnId of turnIds) {
    next.delete(turnId);
    next.set(turnId, open);
  }
  for (const turnId of next.keys()) {
    if (next.size <= STEP_CHOICE_LIMIT) break;
    next.delete(turnId);
  }
  return next;
}
