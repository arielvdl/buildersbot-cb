// What the agent picker shows: the agents that match the search, the provider and the model.

import { agentMentionRank } from "@openbot/contracts/agent-mention-rank";
import { type AgentProviderRef, providerDisplayName } from "@openbot/contracts/agent-providers";

/** One agent of the picker. Only the name is necessary; the other fields add a face and a model. */
export interface AgentPickerEntry {
  id: string;
  name: string;
  /** The role of the agent. A search finds it after the name. */
  title?: string | undefined;
  /** Absent for an agent whose provider the surface does not know, such as a channel member. */
  provider?: AgentProviderRef | undefined;
  /** The model of the agent, as the surface names it: a model name, or the model id. */
  model?: string | undefined;
}

export interface AgentPickerFilter {
  search: string;
  /** Null shows every provider. */
  provider: AgentProviderRef | null;
  /** Null shows every model of the provider. Only applies with a provider. */
  model: string | null;
}

/** One chip of a filter row: the value, the text and the number of agents it shows. */
export interface AgentPickerChoice<Value extends string> {
  value: Value;
  label: string;
  count: number;
}

export const EMPTY_AGENT_PICKER_FILTER: AgentPickerFilter = { search: "", provider: null, model: null };

/** Counts the values in their first order, so the chips stay in the order of the list. */
function countInOrder<Value extends string>(values: readonly Value[]): Map<Value, number> {
  const counts = new Map<Value, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/**
 * The providers of the agents, most agents first. Agents without a provider have no chip. With
 * fewer than two providers there is nothing to filter, so the list is empty.
 */
export function agentPickerProviders(agents: readonly AgentPickerEntry[]): AgentPickerChoice<AgentProviderRef>[] {
  const providers = agents.flatMap((agent) => (agent.provider ? [agent.provider] : []));
  const choices = [...countInOrder(providers)].map(([value, count]) => ({
    value,
    label: providerDisplayName(value),
    count,
  }));
  if (choices.length < 2) return [];
  return choices.sort((a, b) => b.count - a.count);
}

/** The models of one provider's agents, most agents first. Empty with fewer than two models. */
export function agentPickerModels(
  agents: readonly AgentPickerEntry[],
  provider: AgentProviderRef | null,
): AgentPickerChoice<string>[] {
  if (!provider) return [];
  const models = agents.flatMap((agent) => (agent.provider === provider && agent.model ? [agent.model] : []));
  const choices = [...countInOrder(models)].map(([value, count]) => ({ value, label: value, count }));
  if (choices.length < 2) return [];
  return choices.sort((a, b) => b.count - a.count);
}

/**
 * The agents that match the filter. A search does not see case or accents, so "jose" finds
 * "José"; it reads the name, then the title. The best matches come first: an exact name, then a
 * name that starts with the search, then a word of the name. Agents of one rank keep their order.
 */
export function filterAgentPicker<Agent extends AgentPickerEntry>(
  agents: readonly Agent[],
  filter: AgentPickerFilter,
): Agent[] {
  const ranked = agents.flatMap((agent, index) => {
    if (filter.provider && agent.provider !== filter.provider) return [];
    if (filter.provider && filter.model && agent.model !== filter.model) return [];
    const rank = agentMentionRank({ name: agent.name, title: agent.title ?? "", description: "" }, filter.search);
    return rank === null ? [] : [{ agent, rank, index }];
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.agent);
}
