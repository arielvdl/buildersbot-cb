/**
 * The order rules of the sidebar markers, shared by the host store, the preview mock and the stories.
 * While a layout has a marker, `itemOrder` holds the chats and the markers in one sequence, and each
 * change writes `agentOrder` again as that sequence without the markers. Without a marker, neither
 * field changes: a layout with no marker is the released layout.
 */

import type { SidebarLayoutAction, SidebarLayoutSnapshot } from "./ipc-sidebar-layout";
import {
  isSidebarMarker,
  isSidebarMarkerId,
  normalizeSidebarMarkerFields,
  SIDEBAR_MARKER_ID_PREFIX,
  SIDEBAR_MARKER_LIMITS,
  type SidebarMarker,
} from "./ipc-sidebar-markers";

export type SidebarMarkerAction = Extract<
  SidebarLayoutAction,
  { type: "create-marker" | "update-marker" | "delete-marker" | "move-marker" }
>;

export function isSidebarMarkerAction(action: SidebarLayoutAction): action is SidebarMarkerAction {
  return (
    action.type === "create-marker" ||
    action.type === "update-marker" ||
    action.type === "delete-marker" ||
    action.type === "move-marker"
  );
}

/** The section of a chat or a marker: a custom section of the layout, or null for no section. */
export function sidebarItemSectionId(layout: SidebarLayoutSnapshot, itemId: string): string | null {
  const marker = layout.markers?.find((candidate) => candidate.id === itemId);
  if (marker) return marker.sectionId;
  const assigned = layout.agentAssignments[itemId];
  return assigned && layout.sections.some((section) => section.id === assigned) ? assigned : null;
}

/**
 * The chats and the markers in one sequence: `itemOrder`, or `agentOrder` while there is no marker.
 * A chat that the sequence does not have yet goes at the end. An id that is neither a chat in `chatIds`
 * nor a marker of the layout drops out.
 */
export function sidebarItemOrder(layout: SidebarLayoutSnapshot, chatIds: ReadonlySet<string>): string[] {
  const markerIds = new Set((layout.markers ?? []).map((marker) => marker.id));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of [...(layout.itemOrder ?? []), ...layout.agentOrder, ...chatIds, ...markerIds]) {
    if (seen.has(id) || (!markerIds.has(id) && !chatIds.has(id))) continue;
    seen.add(id);
    order.push(id);
  }
  return order;
}

/**
 * The sequence with `itemId` moved: before `beforeId`, or, for null or an id that is not there, after the
 * last item of `sectionId`, or at the end when the section has no item.
 */
export function sidebarOrderWithMove(
  order: readonly string[],
  itemId: string,
  beforeId: string | null,
  sectionId: string | null,
  sectionOf: (id: string) => string | null,
): string[] {
  const moved = order.filter((id) => id !== itemId);
  let index = beforeId === null ? -1 : moved.indexOf(beforeId);
  if (index < 0) {
    index = moved.length;
    for (const [position, id] of moved.entries()) if (sectionOf(id) === sectionId) index = position + 1;
  }
  moved.splice(index, 0, itemId);
  return moved;
}

/** The layout with these markers and this sequence. No marker drops both fields. */
function withMarkers(
  layout: SidebarLayoutSnapshot,
  markers: SidebarMarker[],
  itemOrder: readonly string[],
): SidebarLayoutSnapshot {
  const next: SidebarLayoutSnapshot = { ...layout, revision: layout.revision + 1 };
  delete next.markers;
  delete next.itemOrder;
  next.agentOrder = itemOrder.filter((id) => !isSidebarMarkerId(id));
  if (markers.length === 0) return next;
  return { ...next, markers, itemOrder: [...itemOrder] };
}

function requireSection(layout: SidebarLayoutSnapshot, sectionId: string | null): void {
  if (sectionId !== null && !layout.sections.some((section) => section.id === sectionId)) {
    throw new Error("Unknown sidebar section.");
  }
}

function requireRoom(layout: SidebarLayoutSnapshot, sectionId: string | null, limitError: string): void {
  const count = (layout.markers ?? []).filter((marker) => marker.sectionId === sectionId).length;
  if (count >= SIDEBAR_MARKER_LIMITS.perSection) throw new Error(limitError);
}

function requireMarker(layout: SidebarLayoutSnapshot, markerId: string): SidebarMarker {
  const marker = layout.markers?.find((candidate) => candidate.id === markerId);
  if (!marker) throw new Error("Unknown sidebar marker.");
  return marker;
}

/**
 * Applies one marker action. `chatIds` are the agents and the channels of the host. `limitError` is
 * the text of the error for a section that has the most markers already. It throws on any other
 * request that is not valid.
 */
