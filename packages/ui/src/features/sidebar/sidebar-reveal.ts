/**
 * What the list changes so that it shows the open chat. A chat can open from outside the list: global
 * search, a message result, a notification, a link, the Back and Forward buttons, a schedule or a
 * restore at start. The list then keeps the section, the collapsed sections and the filter that the
 * reader left, and the open chat can be in none of them. Nothing here renders, so each answer has a test.
 */

import {
  SIDEBAR_PEOPLE_SECTION_ID,
  SIDEBAR_UNASSIGNED_SECTION_ID,
  type SidebarLayoutSnapshot,
} from "@openbot/contracts/ipc";
import { sidebarChatSectionId } from "./sidebar-section-rail";
import { SIDEBAR_HIDDEN_GROUP_OPEN_ID, type SidebarActivityFilter, type SidebarRoutineFilter } from "./sidebar-types";

/** The chat that the conversation shows. */
export interface SidebarOpenChat {
  kind: "agent" | "channel" | "person";
  id: string;
}

export interface SidebarRevealInput {
  chat: SidebarOpenChat;
  layout: SidebarLayoutSnapshot;
  /** The section that the rail selects, as the list applies it. Null is "All", or no rail. */
  railFocus: string | null;
  /** The sections that the rail lists. */
  railSectionIds: readonly string[];
  /** The ids that `collapsedSectionIds` holds. */
  collapsedSectionIds: ReadonlySet<string>;
  /** The chat shows as a pinned tile, which no collapsed section hides. */
  pinned: boolean;
  /** The chat shows in the "Needs you" group, which no collapsed section hides. */
  waiting: boolean;
  /** The agent is in the Hidden group. */
  userHidden: boolean;
  activityFilter: SidebarActivityFilter | null;
  routineFilter: SidebarRoutineFilter | null;
}

export interface SidebarRevealSteps {
  /** The section for the rail to select. Undefined keeps the selection. Null selects "All". */
  railSectionId?: string | null;
  /** The ids to toggle in `collapsedSectionIds`, so that the chat's group opens. */
  toggleSectionIds: string[];
  clearActivityFilter: boolean;
  clearRoutineFilter: boolean;
}

/** The changes that make the list show the open chat. No change for a chat that the list shows. */
export function sidebarRevealSteps(input: SidebarRevealInput): SidebarRevealSteps {
  const { chat } = input;
  const steps: SidebarRevealSteps = {
    toggleSectionIds: [],
    clearActivityFilter: false,
    clearRoutineFilter: false,
  };
  // A person is in the people section, which the rail does not list: only "All" shows it.
  const sectionId = chat.kind === "person" ? SIDEBAR_PEOPLE_SECTION_ID : sidebarChatSectionId(input.layout, chat.id);
  let focus = input.railFocus;
  if (focus !== null && focus !== sectionId) {
    focus = input.railSectionIds.includes(sectionId) ? sectionId : null;
    steps.railSectionId = focus;
  }
  if (chat.kind === "agent" && input.userHidden) {
    // The Hidden group is closed until the reader opens it, so its id records an open group.
    if (!input.collapsedSectionIds.has(SIDEBAR_HIDDEN_GROUP_OPEN_ID))
      steps.toggleSectionIds.push(SIDEBAR_HIDDEN_GROUP_OPEN_ID);
  } else if (
    !input.pinned &&
    !input.waiting &&
    focus !== sectionId &&
    input.collapsedSectionIds.has(sectionId) &&
    (sectionId !== SIDEBAR_UNASSIGNED_SECTION_ID || input.layout.sections.length > 0)
  ) {
    steps.toggleSectionIds.push(sectionId);
  }
  // The filters keep the open chat of their own kind. A filter lists no people, "Active agents" lists
  // no channel, "Active channels" lists no agent, and a routine filter lists agents only.
  const activity = input.activityFilter;
  steps.clearActivityFilter =
    activity !== null &&
    (chat.kind === "person" ||
      (chat.kind === "agent" && activity === "channels") ||
      (chat.kind === "channel" && activity === "agents"));
  steps.clearRoutineFilter = input.routineFilter !== null && chat.kind !== "agent";
  return steps;
}

/** The key of an open chat, or null when no chat is open. */
export function sidebarOpenChatKey(chat: SidebarOpenChat | null): string | null {
  return chat ? `${chat.kind}:${chat.id}` : null;
}
