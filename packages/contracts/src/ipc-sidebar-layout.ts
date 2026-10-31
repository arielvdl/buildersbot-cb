import { isSidebarMarker, type SidebarMarker, type SidebarMarkerStyle } from "./ipc-sidebar-markers";
import { isSidebarSectionIcon, type SidebarSectionIcon } from "./ipc-sidebar-section-icon";
import { isDynamicRecord, isNumber, isString } from "./runtime-values";

export const SIDEBAR_PEOPLE_SECTION_ID = "people";
export const SIDEBAR_UNASSIGNED_SECTION_ID = "unassigned";

export interface SidebarSection {
  id: string;
  name: string;
  /**
   * The background color of the section box, as `#rrggbb` in lower case. Absent means no color.
   * Only the local layout has it: no released Team API protocol carries it, and each frozen codec
   * drops it from the section.
   */
  color?: string;
  /**
   * The mark of the section in the section rail. Absent means the first letter of the name. Only the
   * local layout has it: no released Team API protocol carries it, and each frozen codec drops it.
   */
  icon?: SidebarSectionIcon;
}

const SIDEBAR_SECTION_COLOR = /^#[0-9a-f]{6}$/;
const SIDEBAR_SECTION_COLOR_INPUT = /^#[0-9a-f]{6}$/i;

/** True for a section color as the layout stores it: `#rrggbb` in lower case. */
export function isSidebarSectionColor(value: unknown): value is string {
  return isString(value) && SIDEBAR_SECTION_COLOR.test(value);
}

/** A `#rrggbb` color in any case, in the stored form. Null for every other value. */
export function normalizeSidebarSectionColor(value: unknown): string | null {
  return isString(value) && SIDEBAR_SECTION_COLOR_INPUT.test(value) ? value.toLowerCase() : null;
}

/** The section with `color`, or without the field when `color` is null, so no color writes no key. */
export function sidebarSectionWithColor<T extends SidebarSection>(section: T, color: string | null): T {
  const next = { ...section };
  delete next.color;
  return color === null ? next : { ...next, color };
}

export interface SidebarLayoutSnapshot {
  revision: number;
  sections: SidebarSection[];
  order: string[];
  agentAssignments: Record<string, string>;
  agentOrder: string[];
  /** The markers of the sections. Local layout only; absent when there is none. */
  markers?: SidebarMarker[];
  /**
   * The chats and the markers in one sequence, present while there is a marker. `agentOrder` is the
   * same sequence without the markers, so a peer that reads only `agentOrder` gets the same order.
   */
  itemOrder?: string[];
}

/**
 * True when `order` names the people section, the unassigned section and each of `sectionIds` exactly
 * once, and nothing else.
 *
 * The renderer draws the sidebar by walking `order` and looking each section up, so a section that
 * `order` leaves out is not drawn -- and every agent assigned to it is off the screen while its
 * roster row, its thread and every message in it are untouched. That reads to the user as history
 * that disappeared. `order` is therefore not a hint about arrangement that a consumer may complete;
 * it is the whole section set in the user's chosen sequence, and a layout that does not carry all of
 * it is invalid rather than partial.
 *
 * Exported because two places hold the same invariant and must agree: this module decodes a layout a
 * remote host sends, and `SidebarLayoutStore` validates the JSON file it wrote itself. One of them
 * checking is not enough -- an agent hidden by a layout from either source looks the same.
 */
export function isCompleteSectionOrder(order: readonly unknown[], sectionIds: Iterable<string>): boolean {
  const expected = new Set([SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID, ...sectionIds]);
  return (
    order.length === expected.size &&
    order.every((sectionId) => isString(sectionId) && expected.has(sectionId)) &&
    new Set(order).size === order.length
  );
}

export function isSidebarLayoutSnapshot(value: unknown): value is SidebarLayoutSnapshot {
  if (!isDynamicRecord(value) || !isNumber(value.revision) || !Number.isInteger(value.revision) || value.revision < 0) {
    return false;
  }
  if (
    !Array.isArray(value.sections) ||
    !Array.isArray(value.order) ||
    !isDynamicRecord(value.agentAssignments) ||
    !Array.isArray(value.agentOrder)
  ) {
    return false;
  }
  const sectionIds = new Set<string>();
  for (const section of value.sections) {
    if (!isDynamicRecord(section) || !isString(section.id) || !isString(section.name)) return false;
    if (section.color !== undefined && !isSidebarSectionColor(section.color)) return false;
    if (section.icon !== undefined && !isSidebarSectionIcon(section.icon)) return false;
    if (sectionIds.has(section.id)) return false;
    sectionIds.add(section.id);
  }
  return (
    isCompleteSectionOrder(value.order, sectionIds) &&
    Object.values(value.agentAssignments).every(isString) &&
    value.agentOrder.every(isString) &&
    new Set(value.agentOrder).size === value.agentOrder.length &&
    isSidebarMarkerList(value.markers, value.itemOrder, sectionIds)
  );
}

/**
 * True for absent markers, or for valid markers of known sections, each one once in `itemOrder`, a
 * list of unique ids. A layout with a marker that does not decode is invalid, as for a bad color.
 */
function isSidebarMarkerList(markers: unknown, itemOrder: unknown, sectionIds: ReadonlySet<string>): boolean {
  if (markers === undefined) return itemOrder === undefined;
  if (!Array.isArray(markers) || !Array.isArray(itemOrder)) return false;
  if (!itemOrder.every(isString) || new Set(itemOrder).size !== itemOrder.length) return false;
  const ids = new Set<string>();
  for (const marker of markers) {
    if (!isSidebarMarker(marker) || ids.has(marker.id)) return false;
    if (marker.sectionId !== null && !sectionIds.has(marker.sectionId)) return false;
    if (!itemOrder.includes(marker.id)) return false;
    ids.add(marker.id);
  }
  return true;
}

export type SidebarLayoutAction =
  | { type: "create"; name: string; agentId?: string }
  | { type: "rename"; sectionId: string; name: string }
  | { type: "delete"; sectionId: string }
  | { type: "move"; sectionId: string; direction: "up" | "down"; steps?: number }
  | { type: "assign"; agentId: string; sectionId: string | null }
  /** In a local layout with markers, `beforeAgentId` can also name a marker of the target section. */
  | { type: "move-agent"; agentId: string; sectionId: string | null; beforeAgentId: string | null }
  /** Local layout only. `color` is `#rrggbb`; null removes the color. No Team API protocol sends it. */
  | { type: "set-section-color"; sectionId: string; color: string | null }
  /** Local layout only. Null removes the icon, so the rail shows the first letter. No Team API protocol sends it. */
  | { type: "set-section-icon"; sectionId: string; icon: SidebarSectionIcon | null }
  /** Local layout only, as the marker actions below. A new marker goes to the top of its section. */
  | { type: "create-marker"; sectionId: string | null; label: string; style: SidebarMarkerStyle; color: string | null }
  | { type: "update-marker"; markerId: string; label: string; style: SidebarMarkerStyle; color: string | null }
  | { type: "delete-marker"; markerId: string }
  /** `beforeId` is a chat or a marker of the section, or null for the end of the section. */
  | { type: "move-marker"; markerId: string; sectionId: string | null; beforeId: string | null };
