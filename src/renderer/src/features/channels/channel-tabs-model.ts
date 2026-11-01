import type { ChannelTopic } from "@openbot/contracts/ipc";
import type { ThreadDetails } from "@openbot/ui/features/conversation/threads/ThreadDetailsDialog";
import { chatPreviewBlock } from "@openbot/ui/features/conversation/threads/thread-preview-text";
import { z } from "zod";

/*
 * The rules of a channel's tab bar that need no DOM: the order the user gave the tabs on this
 * device, and whether closing a tab asks first.
 *
 * The order is a preference of this device only. The service keeps the tabs in the order they were
 * made, and a routine still lands in the oldest tab whatever the order on screen is.
 */

/** Channel id → the ids of its tabs, in the order the user put them. */
export type ChannelTabOrders = Record<string, string[]>;

const CHANNEL_TAB_ORDER_STORAGE_KEY = "openbot:channel-tab-order:v1";
/** A device keeps the order of the channels it reordered last, up to this many. */
const MAX_STORED_CHANNELS = 200;
/** More tabs than this do not fit in a header. */
const MAX_STORED_TABS = 100;

type ChannelTabOrderStorage = Pick<Storage, "getItem" | "setItem">;

const id = z.string().trim().min(1).max(200);
const ordersSchema = z.record(id, z.array(id.nullable().catch(null)).catch([]));
const lastTopicsSchema = z.record(id, id);

function uniqueIds(ids: readonly (string | null)[]): string[] {
  return [...new Set(ids.flatMap((value) => (value ? [value] : [])))].slice(0, MAX_STORED_TABS);
}

export function readChannelTabOrders(storage: ChannelTabOrderStorage = window.localStorage): ChannelTabOrders {
  try {
    const parsed = ordersSchema.safeParse(JSON.parse(storage.getItem(CHANNEL_TAB_ORDER_STORAGE_KEY) ?? "{}"));
    if (!parsed.success) return {};
    return Object.fromEntries(
      Object.entries(parsed.data).flatMap(([channelId, ids]) => {
        const order = uniqueIds(ids);
        return order.length > 0 ? [[channelId, order]] : [];
      }),
    );
  } catch {
    return {};
  }
}

/**
 * Keeps `order` for a channel and returns every stored order. The stored order is read again first,
 * so a reorder in another window of this device is not undone. An order that is the service's own
 * order is not kept, so a channel nobody reordered takes no room.
 */
export function saveChannelTabOrder(
  channelId: string,
  order: readonly string[],
  serviceOrder: readonly string[],
  storage: ChannelTabOrderStorage = window.localStorage,
): ChannelTabOrders {
  const next = readChannelTabOrders(storage);
  delete next[channelId];
  const ids = uniqueIds(order);
  if (ids.length > 0 && ids.some((value, index) => value !== serviceOrder[index])) next[channelId] = ids;
  // The newest order is the last key, so the oldest ones go first when there are too many.
  const kept = Object.fromEntries(Object.entries(next).slice(-MAX_STORED_CHANNELS));
  try {
    storage.setItem(CHANNEL_TAB_ORDER_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // A UI preference must not block the tabs when browser storage is unavailable.
  }
  return kept;
}

/**
 * The tab that was open last in each channel, so opening the channel from the list goes back to it
 * instead of the first tab. The tab stays marked in the list, and a tab that is gone falls back.
 */
export type ChannelLastTopics = Record<string, string>;

const CHANNEL_LAST_TOPIC_STORAGE_KEY = "openbot:channel-last-tab:v1";

export function readChannelLastTopics(storage: ChannelTabOrderStorage = window.localStorage): ChannelLastTopics {
  try {
    const parsed = lastTopicsSchema.safeParse(JSON.parse(storage.getItem(CHANNEL_LAST_TOPIC_STORAGE_KEY) ?? "{}"));
    if (!parsed.success) return {};
    return Object.fromEntries(Object.entries(parsed.data));
  } catch {
    return {};
  }
}

/** Keeps the last open tab of a channel and returns every stored choice. */
export function saveChannelLastTopic(
  channelId: string,
  topicId: string,
  storage: ChannelTabOrderStorage = window.localStorage,
): ChannelLastTopics {
  const next = readChannelLastTopics(storage);
  delete next[channelId];
  next[channelId] = topicId;
  const kept = Object.fromEntries(Object.entries(next).slice(-MAX_STORED_CHANNELS));
  try {
    storage.setItem(CHANNEL_LAST_TOPIC_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // A UI preference must not block the tabs when browser storage is unavailable.
  }
  return kept;
}

/**
 * The tabs in the saved order. A tab the order does not name, such as one just made, goes last in
 * the service's order; an id whose tab is gone is skipped.
 */
export function orderChannelTopics<T extends Pick<ChannelTopic, "id">>(
  topics: readonly T[],
  saved: readonly string[] | undefined,
): T[] {
  if (!saved?.length) return [...topics];
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const placed = saved.flatMap((topicId) => {
    const topic = byId.get(topicId);
    if (!topic) return [];
    byId.delete(topicId);
    return [topic];
  });
  return [...placed, ...topics.filter((topic) => byId.has(topic.id))];
}

/** The ids with `topicId` at index `to`, counted after it leaves its place. Out of range stays at the end. */
export function moveChannelTopic(ids: readonly string[], topicId: string, to: number): string[] {
  const from = ids.indexOf(topicId);
  if (from < 0) return [...ids];
  const rest = ids.filter((value) => value !== topicId);
  const index = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, index), topicId, ...rest.slice(index)];
}

/**
 * The gap a dragged tab is dropped in, from the horizontal middle of each tab: 0 is before the
 * first tab, `midpoints.length` after the last.
 */
export function channelTabDropSlot(midpoints: readonly number[], x: number): number {
  const slot = midpoints.findIndex((middle) => x < middle);
  return slot < 0 ? midpoints.length : slot;
}

/** The index a tab at `from` lands at when it is dropped in `slot`, or null when it stays in place. */
export function channelTabDropIndex(from: number, slot: number): number | null {
  if (from < 0 || slot === from || slot === from + 1) return null;
  return slot > from ? slot - 1 : slot;
}

/**
 * Whether closing a tab asks first. Closing deletes the tab's conversation and stops its running
 * turns, so only a tab known to be empty and idle closes at once. A count the service did not send
 * is unknown, and an unknown tab asks.
 */
export type ChannelTabClose = "now" | "confirm" | "confirm-work";

export function channelTabClose(topic: Pick<ChannelTopic, "openTasks" | "messageCount">): ChannelTabClose {
  if ((topic.openTasks ?? 0) > 0) return "confirm-work";
  return topic.messageCount === 0 && topic.openTasks === 0 ? "now" : "confirm";
}

/**
 * A tab with a message of a person to show: its hover preview and the details button of the open tab
 * need one. A new tab, and a tab of a host older than the preview, have none.
 */
export function channelTabHasDetails(topic: ChannelTopic): boolean {
  return (topic.firstMessage ?? "").trim() !== "" || (topic.lastUserMessage ?? "").trim() !== "";
}

/** The details of a tab for its dialog: the person's first and last message, as text that keeps its lines. */
export function channelTabDetails(topic: ChannelTopic): ThreadDetails {
  return {
    title: topic.name,
    startedAt: topic.createdAt,
    firstMessage: chatPreviewBlock(topic.firstMessage ?? ""),
    lastMessage: chatPreviewBlock(topic.lastUserMessage ?? ""),
  };
}
