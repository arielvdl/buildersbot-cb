import { describe, expect, it } from "vitest";
import { createSidebarTabStripStore } from "../../../../../packages/ui/src/features/sidebar/stores/tab-strip-store";

describe("the tab strip of a chat row", () => {
  it("opens on a preview and closes when the pointer leaves", () => {
    const store = createSidebarTabStripStore();
    store.preview("agent:one", true);
    expect(store.isOpen("agent:one")).toBe(true);
    store.preview("agent:one", false);
    expect(store.isOpen("agent:one")).toBe(false);
  });

  it("keeps the tabs open after the bar is clicked, also when the pointer leaves", () => {
    const store = createSidebarTabStripStore();
    store.toggle("agent:one");
    store.preview("agent:one", true);
    store.preview("agent:one", false);
    expect(store.isExpanded("agent:one")).toBe(true);
    expect(store.isOpen("agent:one")).toBe(true);
  });

  it("closes only the previewed chat when the pointer leaves another", () => {
    const store = createSidebarTabStripStore();
    store.preview("agent:one", true);
    store.preview("agent:two", true);
    store.preview("agent:one", false);
    expect(store.isOpen("agent:two")).toBe(true);
    expect(store.isOpen("agent:one")).toBe(false);
  });

  it("closes the tabs on a second click", () => {
    const store = createSidebarTabStripStore();
    store.toggle("channel:one");
    store.toggle("channel:one");
    expect(store.isOpen("channel:one")).toBe(false);
  });
});
