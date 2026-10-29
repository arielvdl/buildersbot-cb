import type { ChannelTopic } from "@openbot/contracts/ipc";
import { z } from "zod";

/*
 * The rules of a channel's tab list that need no DOM: how a tab ages, how the list is filtered and
 * sorted, and the tabs the user pinned on this device.
 *
 * The list is the channel title's own menu, and the pins are a preference of this device, like the
 * tab order. A pinned tab is always first, whatever the sort is.
 */

export type ChannelTabSort = "running" | "recent";

/** Channel id → the ids of its pinned tabs, in the order they were pinned. */
export type ChannelTabPins = Record<string, string[]>;

const CHANNEL_TAB_PIN_STORAGE_KEY = "openbot:channel-tab-pins:v1";
/** A device keeps the pins of the channels it pinned last, up to this many. */
const MAX_STORED_CHANNELS = 200;
/** More tabs than this do not fit in a channel. */
const MAX_STORED_TABS = 100;

type ChannelTabPinStorage = Pick<Storage, "getItem" | "setItem">;

const id = z.string().trim().min(1).max(200);
const pinsSchema = z.record(id, z.array(id.nullable().catch(null)).catch([]));

function uniqueIds(ids: readonly (string | null)[]): string[] {
  return [...new Set(ids.flatMap((value) => (value ? [value] : [])))].slice(0, MAX_STORED_TABS);
}

export function readChannelTabPins(storage: ChannelTabPinStorage = window.localStorage): ChannelTabPins {
  try {
    const parsed = pinsSchema.safeParse(JSON.parse(storage.getItem(CHANNEL_TAB_PIN_STORAGE_KEY) ?? "{}"));
    if (!parsed.success) return {};
    return Object.fromEntries(
      Object.entries(parsed.data).flatMap(([channelId, ids]) => {
        const pinned = uniqueIds(ids);
        return pinned.length > 0 ? [[channelId, pinned]] : [];
      }),
    );
  } catch {
    return {};
  }
}

function writeChannelTabPins(pins: ChannelTabPins, storage: ChannelTabPinStorage): ChannelTabPins {
  // The newest pins are the last key, so the oldest ones go first when there are too many.
  const kept = Object.fromEntries(Object.entries(pins).slice(-MAX_STORED_CHANNELS));
  try {
    storage.setItem(CHANNEL_TAB_PIN_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // A UI preference must not block the list when browser storage is unavailable.
  }
  return kept;
}

/** Pins or unpins a tab and returns every pin, the channel's pins in the order they were pinned. */
export function toggleChannelTabPin(
  channelId: string,
  topicId: string,
  storage: ChannelTabPinStorage = window.localStorage,
): ChannelTabPins {
  // The pins are read again first, so a pin made in another window of this device is not undone.
  const pins = readChannelTabPins(storage);
  const current = pins[channelId] ?? [];
  const next = current.includes(topicId) ? current.filter((value) => value !== topicId) : [...current, topicId];
  delete pins[channelId];
  if (next.length > 0) pins[channelId] = next;
  return writeChannelTabPins(pins, storage);
}

export function isChannelTabPinned(pins: readonly string[] | undefined, topicId: string): boolean {
  return pins?.includes(topicId) ?? false;
}

export type ChannelTabAge = { unit: "now" | "minute" | "hour" | "day"; count: number } | { unit: "date"; at: Date };

/**
 * How long ago a tab changed, in the coarsest unit that still says it: seconds read as "now",
 * minutes up to an hour, hours up to a day, days up to a month, and a date beyond that. A time in
 * the future, such as a clock that was set back, reads as now.
 */
export function channelTabAge(value: string, now: number = Date.now()): ChannelTabAge {
  const at = new Date(value);
  const elapsed = now - at.getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return { unit: "now", count: 0 };
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return { unit: "minute", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hour", count: hours };
  const days = Math.floor(hours / 24);
  if (days < 30) return { unit: "day", count: days };
  return { unit: "date", at };
}

/** Case and accent insensitive, so `video` finds `Vídeo`. */
function searchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function time(topic: Pick<ChannelTopic, "updatedAt" | "createdAt">): number {
  const value = Date.parse(topic.updatedAt ?? topic.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function running(topic: Pick<ChannelTopic, "activeTasks">): boolean {
  return (topic.activeTasks ?? 0) > 0;
}

/**
 * The tabs the list shows: those whose name holds `query`, the pinned ones first in the order they
 * were pinned, then the rest in the chosen order. Ties keep the service's order, which is stable.
 */
export function orderChannelTabOverview<
  T extends Pick<ChannelTopic, "id" | "name" | "createdAt" | "updatedAt" | "activeTasks">,
>(topics: readonly T[], pins: readonly string[] | undefined, sort: ChannelTabSort, query = ""): T[] {
  const needle = searchText(query);
  const shown = needle ? topics.filter((topic) => searchText(topic.name).includes(needle)) : [...topics];
  const rank = new Map((pins ?? []).map((topicId, index) => [topicId, index]));
  const bySort = (left: T, right: T): number => {
    if (sort === "running" && running(left) !== running(right)) return running(left) ? -1 : 1;
    return time(right) - time(left);
  };
  const pinned = shown
    .filter((topic) => rank.has(topic.id))
    .sort((left, right) => (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0));
  const rest = shown.filter((topic) => !rank.has(topic.id)).sort(bySort);
  return [...pinned, ...rest];
}
