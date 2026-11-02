import type { FeedDesktopApi } from "@openbot/contracts/ipc";

/** The bridge calls of the feed page. */
export type FeedPort = FeedDesktopApi;

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function feedPort(): FeedPort {
  return window.openbot.feed;
}
