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
    if (sectionIds.has(section.id)) return false;
    sectionIds.add(section.id);
  }
  return (
    isCompleteSectionOrder(value.order, sectionIds) &&
    Object.values(value.agentAssignments).every(isString) &&
    value.agentOrder.every(isString) &&
    new Set(value.agentOrder).size === value.agentOrder.length
  );
}

export type SidebarLayoutAction =
  | { type: "create"; name: string; agentId?: string }
  | { type: "rename"; sectionId: string; name: string }
  | { type: "delete"; sectionId: string }
  | { type: "move"; sectionId: string; direction: "up" | "down"; steps?: number }
  | { type: "assign"; agentId: string; sectionId: string | null }
  | { type: "move-agent"; agentId: string; sectionId: string | null; beforeAgentId: string | null }
  /** Local layout only. `color` is `#rrggbb`; null removes the color. No Team API protocol sends it. */
  | { type: "set-section-color"; sectionId: string; color: string | null };
