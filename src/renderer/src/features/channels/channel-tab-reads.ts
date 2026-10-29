import type { ChannelCommand, ChannelPage, ChannelSummary } from "@openbot/contracts/ipc";

/*
 * What is unread in a channel tab, and the read that clears it, with no store and no DOM.
 *
 * Each tab has a read cursor of its own, but the sequence of a message is counted across the whole
 * channel: a tab's newest message can be older than another tab's. The channel's own unread count
 * sums every tab, so it is only the open tab's count on a host without tabs.
 */

/**
 * The unread count of the open tab, for the divider and the "new messages" bar. A host without
 * channel-topics-v1 sends no `topics`, and its one conversation is the whole channel. A tab the list
 * does not name yet, such as one made between the list and the page, has nothing unread.
 */
export function openTabUnreadCount(
  summary: Pick<ChannelSummary, "unreadCount" | "topics"> | undefined,
  topicId: string | null | undefined,
): number {
  if (!summary) return 0;
  if (!summary.topics) return summary.unreadCount;
  return summary.topics.find((topic) => topic.id === topicId)?.unreadCount ?? 0;
}

/**
 * The read of everything on a page, in the page's own tab. A read that names no tab lands in the
 * first one, so a read sent from any other tab moved the wrong cursor, or failed when the page's
 * sequence was past the first tab's newest message. A page of a host without tabs names none.
 */
export function channelReadCommand(
  channelId: string,
  page: Pick<ChannelPage, "topicId" | "throughSequence">,
  operationId: string,
): Extract<ChannelCommand, { type: "read" }> {
  return {
    type: "read",
    channelId,
    ...(page.topicId ? { topicId: page.topicId } : {}),
    throughSequence: page.throughSequence,
    operationId,
  };
}

/**
 * The tabs that Mark all read has to read: each unread tab of each unread channel, since a read
 * moves one tab's cursor. A channel whose list has no tabs, or no count for them, is read in the
 * tab its page opens on, as before tabs.
 */
export function unreadChannelTabs(
  channels: readonly Pick<ChannelSummary, "id" | "unreadCount" | "topics">[],
): { channelId: string; topicId?: string }[] {
  return channels.flatMap((channel) => {
    if (channel.unreadCount <= 0) return [];
    const tabs = (channel.topics ?? []).filter((topic) => (topic.unreadCount ?? 0) > 0);
    return tabs.length > 0
      ? tabs.map((topic) => ({ channelId: channel.id, topicId: topic.id }))
      : [{ channelId: channel.id }];
  });
}

/**
 * How far this client has sent a read in each tab of each channel, so a refresh does not send the
 * same read again.
 *
 * A mark is kept per tab. One mark per channel held the newest sequence read in any tab, and a tab
 * whose newest message was older than that never sent its read: it stayed unread each time it was
 * opened, also when the channel fell back to it after the open tab closed.
 */
export class ChannelReadMarks {
  readonly #marks = new Map<string, number>();

  /** Takes the mark when the page is past it, and says whether its read is due. */
  claim(channelId: string, topicId: string, throughSequence: number): boolean {
    const key = markKey(channelId, topicId);
    if (throughSequence <= (this.#marks.get(key) ?? 0)) return false;
    this.#marks.set(key, throughSequence);
    return true;
  }

  /** Gives a mark back after its read failed, so the next refresh sends it again. */
  release(channelId: string, topicId: string): void {
    this.#marks.delete(markKey(channelId, topicId));
  }

  /** Forgets every tab of a channel that went. */
  forget(channelId: string): void {
    const prefix = markKey(channelId, "");
    for (const key of this.#marks.keys()) if (key.startsWith(prefix)) this.#marks.delete(key);
  }

  clear(): void {
    this.#marks.clear();
  }
}

/** A tab of a host without tabs is `""`, which no tab id is. */
function markKey(channelId: string, topicId: string): string {
  return `${channelId}\u0000${topicId}`;
}
