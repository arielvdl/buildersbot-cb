// What the stopped work page of Settings shows: the rows that match the search and the filters, the
// counts of its header, the choices of its filters and the agents that Reassign offers.

import type { StoppedWorkAgent, StoppedWorkEntry, StoppedWorkItem, StoppedWorkList } from "@openbot/contracts/ipc";

export interface StoppedWorkFilter {
  search: string;
  state: "all" | "paused" | "failed";
  /** An agent id, `none` for the rows that no agent had, or `all`. */
  agent: string;
  /** A channel id, a tab key (`placeKey`), or `all`. */
  place: string;
  origin: "all" | "routine" | "request";
  orphan: "all" | "orphan" | "kept";
}

export const EMPTY_STOPPED_WORK_FILTER: StoppedWorkFilter = {
  search: "",
  state: "all",
  agent: "all",
  place: "all",
  origin: "all",
  orphan: "all",
};

/** The key of one row, for the selection. */
export function stoppedWorkKey(item: StoppedWorkItem): string {
  return `${item.channelId}\u0000${item.taskId}`;
}

/** The key of a tab of a channel in the place filter. A channel id alone is the whole channel. */
export function placeKey(channelId: string, topicId: string | null): string {
  return `${channelId}\u0000${topicId ?? ""}`;
}

/** Lower case, with no accents, so "rotina" finds "Rotína" and "acao" finds "ação". */
function folded(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function filterStoppedWork(items: readonly StoppedWorkEntry[], filter: StoppedWorkFilter): StoppedWorkEntry[] {
  const words = folded(filter.search).split(/\s+/u).filter(Boolean);
  return items.filter((item) => {
    if (filter.state !== "all" && item.state !== filter.state) return false;
    if (filter.agent === "none" ? item.agentId !== null : filter.agent !== "all" && item.agentId !== filter.agent)
      return false;
    if (
      filter.place !== "all" &&
      filter.place !== item.channelId &&
      filter.place !== placeKey(item.channelId, item.topicId)
    )
      return false;
    if (filter.origin !== "all" && item.origin !== filter.origin) return false;
    if (filter.orphan === "orphan" && item.orphan === null) return false;
    if (filter.orphan === "kept" && item.orphan !== null) return false;
    if (!words.length) return true;
    const text = folded(
      [item.title, item.channelName, item.topicName, item.agentName, item.routineName, item.reason]
        .filter((part): part is string => Boolean(part))
        .join(" "),
    );
    return words.every((word) => text.includes(word));
  });
}

export function filterActive(filter: StoppedWorkFilter): boolean {
  return (
    filter.search.trim() !== "" ||
    filter.state !== "all" ||
    filter.agent !== "all" ||
    filter.place !== "all" ||
    filter.origin !== "all" ||
    filter.orphan !== "all"
  );
}

export interface StoppedWorkCounts {
  stopped: number;
  failed: number;
  paused: number;
  orphans: number;
}

/** The numbers of the header. `stopped` is every stopped run, also past the rows that the page lists. */
export function stoppedWorkCounts(list: StoppedWorkList): StoppedWorkCounts {
  let failed = 0;
  let orphans = 0;
  for (const item of list.items) {
    if (item.state === "failed") failed += 1;
    if (item.orphan !== null) orphans += 1;
  }
  return { stopped: list.total, failed, paused: list.items.length - failed, orphans };
}

export interface StoppedWorkChoices {
  /** The agents that had a row, by name, and whether a row had no agent. */
  agents: { id: string; name: string }[];
  noAgent: boolean;
  /** Each channel, then its tabs, in the order of the rows. */
  places: { key: string; channelName: string; topicName: string | null }[];
}

/** The choices of the filters: only values that a row has. */
export function stoppedWorkChoices(items: readonly StoppedWorkEntry[]): StoppedWorkChoices {
  const agents = new Map<string, string>();
  let noAgent = false;
  const places = new Map<string, { key: string; channelName: string; topicName: string | null }>();
  const tabs = new Map<string, { key: string; channelName: string; topicName: string | null }[]>();
  for (const item of items) {
    if (item.agentId === null) noAgent = true;
    else agents.set(item.agentId, item.agentName ?? item.agentId);
    if (!places.has(item.channelId)) {
      places.set(item.channelId, { key: item.channelId, channelName: item.channelName, topicName: null });
      tabs.set(item.channelId, []);
    }
    const key = placeKey(item.channelId, item.topicId);
    const channelTabs = tabs.get(item.channelId);
    if (item.topicName && channelTabs && !channelTabs.some((tab) => tab.key === key)) {
      channelTabs.push({ key, channelName: item.channelName, topicName: item.topicName });
    }
  }
  return {
    agents: [...agents].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name)),
    noAgent,
    places: [...places.values()].flatMap((channel) => [channel, ...(tabs.get(channel.key) ?? [])]),
  };
}

/** The agents that Reassign offers for the selected rows: each member of at least one of their channels. */
export function reassignChoices(list: StoppedWorkList, selected: readonly StoppedWorkEntry[]): StoppedWorkAgent[] {
  const channels = new Set(selected.map((item) => item.channelId));
  const members = new Set(
    list.channels.filter((channel) => channels.has(channel.id)).flatMap((channel) => channel.memberIds),
  );
  return list.agents.filter((agent) => members.has(agent.id));
}

/** The agents whose model a change for the selected rows changes, by name, and the rows with no agent. */
export function modelOwners(
  list: StoppedWorkList,
  selected: readonly StoppedWorkEntry[],
): { agents: StoppedWorkAgent[]; withoutAgent: number } {
  const ids = new Set<string>();
  let withoutAgent = 0;
  for (const item of selected) {
    if (item.agentId === null || !list.agents.some((agent) => agent.id === item.agentId)) withoutAgent += 1;
    else ids.add(item.agentId);
  }
  return { agents: list.agents.filter((agent) => ids.has(agent.id)), withoutAgent };
}

/**
 * The keys from the last row that the person marked to `key`, both included, in the order of the rows
 * shown: Shift with a click or with Space marks a range.
 */
export function keyRange(order: readonly string[], anchor: string | null, key: string): string[] {
  const end = order.indexOf(key);
  const start = anchor === null ? -1 : order.indexOf(anchor);
  if (end === -1) return [];
  if (start === -1) return [key];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}
