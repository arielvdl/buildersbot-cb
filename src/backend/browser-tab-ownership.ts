/**
 * Which agent call may use a browser tab. One rule for the Builders Bot browser (`BrowserHost`) and for
 * the tabs of the person's Chrome: a tab belongs to the thread that opened it, and, when an agent
 * opened it, to that agent too. A tab of another thread, or of another agent in the same thread, reads
 * to the caller as unknown, so an agent never learns of a tab it cannot use.
 */

/** The owner of a tab. A tab that a person opened for a thread has no agent owner. */
export interface BrowserTabOwner {
  readonly ownerThreadId: string | null;
  readonly ownerAgentId: string | null;
}

/** The agent call that asks for a tab. */
export interface BrowserTabCaller {
  readonly threadId: string;
  readonly ownerAgentId?: string | null;
}

export function canUseBrowserTab(caller: BrowserTabCaller, tab: BrowserTabOwner): boolean {
  return (
    tab.ownerThreadId === caller.threadId &&
    (tab.ownerAgentId === null || tab.ownerAgentId === (caller.ownerAgentId ?? null))
  );
}

/** The error an agent reads for a tab that it cannot use, the same as for a tab that does not exist. */
export function unknownBrowserTabError(tabId: string): Error {
  return new Error(`Unknown browser tab: ${tabId}`);
}
