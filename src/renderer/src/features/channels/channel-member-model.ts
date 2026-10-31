import { isKnownAgentProvider } from "@openbot/contracts/agent-providers";
import type { ClientAgentModelOption } from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import type { ChannelMemberModel } from "@openbot/ui/features/channels/ChannelMemberRow";

/**
 * The model of a member, from the agent and the models that the host lists. A provider that this
 * build does not know gets the neutral mark. A model that the host does not list keeps the stored
 * effort, because nothing says that it cannot use it.
 */
export function channelMemberModel(
  agent: Pick<AgentProfile, "provider" | "model" | "reasoningEffort">,
  options: readonly ClientAgentModelOption[],
): ChannelMemberModel {
  const option = options.find((candidate) => candidate.provider === agent.provider && candidate.id === agent.model);
  const reasoning =
    !option ||
    (option.reasoningEffortConfigurable !== false && option.supportedReasoningEfforts.includes(agent.reasoningEffort))
      ? agent.reasoningEffort
      : null;
  return {
    provider: isKnownAgentProvider(agent.provider) ? agent.provider : "unknown",
    model: option?.name.trim() || agent.model,
    reasoning,
  };
}
