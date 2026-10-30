/**
 * Which chats in the list show their tabs. Only the user opens them: a click on the avatar of the
 * row, or on the bar at the bottom of it. The pointer over the row opens nothing, because a list
 * that unfolds under the pointer moves the rows the pointer is crossing. The set is keyed by
 * `sidebarChatTabsKey`, so a chat that moves between sections keeps its state.
 */

import { createSignal } from "solid-js";

/** The most tabs a row lists. A chat with more shows its open tab and the first ones. */
export const SIDEBAR_CHAT_TABS_LIMIT = 10;

/** The tabs a row lists: the first ones, and the open tab in the last place when it is past them. */
export function visibleSidebarChatTabs<T extends { id: string }>(
  tabs: readonly T[],
  activeId: string | undefined,
): T[] {
  if (tabs.length <= SIDEBAR_CHAT_TABS_LIMIT) return [...tabs];
  const first = tabs.slice(0, SIDEBAR_CHAT_TABS_LIMIT);
  if (activeId === undefined || first.some((tab) => tab.id === activeId)) return first;
  const active = tabs.find((tab) => tab.id === activeId);
  return active ? [...first.slice(0, SIDEBAR_CHAT_TABS_LIMIT - 1), active] : first;
}

export function createSidebarTabStripStore() {
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());

  const isExpanded = (key: string): boolean => expanded().has(key);
  /** The tabs show: the user opened them. */
  const isOpen = isExpanded;

  function toggle(key: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return { isExpanded, isOpen, toggle };
}

export type SidebarTabStripStore = ReturnType<typeof createSidebarTabStripStore>;
