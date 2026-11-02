/**
 * The DOM-free projection of the feed page: which cards show for the filters, in which rows, the
 * counters of the jump bar, the choices of the filters, and the Team list beside the timeline. The
 * cards arrive in timeline order, the newest last, and every function here keeps that order.
 */

import type { AvatarHue, FeedItem, FeedItemState } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";

export const FEED_GROUPS = ["time", "project", "agent"] as const;
export type FeedGroupBy = (typeof FEED_GROUPS)[number];
export type FeedStateFilter = FeedItemState | "all";

export interface FeedFilterState {
  query: string;
  /** A key of `feedProjectKey`, or null for every project. */
  project: string | null;
  /** A key of `feedAgentKey`, or null for every agent. */
  agent: string | null;
  state: FeedStateFilter;
  group: FeedGroupBy;
}

export const EMPTY_FEED_FILTERS: FeedFilterState = {
  query: "",
  project: null,
  agent: null,
  state: "all",
  group: "time",
};

/** The project key of the cards whose agent is in no section. */
export const FEED_NO_PROJECT_KEY = "none";

export const FEED_STATE_LABEL = {
  working: "app.feed.state.working",
  waiting: "app.feed.state.waiting",
  "needs-you": "app.feed.state.needsYou",
  stopped: "app.feed.state.stopped",
  done: "app.feed.state.done",
  failed: "app.feed.state.failed",
} as const satisfies Record<FeedItemState, AppTextKey>;

/** The order of the state filter, the most urgent first. */
export const FEED_STATE_ORDER: readonly FeedItemState[] = [
  "needs-you",
  "stopped",
  "failed",
  "working",
  "waiting",
  "done",
];

export function feedAgentKey(item: Pick<FeedItem, "serverId" | "agentId">): string {
  return `${item.serverId}\u0000${item.agentId}`;
}

export function feedProjectKey(item: Pick<FeedItem, "serverId" | "projectId">): string {
  return item.projectId ? `${item.serverId}\u0000${item.projectId}` : FEED_NO_PROJECT_KEY;
}

/** Lower case, with no accents: "codigo" finds "Código". */
export function foldFeedText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function feedItemMatches(item: FeedItem, filters: FeedFilterState, foldedQuery: string): boolean {
  if (filters.state !== "all" && item.state !== filters.state) return false;
  if (filters.agent !== null && feedAgentKey(item) !== filters.agent) return false;
  if (filters.project !== null && feedProjectKey(item) !== filters.project) return false;
  if (!foldedQuery) return true;
  const text = [item.agentName, item.projectName ?? "", item.title, item.lastStep?.text ?? "", item.need?.label ?? ""];
  return text.some((part) => foldFeedText(part).includes(foldedQuery));
}

export type FeedRow =
  | { kind: "group"; key: string; group: FeedGroupBy; label: string | null; count: number }
  | { kind: "item"; key: string; item: FeedItem };

/**
 * The rows of the timeline. With a group, each group is a header and its cards; the group with the
 * newest card is last, as the newest card is in the plain timeline.
 */
export function feedRows(items: readonly FeedItem[], filters: FeedFilterState): FeedRow[] {
  const query = foldFeedText(filters.query.trim());
  const shown = items.filter((item) => feedItemMatches(item, filters, query));
  if (filters.group === "time") return shown.map((item) => ({ kind: "item", key: item.id, item }));
  const groups = new Map<string, { label: string | null; items: FeedItem[]; newest: number }>();
  shown.forEach((item, index) => {
    const key = filters.group === "project" ? feedProjectKey(item) : feedAgentKey(item);
    const label = filters.group === "project" ? item.projectName : item.agentName || null;
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
      group.newest = index;
    } else groups.set(key, { label, items: [item], newest: index });
  });
  const rows: FeedRow[] = [];
  for (const [key, group] of [...groups].sort((left, right) => left[1].newest - right[1].newest)) {
    rows.push({
      kind: "group",
      key: `group:${key}`,
      group: filters.group,
      label: group.label,
      count: group.items.length,
    });
    for (const item of group.items) rows.push({ kind: "item", key: item.id, item });
  }
  return rows;
}

