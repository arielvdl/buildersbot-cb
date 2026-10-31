/**
 * The work steps of running turns that started and did not end: a command, a tool call, a file
 * change, a compaction. A long command with no output, such as a build or a test run, sends no event
 * while it runs, so the clock of the last provider event alone takes it for a stall. The task
 * reviewer (`src/main/task-watch.ts`) reads `has` to give such a run more time.
 */

/** Item types that are text, not work: they send deltas while they run, and a stuck one is a stall. */
const TEXT_ITEM_TYPES = new Set(["userMessage", "agentMessage", "reasoning"]);

export class OpenWorkSteps {
  /** By item id: the agent and the turn of each open step. */
  readonly #steps = new Map<string, { agentId: string; turnId: string }>();

  /** Records the start or the end of one item of a turn. A text item is never a work step. */
  observe(phase: "started" | "completed", agentId: string, turnId: string, item: { id: string; type: unknown }): void {
    if (phase === "completed") {
      this.#steps.delete(item.id);
      return;
    }
    if (typeof item.type !== "string" || TEXT_ITEM_TYPES.has(item.type)) return;
    this.#steps.set(item.id, { agentId, turnId });
  }

  /** The turn ended: its steps end with it, also the ones that the provider did not close. */
  endTurn(turnId: string): void {
    for (const [itemId, step] of this.#steps) if (step.turnId === turnId) this.#steps.delete(itemId);
  }

  forgetAgent(agentId: string): void {
    for (const [itemId, step] of this.#steps) if (step.agentId === agentId) this.#steps.delete(itemId);
  }

  clear(): void {
    this.#steps.clear();
  }

  /** Whether the agent has an open step in a turn that `running` says still runs. */
  has(agentId: string, running: (turnId: string) => boolean): boolean {
    for (const step of this.#steps.values()) if (step.agentId === agentId && running(step.turnId)) return true;
    return false;
  }
}
