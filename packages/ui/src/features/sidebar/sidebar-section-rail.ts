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

/**
 * True when two item lists draw the same rail. The items are built again on each change of an agent
 * state, which happens many times a second while an agent works. When nothing that the rail shows has
 * changed, the memo keeps the old list, so no rail item and no list filter runs again.
 */
export function sameSidebarSectionRailItems(
  left: readonly SidebarSectionRailItem[],
  right: readonly SidebarSectionRailItem[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        item.id === other.id &&
        item.section === other.section &&
        item.chatCount === other.chatCount &&
        item.badge.waiting === other.badge.waiting &&
        item.badge.working === other.badge.working &&
        item.badge.unread === other.badge.unread
      );
    })
  );
}

/**
 * The section that a page other than the list filters by: the same answer as the rail, from the ids of
 * the chats that the list shows. The schedule and the workflows pages use it.
 */
export function sidebarSectionRailFocus(
  layout: SidebarLayoutSnapshot,
  selectedId: string | null | undefined,
  chatIds: readonly string[],
): string | null {
  if (!selectedId) return null;
  if (selectedId === SIDEBAR_UNASSIGNED_SECTION_ID) {
    return chatIds.some((chatId) => sidebarChatSectionId(layout, chatId) === SIDEBAR_UNASSIGNED_SECTION_ID)
      ? selectedId
      : null;
  }
  return layout.sections.some((section) => section.id === selectedId) && layout.order.includes(selectedId)
    ? selectedId
    : null;
}

/**
 * Why a section name cannot be saved, or null when it can: a name is required, and two sections cannot
 * have the same name in any case. A rename may keep its own name.
 */
export function sidebarSectionNameProblem(
  name: string,
  sections: readonly Pick<SidebarSection, "id" | "name">[],
  renamedId?: string,
): "required" | "duplicate" | null {
  const trimmed = name.trim();
  if (!trimmed) return "required";
  const lower = trimmed.toLocaleLowerCase();
  return sections.some((section) => section.id !== renamedId && section.name.toLocaleLowerCase() === lower)
    ? "duplicate"
    : null;
}

/**
 * The section that a create added: the new section with the name that was typed, or the only new
 * section. The host may store the name in another form, as for a duplicate.
 */
export function sidebarCreatedSectionId(
  before: ReadonlySet<string>,
  sections: readonly Pick<SidebarSection, "id" | "name">[],
  name: string,
): string | null {
  const added = sections.filter((section) => !before.has(section.id));
  const lower = name.trim().toLocaleLowerCase();
  const created =
    added.find((section) => section.name.toLocaleLowerCase() === lower) ?? (added.length === 1 ? added[0] : undefined);
  return created?.id ?? null;
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

/**
 * The `move` action that puts a section at the place of another one, as the rail drop does: the
 * section takes the index of the target, and the sections between them shift by one. The steps count
 * in `layout.order`, as the section list counts them, so the rail and the list keep the same order.
 * Null for no change, or for an id that is not a custom section of the order.
 */
export function sidebarSectionRailMove(
  order: readonly string[],
  sectionIds: ReadonlySet<string>,
  sourceId: string,
  targetId: string,
): { type: "move"; sectionId: string; direction: "up" | "down"; steps: number } | null {
  if (sourceId === targetId || !sectionIds.has(sourceId) || !sectionIds.has(targetId)) return null;
  const source = order.indexOf(sourceId);
  const target = order.indexOf(targetId);
  if (source < 0 || target < 0) return null;
  return {
    type: "move",
    sectionId: sourceId,
    direction: target < source ? "up" : "down",
    steps: Math.abs(target - source),
  };
}

/** The custom section above or below one in the rail, for Alt+Arrow. Null at an end. */
export function sidebarSectionRailNeighbor(
  railIds: readonly string[],
  sectionId: string,
  direction: -1 | 1,
): string | null {
  const index = railIds.indexOf(sectionId);
  return index < 0 ? null : (railIds[index + direction] ?? null);
}

/**
 * How many places an item slides while another one is dragged over the rail: the items between the
 * source and the target make room, as in the server rail. Zero for every other item.
 */
export function sidebarSectionRailDragStep(
  railIds: readonly string[],
  sourceId: string | null,
  overId: string | null,
  itemId: string,
): -1 | 0 | 1 {
  if (!sourceId || !overId || sourceId === overId || itemId === sourceId) return 0;
  const source = railIds.indexOf(sourceId);
  const over = railIds.indexOf(overId);
  const item = railIds.indexOf(itemId);
  if (source < 0 || over < 0 || item < 0) return 0;
  if (source < over && item > source && item <= over) return -1;
  if (source > over && item >= over && item < source) return 1;
  return 0;
}