export interface FeedCounts {
  needsYou: number;
  stopped: number;
  working: number;
}

export function feedCounts(items: readonly FeedItem[]): FeedCounts {
  const counts: FeedCounts = { needsYou: 0, stopped: 0, working: 0 };
  for (const item of items) {
    if (item.state === "needs-you") counts.needsYou += 1;
    else if (item.state === "stopped") counts.stopped += 1;
    else if (item.state === "working") counts.working += 1;
  }
  return counts;
}

export interface FeedOption {
  key: string;
  /** Null: no project. */
  label: string | null;
  count: number;
}

function options(
  items: readonly FeedItem[],
  keyOf: (item: FeedItem) => string,
  labelOf: (item: FeedItem) => string | null,
) {
  const found = new Map<string, FeedOption>();
  for (const item of items) {
    const key = keyOf(item);
    const option = found.get(key);
    if (option) option.count += 1;
    else found.set(key, { key, label: labelOf(item), count: 1 });
  }
  return [...found.values()].sort((left, right) => (left.label ?? "").localeCompare(right.label ?? ""));
}

export function feedProjectOptions(items: readonly FeedItem[]): FeedOption[] {
  return options(items, feedProjectKey, (item) => item.projectName);
}

export function feedAgentOptions(items: readonly FeedItem[]): FeedOption[] {
  return options(items, feedAgentKey, (item) => item.agentName || null);
}

/** What an agent of the Team list does now. `idle`: nothing. */
export type FeedTeamState = FeedItemState | "idle";

export interface FeedTeamMember {
  /** A key of `feedAgentKey`. */
  key: string;
  name: string;
  state: FeedTeamState;
  /** What the agent does now, as a step summary. */
  detail: string | null;
  avatarSeed: string;
  avatarHue: AvatarHue | null;
  avatarUrl: string | null;
}

const TEAM_RANK: Record<FeedTeamState, number> = {
  "needs-you": 0,
  stopped: 1,
  failed: 2,
  working: 3,
  waiting: 4,
  done: 5,
  idle: 6,
};

/**
 * The Team list: the agents that the window knows, then every other agent that has a card, such as
 * an agent of another server. Each one with its count of cards; the agents that need the person first.
 */
export function feedTeam(
  roster: readonly FeedTeamMember[],
  items: readonly FeedItem[],
): Array<FeedTeamMember & { count: number }> {
  const counts = new Map<string, number>();
  const latest = new Map<string, FeedItem>();
  for (const item of items) {
    const key = feedAgentKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    latest.set(key, item);
  }
  const members = new Map<string, FeedTeamMember & { count: number }>();
  for (const member of roster)
    members.set(member.key, {
      ...member,
      detail: member.detail ?? latest.get(member.key)?.lastStep?.text ?? null,
      count: counts.get(member.key) ?? 0,
    });
  for (const [key, item] of latest) {
    if (members.has(key)) continue;
    members.set(key, {
      key,
      name: item.agentName,
      state: item.state,
      detail: item.lastStep?.text ?? null,
      avatarSeed: item.agentId,
      avatarHue: null,
      avatarUrl: null,
      count: counts.get(key) ?? 0,
    });
  }
  return [...members.values()].sort(
    (left, right) => TEAM_RANK[left.state] - TEAM_RANK[right.state] || left.name.localeCompare(right.name),
  );
}

/** The next card in `state` after the card `afterKey`, going around to the first. */
export function nextFeedRowIndex(rows: readonly FeedRow[], state: FeedItemState, afterKey: string | null): number {
  const start = afterKey === null ? -1 : rows.findIndex((row) => row.key === afterKey);
  for (let step = 1; step <= rows.length; step += 1) {
    const index = (start + step) % rows.length;
    const row = rows[index];
    if (row?.kind === "item" && row.item.state === state) return index;
  }
  return -1;
}
