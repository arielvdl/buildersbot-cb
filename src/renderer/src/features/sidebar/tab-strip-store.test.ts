import { describe, expect, it } from "vitest";
import {
  createSidebarTabStripStore,
  SIDEBAR_CHAT_TABS_LIMIT,
  visibleSidebarChatTabs,
} from "../../../../../packages/ui/src/features/sidebar/stores/tab-strip-store";

describe("the tab strip of a chat row", () => {
  it("stays closed until the user clicks, and the pointer changes nothing", () => {
    const store = createSidebarTabStripStore();
    expect(store.isOpen("agent:one")).toBe(false);
    store.toggle("agent:one");
    expect(store.isOpen("agent:one")).toBe(true);
    expect(store.isExpanded("agent:one")).toBe(true);
  });

  it("closes the tabs on a second click", () => {
    const store = createSidebarTabStripStore();
    store.toggle("channel:one");
    store.toggle("channel:one");
    expect(store.isOpen("channel:one")).toBe(false);
  });

  it("opens one chat without opening another", () => {
    const store = createSidebarTabStripStore();
    store.toggle("agent:one");
    expect(store.isOpen("agent:two")).toBe(false);
  });
});

describe("the tabs a chat row lists", () => {
  const tabs = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `tab-${index}` }));

  it("lists every tab up to the limit", () => {
    expect(visibleSidebarChatTabs(tabs(SIDEBAR_CHAT_TABS_LIMIT), "tab-0")).toHaveLength(SIDEBAR_CHAT_TABS_LIMIT);
    expect(visibleSidebarChatTabs(tabs(3), undefined)).toHaveLength(3);
  });

  it("lists the first ten of a longer list, in order", () => {
    const shown = visibleSidebarChatTabs(tabs(25), "tab-2");
    expect(shown.map((tab) => tab.id)).toEqual(tabs(10).map((tab) => tab.id));
  });

  it("keeps the open tab in the list when it is past the limit", () => {
    const shown = visibleSidebarChatTabs(tabs(25), "tab-17");
    expect(shown).toHaveLength(SIDEBAR_CHAT_TABS_LIMIT);
    expect(shown.at(-1)?.id).toBe("tab-17");
    expect(shown.slice(0, -1).map((tab) => tab.id)).toEqual(tabs(9).map((tab) => tab.id));
  });
});
