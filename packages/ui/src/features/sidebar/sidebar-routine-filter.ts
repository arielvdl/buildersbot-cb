/**
 * The routine filter of the list in the Routines view (the button beside the search field). It keeps
 * the agents that have at least one routine that is active, that is paused, that was created in the
 * last 7 days, or that was edited in the last 7 days. The choices exclude each other, as in the menu.
 * The open agent stays listed, so its row does not vanish while the user edits its routines.
 *
 * There is no "finished recently" choice: a routine summary has no time of its last run, and the
 * client has no cheap source for it.
 */

import type { SidebarRoutineFilter, SidebarRoutineSummary, SidebarView } from "./sidebar-types";

/** The routine filters, in menu order. */
export const SIDEBAR_ROUTINE_FILTERS = [
  "active",
  "inactive",
  "created",
  "edited",
] as const satisfies readonly SidebarRoutineFilter[];

/** How long a routine counts as created or edited recently. */
export const SIDEBAR_ROUTINE_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The menu of the filter button: the activity filters of the chats, or the routine filters. */
export type SidebarActivityMenu = "chats" | "routines";

/**
 * The menu that the filter button opens. The Routines view shows the routine filters when the caller
 * can set one; every other case shows the activity filters, as before.
 */
export function sidebarActivityMenu(
  view: SidebarView | undefined,
  routineFilterAvailable: boolean,
): SidebarActivityMenu {
  return view === "routines" && routineFilterAvailable ? "routines" : "chats";
}

/**
 * True for a time in the last 7 days. A time a little in the future (a clock skew) counts too. A time
 * that does not parse does not count.
 */
export function sidebarRoutineIsRecent(at: string | null | undefined, now: number): boolean {
  if (!at) return false;
  const time = Date.parse(at);
  return (
    !Number.isNaN(time) &&
    now - time <= SIDEBAR_ROUTINE_RECENT_WINDOW_MS &&
    time - now <= SIDEBAR_ROUTINE_RECENT_WINDOW_MS
  );
}

/**
 * Whether the filter keeps one routine. "Edited recently" needs a change after the creation, so a
 * new routine that nobody changed counts only as "Created recently".
 */
export function sidebarRoutineMatchesFilter(
  filter: SidebarRoutineFilter,
  routine: SidebarRoutineSummary,
  now: number,
): boolean {
  switch (filter) {
    case "active":
      return routine.active;
    case "inactive":
      return !routine.active;
    case "created":
      return sidebarRoutineIsRecent(routine.createdAt, now);
    case "edited":
      return (
        sidebarRoutineIsRecent(routine.updatedAt, now) && Date.parse(routine.updatedAt) > Date.parse(routine.createdAt)
      );
  }
}

/**
 * Whether the filter keeps an agent: no filter keeps every agent, and the open agent always stays.
 * Another agent stays when at least one of its routines matches. An agent whose routines are not
 * known (`undefined`) has none to match.
 */
export function sidebarAgentPassesRoutineFilter(
  filter: SidebarRoutineFilter | null,
  routines: readonly SidebarRoutineSummary[] | undefined,
  open: boolean,
  now: number,
): boolean {
  if (!filter || open) return true;
  // Array methods, not `for...of`: the caller can pass store arrays, which are proxies.
  return (routines ?? []).some((routine) => sidebarRoutineMatchesFilter(filter, routine, now));
}

export interface SidebarRoutineHiddenInput {
  filter: SidebarRoutineFilter | null;
  /** The agents the list would show with no filter: in the selected section, and not hidden by the user. */
  agents: readonly { id: string }[];
  /** The channels the list would show with no filter. A routine filter lists no channel. */
  channelCount: number;
  agentRoutines: Readonly<Record<string, readonly SidebarRoutineSummary[] | undefined>>;
  activeAgentId: string;
  now: number;
}

/** How many chats the routine filter hides. The notice under the list says it. */
export function sidebarRoutineHiddenCount(input: SidebarRoutineHiddenInput): number {
  if (!input.filter) return 0;
  const agents = input.agents.filter(
    (agent) =>
      !sidebarAgentPassesRoutineFilter(
        input.filter,
        input.agentRoutines[agent.id],
        input.activeAgentId === agent.id,
        input.now,
      ),
  ).length;
  return agents + input.channelCount;
}
