import type { QueueSnapshot } from "@openbot/contracts/ipc";

/**
 * Whether an agent is running work right now.
 *
 * A channel turn belongs to another thread, so it reports no active turn and no running delivery
 * here. The queue's hold is the only signal that the agent doing that work is busy.
 *
 * Shared with the avatar's mood so a row's badge and its face can never disagree about who is
 * working - see `features/agents/agent-avatar-mood.ts`.
 *
 * It lives in its own file, with a type-only contract import, so that code outside the sidebar
 * (the avatar, and through it the landing page of the account Worker) does not load the sidebar
 * and server menu types, and the Worker type check does not read the desktop interface.
 */
export function isAgentWorking(
  agentId: string,
  activeTurns: Record<string, string | null>,
  queues: Record<string, QueueSnapshot>,
): boolean {
  const queue = queues[agentId];
  return (
    Boolean(activeTurns[agentId]) ||
    queue?.hold?.agentId === agentId ||
    Boolean(queue?.deliveries.some((delivery) => delivery.status === "starting" || delivery.status === "running"))
  );
}
