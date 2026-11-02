/**
 * Everything `Sidebar` is, minus the markup. The component builds this once and reads it, and the
 * regions read it through the scope context.
 *
 * The body here is composition: each store under `stores/` owns one concern and is built in
 * dependency order, because a store can only be handed what already exists. The drag&drop pipeline
 * is the one part that needs a closure of its own, and `createSidebarDragEngine` is it.
 */

import { createContext, createEffect, createMemo, onCleanup, untrack, useContext } from "solid-js";
import { createScrollFades } from "../../components/createScrollFades";
import { createSidebarDragEngine } from "./createSidebarDragEngine";
import { type SidebarOpenChat, sidebarOpenChatKey, sidebarRevealSteps } from "./sidebar-reveal";
import { sidebarChatSectionId } from "./sidebar-section-rail";
import type { SidebarProps } from "./sidebar-types";
import { createSidebarAnnouncementStore } from "./stores/announcement-store";
import { createSidebarDataStore } from "./stores/data-store";
import { createSidebarDragStateStore } from "./stores/drag-state-store";
import { createSidebarLayoutActions } from "./stores/layout-actions";
import { createSidebarMarkerStore } from "./stores/marker-store";
import { createSidebarPendingStore } from "./stores/pending-store";
import { createSidebarSectionColorStore } from "./stores/section-color-store";
import { createSidebarTabStripStore } from "./stores/tab-strip-store";

