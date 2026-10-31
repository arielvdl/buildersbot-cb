import { SIDEBAR_UNASSIGNED_SECTION_ID, type SidebarLayoutSnapshot } from "@openbot/contracts/ipc";

/**
 * The custom section that a new chat joins: the one the rail has selected, while the rail is on screen
 * and that section is still in the layout. Null for "All" and for "No section", so the chat stays
 * without a section, as the list shows it.
 */
export function newChatSectionId(
  layout: SidebarLayoutSnapshot,
  selectedId: string | null | undefined,
  railVisible: boolean,
): string | null {
  if (!railVisible || !selectedId || selectedId === SIDEBAR_UNASSIGNED_SECTION_ID) return null;
  return layout.sections.some((section) => section.id === selectedId) && layout.order.includes(selectedId)
    ? selectedId
    : null;
}
