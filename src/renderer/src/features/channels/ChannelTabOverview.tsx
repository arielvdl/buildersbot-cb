import type { ChannelTopic } from "@openbot/contracts/ipc";
import { Button, Pin, PinOff } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import {
  type ChannelTabSort,
  channelTabAge,
  isChannelTabPinned,
  orderChannelTabOverview,
  readChannelTabPins,
  toggleChannelTabPin,
} from "./channel-tab-overview-model";
import { useChannels } from "./channels-context";

/**
 * The list of a channel's tabs, under its title: every tab with the age of its last change, the
 * running ones first by default, and a search inside the channel. A tab is pinned to stay first,
 * short and marked, so the way back to it is always the same place.
 *
 * The list is a menu of the title, so Escape closes it and the arrow keys walk the cards.
 */
export function ChannelTabOverview(props: { channelId: string; onClose: () => void; restoreFocus: () => void }) {
  const channels = useChannels();
  const { t, format } = useText();
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<ChannelTabSort>("running");
  const [pins, setPins] = createSignal(readChannelTabPins());
  const [, setTick] = createSignal(0);
  let grid: HTMLUListElement | undefined;

  const channel = () => channels.state.channels.find((value) => value.id === props.channelId);
  const topics = () => channel()?.topics ?? [];
  const rows = createMemo(() => orderChannelTabOverview(topics(), pins()[props.channelId], sort(), query()));
  const working = (topic: ChannelTopic) => (topic.activeTasks ?? 0) > 0;

  // The ages are relative, so a list left open counts on.
  onSettled(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  });

  function age(topic: ChannelTopic): string {
    const value = channelTabAge(topic.updatedAt ?? topic.createdAt);
    switch (value.unit) {
      case "now":
        return t("channel.topic.age.now");
      case "minute":
        return t("channel.topic.age.minute", { count: value.count });
      case "hour":
        return t("channel.topic.age.hour", { count: value.count });
      case "day":
        return t("channel.topic.age.day", { count: value.count });
      default:
        return format.date(value.at, { month: "short", day: "numeric" });
    }
  }

  function open(topic: ChannelTopic): void {
    void channels.setTopic(topic.id);
    close();
  }

  function pin(topic: ChannelTopic): void {
    setPins(toggleChannelTabPin(props.channelId, topic.id));
  }

  function close(): void {
    props.onClose();
    props.restoreFocus();
  }

  /** The cards as a menu: Left and Right walk them, Home and End take the ends, Escape leaves. */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    const cards = [...(grid?.querySelectorAll<HTMLElement>(".channel-tab-card") ?? [])];
    if (cards.length === 0) return;
    const index = cards.indexOf(document.activeElement as HTMLElement);
    const target =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? cards[Math.min(cards.length - 1, index + 1)]
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? cards[Math.max(0, index - 1)]
          : event.key === "Home"
            ? cards[0]
            : event.key === "End"
              ? cards[cards.length - 1]
              : undefined;
    if (!target) return;
    event.preventDefault();
    target.focus();
  }

  return (
    <div class="channel-tab-overview no-drag" role="dialog" aria-label={t("channel.topic.list")} onKeyDown={onKeyDown}>
      <div class="channel-tab-overview-bar">
        <input
          class="channel-tab-overview-search"
          type="search"
          value={query()}
          placeholder={t("channel.topic.search")}
          aria-label={t("channel.topic.search")}
          autofocus
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <fieldset class="channel-tab-overview-sort" aria-label={t("channel.topic.sort")}>
          <Button
            variant="ghost"
            size="sm"
            data-active={sort() === "running" ? "" : undefined}
            aria-pressed={sort() === "running" ? "true" : "false"}
            onClick={() => setSort("running")}
          >
            {t("channel.topic.sort.running")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-active={sort() === "recent" ? "" : undefined}
            aria-pressed={sort() === "recent" ? "true" : "false"}
            onClick={() => setSort("recent")}
          >
            {t("channel.topic.sort.recent")}
          </Button>
        </fieldset>
      </div>
      <Show
        when={rows().length > 0}
        fallback={<p class="channel-tab-overview-empty">{t("channel.topic.search.empty")}</p>}
      >
        <ul ref={grid} class="channel-tab-overview-grid" aria-label={t("channel.topic.list")}>
          <For each={rows()}>
            {(topic) => {
              const pinned = () => isChannelTabPinned(pins()[props.channelId], topic.id);
              const active = () => channels.state.topicId === topic.id;
              return (
                <li class="channel-tab-overview-item" data-pinned={pinned() ? "" : undefined}>
                  <button
                    type="button"
                    class="channel-tab-card"
                    data-pinned={pinned() ? "" : undefined}
                    data-active={active() ? "" : undefined}
                    aria-current={active() ? "true" : undefined}
                    onClick={() => open(topic)}
                  >
                    <span class="channel-tab-card-name">{topic.name}</span>
                    <span class="channel-tab-card-meta">
                      <Show when={working(topic)}>
                        <span class="channel-tab-card-working">{t("sidebar.state.working")}</span>
                      </Show>
                      <Show when={!active() && (topic.unreadCount ?? 0) > 0}>
                        <span
                          class="channel-tab-card-unread"
                          role="img"
                          aria-label={t("sidebar.channel.unread", { count: topic.unreadCount ?? 0 })}
                        />
                      </Show>
                      <span class="channel-tab-card-age">{age(topic)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    class="channel-tab-card-pin"
                    data-pinned={pinned() ? "" : undefined}
                    aria-pressed={pinned() ? "true" : "false"}
                    aria-label={pinned() ? t("channel.topic.unpin") : t("channel.topic.pin")}
                    title={pinned() ? t("channel.topic.unpin") : t("channel.topic.pin")}
                    onClick={() => pin(topic)}
                  >
                    <Show when={pinned()} fallback={<Pin size={12} />}>
                      <PinOff size={12} />
                    </Show>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );
}
