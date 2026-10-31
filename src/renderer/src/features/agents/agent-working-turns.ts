import { createMemo } from "solid-js";
import { useTurns } from "../../turns";
import { useAgentTasks } from "../agent-tasks/agent-tasks-context";
import { useAgents } from "./agents-context";

/**
 * The running turn of each agent, as the sidebar and the Team panel read it. The turn events of a
 * side thread reach only its thread list, so an agent that works in a side thread is found there.
 */
export function createAgentWorkingTurns() {
  const { activeTurns } = useTurns();
  const { agentList } = useAgents();
  const agentTasks = useAgentTasks();
  return createMemo(() => {
    const turns = { ...activeTurns() };
    for (const agent of agentList()) {
      const running = agentTasks.snapshot(agent.id)?.tasks.find((task) => task.state === "running");
      if (running && !turns[agent.id]) turns[agent.id] = running.activeTurnId ?? running.id;
    }
    return turns;
  });
}
