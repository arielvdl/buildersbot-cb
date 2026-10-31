/**
 * Everything `Sidebar` is, minus the markup. The component builds this once and reads it, and the
 * regions read it through the scope context.
 *
 * The body here is composition: each store under `stores/` owns one concern and is built in
 * dependency order, because a store can only be handed what already exists. The drag&drop pipeline
 * is the one part that needs a closure of its own, and `createSidebarDragEngine` is it.
 */

import { createContext, createEffect, onCleanup, useContext } from "solid-js";
import { createScrollFades } from "../../components/createScrollFades";
import { createSidebarDragEngine } from "./createSidebarDragEngine";
import type { SidebarProps } from "./sidebar-types";
import { createSidebarAnnouncementStore } from "./stores/announcement-store";
import { createSidebarDataStore } from "./stores/data-store";
import { createSidebarDragStateStore } from "./stores/drag-state-store";
import { createSidebarLayoutActions } from "./stores/layout-actions";
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
    deleting,
    openDelete,
    pending,
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
    assignChatSection,
    cancelSectionEditor,
    closeDelete,
    confirmDelete,
    confirmSectionDelete,
    customSectionById,
    deleteError,
    deleteTarget,
    channelDeleteTarget,
    deleting,
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
