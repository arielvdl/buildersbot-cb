/**
 * Which chats in the list show their tabs. A bar at the bottom of the row opens them for good;
 * hovering the row previews them, as a collapsed tab group does in Chrome, without changing what the
 * user chose. The set is keyed by `sidebarChatTabsKey`, so a chat that moves between sections keeps
 * its state.
 */

import { createSignal } from "solid-js";

export function createSidebarTabStripStore() {
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [previewed, setPreviewed] = createSignal<string | null>(null);

  const isExpanded = (key: string): boolean => expanded().has(key);
  /** The tabs show: the user opened them, or the pointer previews them. */
  const isOpen = (key: string): boolean => isExpanded(key) || previewed() === key;

  function toggle(key: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** The pointer entered or left a chat row. Leaving clears only this chat's preview. */
  function preview(key: string, shown: boolean): void {
    setPreviewed((current) => {
      if (shown) return key;
      return current === key ? null : current;
    });
  }

  return { isExpanded, isOpen, preview, toggle };
}

export type SidebarTabStripStore = ReturnType<typeof createSidebarTabStripStore>;
