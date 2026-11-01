/**
 * The line of work of one channel tab for an agent (a tab lane). Each tab of a channel has its own
 * agent session, so the requests of one tab start in order and the tabs of one agent run beside each
 * other (docs/architecture/channel-tabs.md). The mailbox, the drain and the turn lifecycle name a tab
 * lane by this key: the channel and the tab.
 *
 * A delivery stored before tabs names no tab. It belongs to the first tab, whose id is
 * `openbot-topic-<channelId>`.
 */
export function channelTabLane(channelId: string, topicId: string | undefined): string {
  return `${channelId}\u0000${topicId ?? `openbot-topic-${channelId}`}`;
}

/** The channel and the tab of a tab lane key. */
export function channelTabOfLane(lane: string): { channelId: string; topicId: string } {
  const separator = lane.indexOf("\u0000");
  return separator < 0
    ? { channelId: lane, topicId: `openbot-topic-${lane}` }
    : { channelId: lane.slice(0, separator), topicId: lane.slice(separator + 1) };
}
