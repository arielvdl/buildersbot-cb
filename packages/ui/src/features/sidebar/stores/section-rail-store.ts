/**
 * The section rail as the sidebar reads it: the rail items, the section the list shows, and the dialogs
 * that the rail opens (the section name and the section icon). Without `props.sectionRail` there is no
 * rail, the list shows every section, and each answer here says so.
 */

import { createEffect, createMemo, createSignal } from "solid-js";
import {
  resolveSidebarSectionRailSelection,
  sameSidebarSectionRailItems,
  sidebarChatSectionId,
  sidebarCreatedSectionId,
  sidebarSectionRailItems,
  sidebarSectionRailOrder,
} from "../sidebar-section-rail";
import type { SidebarProps } from "../sidebar-types";

/** What the name dialog does: make a section, with an agent in it when one is given, or rename one. */
export type SidebarSectionNameDialogTarget =
  | { kind: "create"; agentId?: string }
  | { kind: "rename"; sectionId: string };

export function createSidebarSectionRailStore(props: SidebarProps) {
  const hiddenAgentIds = createMemo(() => new Set((props.userHiddenAgents ?? []).map((entry) => entry.agentId)));
  // The equality keeps the old list while the rail shows the same thing, so a change of an agent state
  // that does not change a badge does not run the rail items or the list filters again.
  const items = createMemo(
    () =>
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
    { equals: sameSidebarSectionRailItems },
  );
  /** The section the list shows, or null for every section. A section that is gone reads as null. */
  const focus = createMemo(() =>
    props.sectionRail ? resolveSidebarSectionRailSelection(props.sectionRail.selectedId, items()) : null,
  );
  /** The section ids the list draws, in the layout order. */
  const order = createMemo(() => sidebarSectionRailOrder(props.layout, focus()));
  const [iconEditorSectionId, setIconEditorSectionId] = createSignal<string | null>(null);
  const [nameDialog, setNameDialog] = createSignal<SidebarSectionNameDialogTarget | null>(null);
  /** A section that the name dialog made, until the layout has it and the rail selects it. */
  const [created, setCreated] = createSignal<{ name: string; before: ReadonlySet<string> } | null>(null);

  createEffect(
    () => ({ pending: created(), sections: props.layout.sections, select: props.sectionRail?.onSelect }),
    ({ pending, sections, select }) => {
      if (!pending) return;
      const sectionId = sidebarCreatedSectionId(pending.before, sections, pending.name);
      if (!sectionId) return;
      setCreated(null);
      select?.(sectionId);
    },
  );

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

  function openNameDialog(target: SidebarSectionNameDialogTarget): void {
    if (props.layoutMutable === false) return;
    setNameDialog(target);
  }

  function closeNameDialog(): void {
    setNameDialog(null);
  }

  /** The rail selects the section that a create made, once the layout has it. */
  function selectWhenCreated(name: string, before: ReadonlySet<string>): void {
    setCreated({ name, before });
  }

  return {
    chatInFocus,
    closeIconEditor,
    closeNameDialog,
    focus,
    iconEditable,
    iconEditorSectionId,
    items,
    nameDialog,
    openIconEditor,
    openNameDialog,
    order,
    selectWhenCreated,
  };
}
