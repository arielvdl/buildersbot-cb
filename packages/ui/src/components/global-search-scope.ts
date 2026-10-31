/**
 * The scope of the global search, as data. While the sidebar selects a section, the search can keep
 * only the results of the agents and channels in that section. The message and file searches answer
 * in pages for every agent, so the scope filters each page in the client: the total that the source
 * counts is then not the number of results that show.
 */

/** "section" keeps the results of the selected section; "all" keeps every result. */
export type GlobalSearchScope = "section" | "all";

/** The scope that each open starts with. */
export const GLOBAL_SEARCH_START_SCOPE: GlobalSearchScope = "section";

/** The tab that shows when the search opens: the wanted tab while it is visible, otherwise the fallback. */
export function globalSearchStartTab<T extends string>(wanted: T | undefined, visible: readonly T[], fallback: T): T {
  return wanted !== undefined && visible.includes(wanted) ? wanted : fallback;
}

/**
 * The count that the header of a paged section shows. With no scope, it is the total of the source,
 * and "more" only when the source does not count. With a scope, the total of the source also counts
 * results of other sections, so the header counts the results that show, and says "more" while
 * pages follow.
 */
export function globalSearchRemoteCount(input: { scoped: boolean; total: number | undefined; hasMore: boolean }): {
  total: number | undefined;
  more: boolean;
} {
  if (input.scoped) return { total: undefined, more: input.hasMore };
  return { total: input.total, more: input.hasMore && input.total === undefined };
}

export interface GlobalSearchScopedPageInput {
  scoped: boolean;
  /** The results of the source that the scope keeps. */
  shown: number;
  /** How many results the list needs before it stops loading pages for the scope. */
  wanted: number;
  hasMore: boolean;
  failed: boolean;
  /** The pages loaded since the first one, the first one included. */
  pages: number;
  /** The most pages to load for the scope. The list loads more as the user scrolls. */
  pageLimit: number;
}

/**
 * Whether the scope needs the next page now. A page can bring no result of the section, and an empty
 * list cannot scroll to its end to load more, so the search loads pages until enough results show.
 */
export function globalSearchNeedsScopedPage(input: GlobalSearchScopedPageInput): boolean {
  return (
    input.scoped &&
    input.hasMore &&
    !input.failed &&
    input.pages > 0 &&
    input.pages < input.pageLimit &&
    input.shown < input.wanted
  );
}
