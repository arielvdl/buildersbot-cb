import type { QueueDelivery } from "@openbot/contracts/ipc";

export interface TurnSlotsOptions {
  /** The most turns that run at the same time, or null for no limit. */
  limit(): number | null;
  /**
   * The most agents that run turns at the same time, as the person set it, or null for no limit. An
   * agent that runs a turn already can start another lane: it is still one agent.
   */
  agentLimit(): number | null;
  /** The agent of a lane. */
  agentOf(lane: string): string;
  /**
   * The key of each queue that runs one turn at a time: an agent's own chat, and each of its tasks.
   * A lane key sorts as its agent id does, so a tie in age goes the same way as before tasks.
   */
  lanes(): readonly string[];
  /** Whether the lane runs a turn, starts one, or compacts its context. Each one uses a slot. */
  isRunning(lane: string): boolean;
  /** Whether the lane has a delivery that could start now, if a slot were free. */
  isWaiting(lane: string): boolean;
  /** The delivery at the head of the lane's queue. */
  head(lane: string): QueueDelivery | null;
}

/**
 * Owns the turn slot clause of the queue drain: on a hosted server only a fixed number of turns run
 * at the same time, and each task of an agent uses a slot of its own. The person can also cap the
 * agents that run at the same time; then an agent is one slot, whatever its lanes run. A lane starts
 * only when both caps have room, so the cap that is reached first holds it. When the slots are full, the
 * waiting lanes go by the head of their queue: a message from a person first, then routine runs and
 * teammate messages, and the oldest first in each group. A delivery that waits stays queued. It never imports the service.
 *
 * No slot waits on another slot: a teammate request ends the turn that sends it, and the answer
 * arrives as a new delivery.
 */
export class TurnSlots {
  readonly #options: TurnSlotsOptions;

  constructor(options: TurnSlotsOptions) {
    this.#options = options;
  }

  mayStart(lane: string): boolean {
    const turns = this.#options.limit();
    const agents = this.#options.agentLimit();
    if (turns !== null && !this.#fits(lane, turns, (key) => key)) return false;
    if (agents !== null && !this.#fits(lane, agents, this.#options.agentOf)) return false;
    return true;
  }

  /**
   * Whether `lane` has a slot under `limit`, where `unit` says what takes a slot: the lane itself for
   * turns, its agent for agents. The waiting lanes of other units that start before it take the free
   * slots first.
   */
  #fits(lane: string, limit: number, unit: (lane: string) => string): boolean {
    const lanes = this.#options.lanes();
    const running = new Set(lanes.filter((id) => this.#options.isRunning(id)).map(unit));
    const own = unit(lane);
    if (running.has(own)) return true;
    const free = limit - running.size;
    if (free <= 0) return false;
    const head = this.#options.head(lane);
    if (!head) return true;
    const ahead = new Set<string>();
    for (const other of lanes) {
      const otherUnit = unit(other);
      if (other === lane || otherUnit === own || running.has(otherUnit) || !this.#options.isWaiting(other)) continue;
      const otherHead = this.#options.head(other);
      if (otherHead && startsBefore(otherHead, other, head, lane)) ahead.add(otherUnit);
    }
    return ahead.size < free;
  }
}

function startsBefore(left: QueueDelivery, leftLane: string, right: QueueDelivery, rightLane: string): boolean {
  const leftPerson = left.sender.kind === "user";
  const rightPerson = right.sender.kind === "user";
  if (leftPerson !== rightPerson) return leftPerson;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt;
  return leftLane < rightLane;
}
