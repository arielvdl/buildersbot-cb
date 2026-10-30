/**
 * The section rail as data: which sections it lists, what each one shows, and which chats the list
 * keeps while a section is selected. Nothing here renders, so each answer has a test.
 *
 * The rail lists the custom sections in the layout order, then the unassigned section while it holds
 * a chat. "All" is not an item: it is the null selection, and the list then shows every section.
 */

import {
  SIDEBAR_UNASSIGNED_SECTION_ID,
  type SidebarLayoutSnapshot,
  type SidebarSection,
  type SidebarSectionIcon,
} from "@openbot/contracts/ipc";
import type { SidebarAgentState, SidebarChannelWait } from "./sidebar-types";

/** What a section holds that asks for the user: chats that wait, chats with work in flight, unread messages. */
export interface SidebarSectionRailBadge {
  waiting: number;
  working: number;
  unread: number;
}

export interface SidebarSectionRailItem {
  /** A custom section id, or `SIDEBAR_UNASSIGNED_SECTION_ID`. */
  id: string;
  /** The custom section, or null for the unassigned section. */
  section: SidebarSection | null;
  /** The chats filed in the section, pinned and waiting chats included. */
  chatCount: number;
  badge: SidebarSectionRailBadge;
}

/** The chat fields that the rail reads. A channel row reads the same fields. */
export interface SidebarSectionRailChannel {
  id: string;
  unreadCount: number;
  activeTasks: number;
}

export interface SidebarSectionRailInput {
  layout: SidebarLayoutSnapshot;
  agents: readonly { id: string }[];
  channels: readonly SidebarSectionRailChannel[];
  agentStates: Readonly<Record<string, SidebarAgentState | undefined>>;
  /** The channels that wait for the user. A missing entry does not wait. */
  channelWaits?: Readonly<Record<string, SidebarChannelWait | undefined>> | undefined;
  /** The agents that the user hid. They wait for nothing, so they add nothing to a badge. */
  hiddenAgentIds?: ReadonlySet<string> | undefined;
}

/**
 * The section that a chat is in, as the list groups it: its custom section while that section is in
 * the layout, otherwise the unassigned section.
 */
export function sidebarChatSectionId(layout: SidebarLayoutSnapshot, chatId: string): string {
  const assigned = layout.agentAssignments[chatId];
  return assigned && layout.sections.some((section) => section.id === assigned) && layout.order.includes(assigned)
    ? assigned
    : SIDEBAR_UNASSIGNED_SECTION_ID;
}

function emptyBadge(): SidebarSectionRailBadge {
  return { waiting: 0, working: 0, unread: 0 };
}

export function sidebarSectionRailItems(input: SidebarSectionRailInput): SidebarSectionRailItem[] {
  const counts = new Map<string, { chats: number; badge: SidebarSectionRailBadge }>();
  const entry = (chatId: string) => {
    const sectionId = sidebarChatSectionId(input.layout, chatId);
    const current = counts.get(sectionId) ?? { chats: 0, badge: emptyBadge() };
    counts.set(sectionId, current);
    current.chats += 1;
    return current.badge;
  };
  // Array methods, not `for...of`: the sidebar passes store arrays, which are proxies.
  input.agents.forEach((agent) => {
    const badge = entry(agent.id);
    if (input.hiddenAgentIds?.has(agent.id)) return;
    const state = input.agentStates[agent.id];
    if (state?.kind === "waiting") badge.waiting += 1;
    else if (state?.kind === "working" || (state?.kind === "routine" && state.phase !== "failed")) badge.working += 1;
    else if (state?.kind === "unread") badge.unread += state.count;
  });
  input.channels.forEach((channel) => {
    const badge = entry(channel.id);
    if (input.channelWaits?.[channel.id] !== undefined) badge.waiting += 1;
    if (channel.activeTasks > 0) badge.working += 1;
    badge.unread += Math.max(0, channel.unreadCount);
  });
  const sectionById = new Map(input.layout.sections.map((section) => [section.id, section]));
  const items: SidebarSectionRailItem[] = input.layout.order.flatMap((sectionId) => {
    const section = sectionById.get(sectionId);
    if (!section) return [];
    const count = counts.get(sectionId);
    return [{ id: sectionId, section, chatCount: count?.chats ?? 0, badge: count?.badge ?? emptyBadge() }];
  });
  const unassigned = counts.get(SIDEBAR_UNASSIGNED_SECTION_ID);
  if (unassigned && unassigned.chats > 0) {
    items.push({
      id: SIDEBAR_UNASSIGNED_SECTION_ID,
      section: null,
      chatCount: unassigned.chats,
      badge: unassigned.badge,
    });
  }
  return items;
}

/**
 * The selection that the list applies: the remembered section while the rail lists it, otherwise
 * null, which is "All". The caller keeps the remembered value: a layout that is still loading lists no
 * section, and the selection must come back when the layout arrives.
 */
export function resolveSidebarSectionRailSelection(
  selectedId: string | null | undefined,
  items: readonly Pick<SidebarSectionRailItem, "id">[],
): string | null {
  if (!selectedId) return null;
  return items.some((item) => item.id === selectedId) ? selectedId : null;
}

/** The sections the list draws: every section in the layout order, or only the selected one. */
export function sidebarSectionRailOrder(layout: SidebarLayoutSnapshot, focus: string | null): string[] {
  return focus === null ? layout.order : layout.order.filter((sectionId) => sectionId === focus);
}

/** The badge that the rail item shows, most urgent first: a wait, then unread messages, then work. */
export function sidebarSectionRailBadgeKind(badge: SidebarSectionRailBadge): "waiting" | "unread" | "working" | null {
  if (badge.waiting > 0) return "waiting";
  if (badge.unread > 0) return "unread";
  return badge.working > 0 ? "working" : null;
}

/**
 * The default mark of a section: the first letter or digit of its name in upper case, or the first
 * character when the name has neither, such as an emoji.
 */
export function sidebarSectionLetter(name: string): string {
  const characters = Array.from(name.trim());
  const first = characters.find((character) => /[\p{L}\p{N}]/u.test(character)) ?? characters[0];
  return first ? first.toLocaleUpperCase() : "?";
}

/** The mark that the rail shows for a section: its icon, or the default letter. */
export function sidebarSectionMark(section: Pick<SidebarSection, "name" | "icon">): SidebarSectionIcon {
  return section.icon ?? { kind: "letter", text: sidebarSectionLetter(section.name) };
}
