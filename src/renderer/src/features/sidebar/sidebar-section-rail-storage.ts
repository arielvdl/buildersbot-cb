import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { z } from "zod";

/**
 * The section that the section rail selects in each scope, kept on this computer. A scope with no entry
 * shows "All". The value is a section id of that scope's layout; the sidebar reads a section that is
 * gone as "All", and keeps the entry, because a layout that is still loading lists no section yet.
 */
export type SidebarSectionRailByScope = Record<string, string>;

const SIDEBAR_SECTION_RAIL_STORAGE_KEY = "openbot:sidebar-section-rail:v1";

type SidebarSectionRailStorage = Pick<Storage, "getItem" | "setItem">;

const sectionIdSchema = z.string().trim().min(1).max(INPUT_LIMITS.identifier);
const storedSchema = z.record(z.string(), z.unknown());

export function readSidebarSectionRail(
  storage: SidebarSectionRailStorage = window.localStorage,
): SidebarSectionRailByScope {
  try {
    const parsed = storedSchema.safeParse(JSON.parse(storage.getItem(SIDEBAR_SECTION_RAIL_STORAGE_KEY) ?? "{}"));
    if (!parsed.success) return {};
    return Object.fromEntries(
      Object.entries(parsed.data).flatMap(([scope, value]) => {
        const sectionId = sectionIdSchema.safeParse(value);
        return scope.trim() && sectionId.success ? [[scope, sectionId.data]] : [];
      }),
    );
  } catch {
    return {};
  }
}

/** The map with the selection of one scope. Null is "All", which the map stores as no entry. */
export function withSidebarSectionRailSelection(
  current: SidebarSectionRailByScope,
  scope: string,
  sectionId: string | null,
): SidebarSectionRailByScope {
  const next = { ...current };
  if (sectionId === null) delete next[scope];
  else next[scope] = sectionId;
  return next;
}

export function writeSidebarSectionRail(
  selection: SidebarSectionRailByScope,
  storage: SidebarSectionRailStorage = window.localStorage,
): void {
  try {
    storage.setItem(SIDEBAR_SECTION_RAIL_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // A private display preference must not block the sidebar.
  }
}
