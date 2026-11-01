import type { AgentEvent, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import { playSound } from "../../sound-center";

/**
 * Plays one sound for an agent event that the user must know about: a question of the Guard, a
 * question or an approval that waits for the user, and a run that fails. A finished reply has its own
 * completion sound, so it plays nothing here. Desktop and the web client give the returned function
 * each event of the selected server. `notifies` gives the mute of each agent, so a muted agent stays
 * silent, as with the completion sound. `nameOf` names the agent for Recent sounds.
 */
export function createAgentEventSounds(
  notifies: (agentId: string) => boolean,
  nameOf: (agentId: string) => string | null = () => null,
): (event: AgentEvent | TeamRealtimeEvent) => void {
  // A host can send the same request again, for example after a reconnect. Each agent waits for one
  // answer at a time, so the last request per agent is enough to find a repeat.
  const askedRequests = new Map<string, string>();
  const ask = (agentId: string, request: string, guard: boolean) => {
    if (askedRequests.get(agentId) === request) return;
    askedRequests.set(agentId, request);
    if (notifies(agentId)) playSound(guard ? "guard.question" : "approval.waiting", { who: nameOf(agentId) });
  };
  return (event) => {
    switch (event.type) {
      case "approval":
        ask(
          event.approval.agentId,
          `approval:${event.approval.turnId}:${event.approval.requestId}`,
          event.approval.guard === true,
        );
        return;
      case "prompt":
        ask(event.agentId, `prompt:${event.turnId}:${event.requestId}`, false);
        return;
      case "browser-takeover-requested":
        ask(event.request.agentId, `browser:${event.request.turnId}:${event.request.requestId}`, false);
        return;
      case "turn-completed":
        // A routine or a teammate starts a run without the user, so its failure stays silent. A
        // provider retry reports an error more than once in a run, so the cue follows the run end.
        if (
          event.status === "failed" &&
          event.origin !== "routine" &&
          event.origin !== "agent" &&
          notifies(event.agentId)
        ) {
          playSound("agent.run-failed", { who: nameOf(event.agentId) });
        }
        return;
    }
  };
}
