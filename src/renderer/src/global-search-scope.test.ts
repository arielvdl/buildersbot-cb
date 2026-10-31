import { describe, expect, it } from "vitest";
import {
  GLOBAL_SEARCH_START_SCOPE,
  globalSearchNeedsScopedPage,
  globalSearchRemoteCount,
  globalSearchStartTab,
} from "../../../packages/ui/src/components/global-search-scope";

describe("the tab that the search opens on", () => {
  const tabs = ["all", "agents", "messages", "routines"] as const;

  it("is the wanted tab while it is visible", () => {
    expect(globalSearchStartTab("routines", tabs, "all")).toBe("routines");
  });

  it("is All with no wanted tab, or a wanted tab that is not visible", () => {
    expect(globalSearchStartTab(undefined, tabs, "all")).toBe("all");
    expect(globalSearchStartTab("routines", ["all", "agents"], "all")).toBe("all");
  });
});

describe("the scope that each open starts with", () => {
  it("is the selected section", () => {
    expect(GLOBAL_SEARCH_START_SCOPE).toBe("section");
  });
});

describe("the count of a paged section", () => {
  it("is the total of the source with no scope", () => {
    expect(globalSearchRemoteCount({ scoped: false, total: 240, hasMore: true })).toEqual({ total: 240, more: false });
    expect(globalSearchRemoteCount({ scoped: false, total: undefined, hasMore: true })).toEqual({
      total: undefined,
      more: true,
    });
  });

  it("does not use the total of the source with a scope, and says more while pages follow", () => {
    expect(globalSearchRemoteCount({ scoped: true, total: 240, hasMore: true })).toEqual({
      total: undefined,
      more: true,
    });
    expect(globalSearchRemoteCount({ scoped: true, total: 240, hasMore: false })).toEqual({
      total: undefined,
      more: false,
    });
  });
});

describe("the next page for a scope", () => {
  const base = { scoped: true, shown: 0, wanted: 1, hasMore: true, failed: false, pages: 1, pageLimit: 5 };

  it("loads while too few results of the section show and pages follow", () => {
    expect(globalSearchNeedsScopedPage(base)).toBe(true);
    expect(globalSearchNeedsScopedPage({ ...base, shown: 3, wanted: 5, pages: 4 })).toBe(true);
  });

  it("stops with enough results, at the end, after a failure, at the page limit, or with no scope", () => {
    expect(globalSearchNeedsScopedPage({ ...base, shown: 1 })).toBe(false);
    expect(globalSearchNeedsScopedPage({ ...base, hasMore: false })).toBe(false);
    expect(globalSearchNeedsScopedPage({ ...base, failed: true })).toBe(false);
    expect(globalSearchNeedsScopedPage({ ...base, pages: 5 })).toBe(false);
    expect(globalSearchNeedsScopedPage({ ...base, scoped: false })).toBe(false);
  });

  it("waits for the first page", () => {
    expect(globalSearchNeedsScopedPage({ ...base, pages: 0 })).toBe(false);
  });
});
