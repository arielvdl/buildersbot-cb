/**
 * The activity filter of the list (the button beside the search field). It keeps one kind of chat:
 * the channels with work in flight, the agents with work in flight, or the agents and channels that
 * finished their work in the last 24 hours. The choices exclude each other, as in the menu. The open
 * chat stays listed under a filter that lists its kind, so its row does not vanish under the pointer.
 */

import type { ChannelSummary } from "@openbot/contracts/ipc";
import type { SidebarActivityFilter, SidebarAgentState, SidebarChannelWait } from "./sidebar-types";

/** How long a chat counts as finished recently after its newest message. */
export const SIDEBAR_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** An agent with work in flight: it thinks, waits, waits on its plan limit, or runs a routine. */
export function sidebarAgentIsActive(state: SidebarAgentState | undefined): boolean {
  if (!state) return false;
  return (
    state.kind === "working" ||
    state.kind === "waiting" ||
    state.kind === "limited" ||
    (state.kind === "routine" && state.phase !== "failed")
  );
}

type ActivityChannel = Pick<ChannelSummary, "activeTasks" | "openTasks" | "lastMessage">;

/** A channel with a running or open task, or a wait for the user. */
export function sidebarChannelIsActive(channel: ActivityChannel, wait: SidebarChannelWait | undefined): boolean {
  return channel.activeTasks > 0 || (channel.openTasks ?? 0) > 0 || wait !== undefined;
}

/** True for a time in the last 24 hours. A time a little in the future (a clock skew) counts too. */
export function sidebarIsRecent(at: string | null | undefined, now: number): boolean {
  if (!at) return false;
  const time = Date.parse(at);
  return !Number.isNaN(time) && now - time <= SIDEBAR_RECENT_WINDOW_MS && time - now <= SIDEBAR_RECENT_WINDOW_MS;
}

/**
 * An agent that finished recently: no work in flight now, and the newest message of its own chat
 * (`updatedAt`) is less than 24 hours old. An agent with no message has no time and does not count.
 */
export function sidebarAgentFinishedRecently(
  agent: { updatedAt?: string | null | undefined },
  state: SidebarAgentState | undefined,
  now: number,
): boolean {
  return !sidebarAgentIsActive(state) && sidebarIsRecent(agent.updatedAt, now);
}

/**
 * A channel that finished recently: no task in flight and no wait now, and its newest message is a
 * complete message of an agent, less than 24 hours old. A host without channel-attention-v1 sends no
 * author and no status, so its newest message counts whoever wrote it.
 */
export function sidebarChannelFinishedRecently(
  channel: ActivityChannel,
  wait: SidebarChannelWait | undefined,
  now: number,
): boolean {
  const last = channel.lastMessage;
  if (!last || sidebarChannelIsActive(channel, wait)) return false;
  if (last.author?.kind === "member") return false;
  if (last.status !== undefined && last.status !== "completed") return false;
  return sidebarIsRecent(last.at, now);
}

/**
 * Whether the filter keeps an agent. No filter keeps every chat. Under "Active channels", no agent
 * shows. The open agent stays under the two filters that list agents.
 */
export function sidebarAgentPassesActivityFilter(
  filter: SidebarActivityFilter | null,
  agent: { updatedAt?: string | null | undefined },
  state: SidebarAgentState | undefined,
  open: boolean,
  now: number,
): boolean {
  if (!filter) return true;
  if (filter === "agents") return open || sidebarAgentIsActive(state);
  return filter === "finished" && (open || sidebarAgentFinishedRecently(agent, state, now));
}

/**
 * Whether the filter keeps a channel. No filter keeps every chat. Under "Active agents", no channel
 * shows. The open channel stays under the two filters that list channels.
 */
export function sidebarChannelPassesActivityFilter(
  filter: SidebarActivityFilter | null,
  channel: ActivityChannel,
  wait: SidebarChannelWait | undefined,
  open: boolean,
  now: number,
): boolean {
  if (!filter) return true;
  if (filter === "channels") return open || sidebarChannelIsActive(channel, wait);
  return filter === "finished" && (open || sidebarChannelFinishedRecently(channel, wait, now));
}

export interface SidebarActivityHiddenInput {
  filter: SidebarActivityFilter | null;
  /** The agents the list would show with no filter: in the selected section, and not hidden by the user. */
  agents: readonly { id: string; updatedAt?: string | null | undefined }[];
  /** The channels the list would show with no filter, in the selected section. */
  channels: readonly (ActivityChannel & { id: string })[];
  agentStates: Readonly<Record<string, SidebarAgentState | undefined>>;
  channelWaits?: Readonly<Record<string, SidebarChannelWait | undefined>> | undefined;
  activeAgentId: string;
  activeChannelId?: string | null | undefined;
  now: number;
}

/** How many chats the filter hides. The notice under the list says it, and "Show all" brings them back. */
export function sidebarActivityHiddenCount(input: SidebarActivityHiddenInput): number {
  if (!input.filter) return 0;
  const agents = input.agents.filter(
    (agent) =>
      !sidebarAgentPassesActivityFilter(
        input.filter,
        agent,
        input.agentStates[agent.id],
        input.activeAgentId === agent.id,
        input.now,
      ),
  ).length;
  const channels = input.channels.filter(
    (channel) =>
      !sidebarChannelPassesActivityFilter(
        input.filter,
        channel,
        input.channelWaits?.[channel.id],
        input.activeChannelId === channel.id,
        input.now,
      ),
  ).length;
  return agents + channels;
}