export function applySidebarMarkerAction(
  layout: SidebarLayoutSnapshot,
  action: SidebarMarkerAction,
  chatIds: ReadonlySet<string>,
  newUuid: () => string,
  limitError: string,
): SidebarLayoutSnapshot {
  const markers = layout.markers ?? [];
  const order = sidebarItemOrder(layout, chatIds);
  switch (action.type) {
    case "create-marker": {
      requireSection(layout, action.sectionId);
      requireRoom(layout, action.sectionId, limitError);
      const fields = normalizeSidebarMarkerFields(action);
      if (!fields) throw new Error("Invalid sidebar marker.");
      const marker: SidebarMarker = {
        id: `${SIDEBAR_MARKER_ID_PREFIX}${newUuid()}`,
        sectionId: action.sectionId,
        ...fields,
      };
      // The top of the section: before its first chat or marker.
      const first = order.find((id) => sidebarItemSectionId(layout, id) === action.sectionId) ?? null;
      const sectionOf = (id: string) => sidebarItemSectionId(layout, id);
      return withMarkers(
        layout,
        [...markers, marker],
        sidebarOrderWithMove(order, marker.id, first, action.sectionId, sectionOf),
      );
    }
    case "update-marker": {
      const marker = requireMarker(layout, action.markerId);
      const fields = normalizeSidebarMarkerFields(action);
      if (!fields) throw new Error("Invalid sidebar marker.");
      const next: SidebarMarker = { id: marker.id, sectionId: marker.sectionId, ...fields };
      if (JSON.stringify(next) === JSON.stringify(marker)) return layout;
      return withMarkers(
        layout,
        markers.map((candidate) => (candidate.id === marker.id ? next : candidate)),
        order,
      );
    }
    case "delete-marker": {
      requireMarker(layout, action.markerId);
      return withMarkers(
        layout,
        markers.filter((marker) => marker.id !== action.markerId),
        order.filter((id) => id !== action.markerId),
      );
    }
    case "move-marker": {
      const marker = requireMarker(layout, action.markerId);
      requireSection(layout, action.sectionId);
      if (marker.sectionId !== action.sectionId) requireRoom(layout, action.sectionId, limitError);
      if (action.beforeId !== null) {
        if (action.beforeId === marker.id || !order.includes(action.beforeId)) {
          throw new Error("Unknown sidebar marker order target.");
        }
        if (sidebarItemSectionId(layout, action.beforeId) !== action.sectionId) {
          throw new Error("Sidebar marker order target belongs to another section.");
        }
      }
      const moved = { ...marker, sectionId: action.sectionId };
      const sectionOf = (id: string) => sidebarItemSectionId(layout, id);
      const nextOrder = sidebarOrderWithMove(order, marker.id, action.beforeId, action.sectionId, sectionOf);
      if (marker.sectionId === action.sectionId && nextOrder.every((id, index) => id === order[index])) return layout;
      return withMarkers(
        layout,
        markers.map((candidate) => (candidate.id === marker.id ? moved : candidate)),
        nextOrder,
      );
    }
  }
}

/**
 * The two sequences after a chat move in a layout with markers. `beforeId` is a chat or a marker of the
 * target section, or null for its end.
 */
export function sidebarOrdersWithChatMove(
  layout: SidebarLayoutSnapshot,
  chatId: string,
  sectionId: string | null,
  beforeId: string | null,
  chatIds: ReadonlySet<string>,
): { agentOrder: string[]; itemOrder: string[] } {
  const sectionOf = (id: string) => (id === chatId ? sectionId : sidebarItemSectionId(layout, id));
  const itemOrder = sidebarOrderWithMove(sidebarItemOrder(layout, chatIds), chatId, beforeId, sectionId, sectionOf);
  return { itemOrder, agentOrder: itemOrder.filter((id) => !isSidebarMarkerId(id)) };
}

/** The markers and the sequence that a stored layout can keep: valid markers of known sections, at most the limit for each section. */
export function storedSidebarMarkers(
  markers: unknown,
  itemOrder: unknown,
  sectionIds: ReadonlySet<string>,
): Pick<SidebarLayoutSnapshot, "markers" | "itemOrder"> {
  if (!Array.isArray(markers)) return {};
  const kept: SidebarMarker[] = [];
  const counts = new Map<string | null, number>();
  for (const marker of markers) {
    if (!isSidebarMarker(marker) || kept.some((candidate) => candidate.id === marker.id)) continue;
    if (marker.sectionId !== null && !sectionIds.has(marker.sectionId)) continue;
    const count = counts.get(marker.sectionId) ?? 0;
    if (count >= SIDEBAR_MARKER_LIMITS.perSection) continue;
    counts.set(marker.sectionId, count + 1);
    kept.push({ ...marker });
  }
  if (kept.length === 0) return {};
  const keptIds = new Set(kept.map((marker) => marker.id));
  const order: string[] = [];
  for (const id of Array.isArray(itemOrder) ? itemOrder : []) {
    if (typeof id !== "string" || order.includes(id)) continue;
    // Any id with the marker prefix is a marker, kept or not: never a chat.
    if (id.startsWith(SIDEBAR_MARKER_ID_PREFIX) && !keptIds.has(id)) continue;
    order.push(id);
  }
  for (const id of keptIds) if (!order.includes(id)) order.push(id);
  return { markers: kept, itemOrder: order };
}