export function createSidebarScope(props: SidebarProps) {
  const layoutMutable = () => props.layoutMutable !== false;
  const scrollFades = createScrollFades();
  const tabStrips = createSidebarTabStripStore();

  const { announce, announceError, reorderAnnouncement } = createSidebarAnnouncementStore();
  // The drag state is built from the data store, so the data store reads it through this reference,
  // which is set once the drag state exists.
  let dragActive = () => false;
  const {
    activityHiddenCount,
    listFilter,
    assignedSectionId,
    chatKind,
    chatName,
    chatPinnedItems,
    customSectionById,
    directThreadByMember,
    filteredAgents,
    filteredChats,
    filteredChatsBySection,
    orderedPeople,
    personById,
    resolvedPinnedItems,
    sectionAcceptsChat,
    sectionIsCollapsed,
    sectionLabel,
    sectionPosition,
    sectionRail,
    userHiddenAgentList,
    userHiddenSince,
    visiblePinnedKeys,
    visibleSectionIds,
    waitingChats,
  } = createSidebarDataStore({ props, dragActive: () => dragActive() });
  const {
    cancelSectionEditor,
    closeDelete,
    confirmDelete,
    confirmSectionDelete,
    deleteError,
    deleteTarget,
    channelDeleteTarget,
    channelExclusiveAgents,
    deleting,
    openDelete,
    pending,
    setDeleteWithAgents,
    releaseSectionNameInput,
    saveSectionEditor,
    sectionDeleteTarget,
    setSectionNameInput,
    startCreateSection: startInlineCreateSection,
    startRenameSection,
    updateSectionEditorName,
  } = createSidebarPendingStore({ customSectionById, props });
  /**
   * With the section rail, a new section opens the name dialog, and the rail selects the new section.
   * The field at the end of the list would show only with "All". Without the rail, the field stays.
   */
  const startCreateSection = (agentId?: string): void => {
    if (props.sectionRail) sectionRail.openNameDialog({ kind: "create", ...(agentId ? { agentId } : {}) });
    else startInlineCreateSection(agentId);
  };
  const markers = createSidebarMarkerStore({ props, focus: sectionRail.focus, announceError });
  let agentList: HTMLElement | undefined;

  const dragState = createSidebarDragStateStore({ chatKind, sectionAcceptsChat });
  dragActive = () => dragState.draggingKind() !== undefined;
  const {
    assignChatSection,
    commitSidebarDrop,
    duplicateSection,
    movePersonByKeyboard,
    movePinnedItem,
    moveSection,
    setSectionColor,
  } = createSidebarLayoutActions({
    announce,
    announceError,
    assignedSectionId,
    canPinDraggedSidebarItem: dragState.canPinDraggedSidebarItem,
    chatName,
    chatPinnedItems,
    draggedSidebarItem: dragState.draggedSidebarItem,
    filteredChatsBySection,
    layoutMutable,
    orderedPeople,
    personById,
    props,
    sectionLabel,
    visiblePinnedKeys,
    visibleSectionIds,
  });
  const {
    pickCustomSectionColor,
    previewCustomSectionColor,
    releaseSectionColorInput,
    saveCustomSectionColor,
    setSectionColorInput,
  } = createSidebarSectionColorStore({ props, setSectionColor });
  const {
    dropSidebarNativeDrag,
    endChatDragging,
    handleListDragLeave,
    sidebarClickIsSuppressed,
    startChatDragging,
    startNativeItemDragging,
    startPersonDragging,
    startSectionDragging,
    stopSidebarDragging,
    updateSidebarNativeDrag,
  } = createSidebarDragEngine({
    assignedSectionId,
    canPinDraggedItem: dragState.canPinDraggedSidebarItem,
    chatKind,
    chatPinnedItems,
    commitSidebarDrop,
    dragState,
    filteredChatsBySection,
    getAgentList: () => agentList,
    orderedPeople,
    props,
    scrollFades,
    sectionAcceptsChat,
    visiblePinnedKeys,
    visibleSectionIds,
  });

  onCleanup(() => {
    stopSidebarDragging();
    scrollFades.stop();
  });

  createEffect(
    () => [resolvedPinnedItems(), waitingChats(), filteredChats(), orderedPeople(), userHiddenAgentList()],
    () => {
      scrollFades.remeasure();
    },
  );

  /**
   * The open chat, and the section it is in. A chat that opens from outside the list (search, a
   * notification, Back and Forward, a restore at start) can be in a section that the rail does not
   * select, in a collapsed section or under a filter. The list then changes to show it, as a click on
   * its row would have found it. The key leaves out the rail, the collapsed sections and the filters,
   * so the list does not undo a change that the reader makes while the chat stays open. It keeps the
   * chat's section, so a layout that arrives after the chat (at start) shows it too.
   */
  const openChat = (): SidebarOpenChat | null => {
    if (props.activeChannelId) return { kind: "channel", id: props.activeChannelId };
    if (props.activeDirectMemberId) return { kind: "person", id: props.activeDirectMemberId };
    return props.activeAgentId ? { kind: "agent", id: props.activeAgentId } : null;
  };
  const openChatKey = createMemo(() => {
    const chat = openChat();
    const key = sidebarOpenChatKey(chat);
    if (!chat || !key) return null;
    return chat.kind === "person" ? key : `${key}\n${sidebarChatSectionId(props.layout, chat.id)}`;
  });
  createEffect(
    () => {
      const key = openChatKey();
      const chat = untrack(openChat);
      if (!key || !chat) return null;
      return untrack(() => ({
        chat,
        steps: sidebarRevealSteps({
          chat,
          layout: props.layout,
          railFocus: sectionRail.focus(),
          railSectionIds: sectionRail.items().map((item) => item.id),
          collapsedSectionIds: new Set(props.collapsedSectionIds),
          pinned:
            chat.kind !== "person" && chatPinnedItems().some((item) => item.kind === chat.kind && item.id === chat.id),
          waiting:
            chat.kind === "agent"
              ? props.agentStates[chat.id]?.kind === "waiting"
              : chat.kind === "channel" && props.channelWaits?.[chat.id] !== undefined,
          userHidden: chat.kind === "agent" && userHiddenSince(chat.id) !== undefined,
          activityFilter: listFilter.activity(),
          routineFilter: listFilter.routine(),
        }),
        selectSection: props.sectionRail?.onSelect,
        toggleSection: props.onToggleSection,
        clearActivityFilter: props.onActivityFilterChange,
        clearRoutineFilter: props.onRoutineFilterChange,
      }));
    },
    (reveal) => {
      if (!reveal) return;
      const { steps } = reveal;
      if (steps.railSectionId !== undefined) reveal.selectSection?.(steps.railSectionId);
      for (const sectionId of steps.toggleSectionIds) reveal.toggleSection(sectionId);
      if (steps.clearActivityFilter) reveal.clearActivityFilter?.(null);
      if (steps.clearRoutineFilter) reveal.clearRoutineFilter?.(null);
      // The row draws after this change, so it scrolls into view in the next frame.
      const frame = requestAnimationFrame(() => {
        agentList?.querySelector<HTMLElement>('button[aria-pressed="true"]')?.scrollIntoView({ block: "nearest" });
      });
      return () => cancelAnimationFrame(frame);
    },
  );

  /** The two statements the list's `ref` used to run inline, in the same order. */
  const setAgentListElement = (element: HTMLElement) => {
    agentList = element;
    scrollFades.bind(element);
  };

  /**
   * The scope's public surface, and the whole of what a region component may reach for. The drag
   * store's writers are deliberately absent: only the engine may move a drag along.
   */
  return {
    activityHiddenCount,
    listFilter,
    assignChatSection,
    cancelSectionEditor,
    closeDelete,
    confirmDelete,
    confirmSectionDelete,
    customSectionById,
    deleteError,
    deleteTarget,
    channelDeleteTarget,
    channelExclusiveAgents,
    deleting,
    setDeleteWithAgents,
    chatPinnedItems,
    directThreadByMember,
    dragOffset: dragState.dragOffset,
    dragOverPinnedKey: dragState.dragOverPinnedKey,
    draggedChatId: dragState.draggedChatId,
    draggedPinnedKey: dragState.draggedPinnedKey,
    draggingKind: dragState.draggingKind,
    dropSidebarNativeDrag,
    duplicateSection,
    emptyPinnedDropVisible: dragState.emptyPinnedDropVisible,
    endChatDragging,
    filteredAgents,
    filteredChats,
    filteredChatsBySection,
    handleListDragLeave,
    layoutMutable,
    markers,
    movePersonByKeyboard,
    movePinnedItem,
    moveSection,
    openDelete,
    orderedPeople,
    pending,
    pickCustomSectionColor,
    pinnedDropActive: dragState.pinnedDropActive,
    previewCustomSectionColor,
    props,
    releaseSectionColorInput,
    releaseSectionNameInput,
    reorderAnnouncement,
    resolvedPinnedItems,
    saveCustomSectionColor,
    saveSectionEditor,
    scrollFades,
    sectionDeleteTarget,
    sectionDragClasses: dragState.sectionDragClasses,
    sectionIsCollapsed,
    sectionPosition,
    sectionRail,
    setAgentListElement,
    setSectionColor,
    setSectionColorInput,
    setSectionNameInput,
    sidebarClickIsSuppressed,
    startChatDragging,
    startCreateSection,
    startNativeItemDragging,
    startPersonDragging,
    startRenameSection,
    startSectionDragging,
    stopSidebarDragging,
    tabStrips,
    updateSectionEditorName,
    updateSidebarNativeDrag,
    userHiddenAgentList,
    userHiddenSince,
    visibleSectionIds,
    waitingChats,
  };
}

export type SidebarScope = ReturnType<typeof createSidebarScope>;

export const SidebarScopeContext = createContext<SidebarScope>();

export function useSidebarScope(): SidebarScope {
  const scope = useContext(SidebarScopeContext);
  if (!scope) throw new Error("Sidebar scope is unavailable outside Sidebar.");
  return scope;
}
