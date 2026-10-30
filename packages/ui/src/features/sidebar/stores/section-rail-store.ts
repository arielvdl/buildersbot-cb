/**
 * The section rail as the sidebar reads it: the rail items, the section the list shows, and the
 * section whose icon editor is open. Without `props.sectionRail` there is no rail, the list shows every
 * section, and each answer here says so.
 */

import { createMemo, createSignal } from "solid-js";
import {
  resolveSidebarSectionRailSelection,
  sidebarChatSectionId,
  sidebarSectionRailItems,
  sidebarSectionRailOrder,
} from "../sidebar-section-rail";
import type { SidebarProps } from "../sidebar-types";

export function createSidebarSectionRailStore(props: SidebarProps) {
  const hiddenAgentIds = createMemo(() => new Set((props.userHiddenAgents ?? []).map((entry) => entry.agentId)));
  const items = createMemo(() =>
    props.sectionRail
      ? sidebarSectionRailItems({
          layout: props.layout,
          agents: props.agents,
          channels: props.channels ?? [],
          agentStates: props.agentStates,
          channelWaits: props.channelWaits,
          hiddenAgentIds: hiddenAgentIds(),
        })
      : [],
  );
  /** The section the list shows, or null for every section. A section that is gone reads as null. */
  const focus = createMemo(() =>
    props.sectionRail ? resolveSidebarSectionRailSelection(props.sectionRail.selectedId, items()) : null,
  );
  /** The section ids the list draws, in the layout order. */
  const order = createMemo(() => sidebarSectionRailOrder(props.layout, focus()));
  const [iconEditorSectionId, setIconEditorSectionId] = createSignal<string | null>(null);

  /** Whether the list shows a chat: every chat, or only the chats of the selected section. */
  function chatInFocus(chatId: string): boolean {
    const section = focus();
    return section === null || sidebarChatSectionId(props.layout, chatId) === section;
  }

  /** The section icon can change only where the layout stores it, and only for a custom section. */
  function iconEditable(sectionId: string): boolean {
    return (
      props.sectionIconsSupported === true &&
      props.layoutMutable !== false &&
      props.layout.sections.some((section) => section.id === sectionId)
    );
  }

  function openIconEditor(sectionId: string): void {
    if (iconEditable(sectionId)) setIconEditorSectionId(sectionId);
  }

  function closeIconEditor(): void {
    setIconEditorSectionId(null);
  }

  return {
    chatInFocus,
    closeIconEditor,
    focus,
    iconEditable,
    iconEditorSectionId,
    items,
    openIconEditor,
    order,
  };
}

export type SidebarSectionRailStore = ReturnType<typeof createSidebarSectionRailStore>;
