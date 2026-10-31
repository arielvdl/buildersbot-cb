/**
 * The view rules of the list markers. Nothing here renders, so each rule has a test.
 */

import { SIDEBAR_UNASSIGNED_SECTION_ID, type SidebarLayoutSnapshot, type SidebarMarker } from "@openbot/contracts/ipc";
import type { SidebarChatItem } from "./sidebar-types";

/**
 * The marker that styles each chat of one section: the nearest marker above it. A marker styles the
 * chats below it up to the next marker; the chats above the first marker have none.
 */
export function sidebarMarkerOfChats(items: readonly SidebarChatItem[]): Map<string, SidebarMarker> {
  const styles = new Map<string, SidebarMarker>();
  let current: SidebarMarker | null = null;
  for (const item of items) {
    if (item.kind === "marker") current = item.marker;
    else if (current) styles.set(item.id, current);
  }
  return styles;
}

const MARKER_ACCENT = /^#[0-9a-f]{6}$/;

/**
 * The color that the marker line draws with: the color of a marker with the tint style. A marker of
 * another style, and a value that is not a six-digit hex color, have none, so the line keeps the theme colors.
 */
export function sidebarMarkerAccent(marker: Pick<SidebarMarker, "style" | "color">): string | null {
  const color = marker.color?.toLowerCase();
  return marker.style === "tint" && color !== undefined && MARKER_ACCENT.test(color) ? color : null;
}

/**
 * The section of a new marker: the section that the rail selects, or, with "All", the first custom
 * section of the list, or the chats with no section when there is no custom section.
 */
export function sidebarMarkerCreateSection(layout: SidebarLayoutSnapshot, focus: string | null): string | null {
  if (focus === SIDEBAR_UNASSIGNED_SECTION_ID) return null;
  if (focus !== null) return focus;
  return layout.order.find((sectionId) => layout.sections.some((section) => section.id === sectionId)) ?? null;
}

/**
 * The marker that a create added: the one marker whose id was not in the layout before. The editor of
 * that marker opens, so the user can write its text.
 */
export function sidebarCreatedMarkerId(before: ReadonlySet<string>, layout: SidebarLayoutSnapshot): string | null {
  const added = (layout.markers ?? []).filter((marker) => !before.has(marker.id));
  return added.length === 1 ? (added[0]?.id ?? null) : null;
}
