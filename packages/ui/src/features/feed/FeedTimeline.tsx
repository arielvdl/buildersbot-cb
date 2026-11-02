import type { FeedItem } from "@openbot/contracts/ipc";
import { ArrowDown, Button } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { calculateChatScrollMargin, createChatVirtualizer } from "../conversation/createChatVirtualizer";
import { preferredMessageScrollBehavior } from "../conversation/MessageNavigation";
import { type FeedAvatar, FeedItemCard } from "./FeedItemCard";
import type { FeedCardControl, FeedCardIntent } from "./feed-actions-view";
import type { FeedRow } from "./feed-view";

/** Within this distance of the end, the reader follows the newest card. */
const FOLLOW_DISTANCE = 80;
/**
 * The height of a row, from the stylesheet: a card has one line for each part, so the estimate is the
 * height. A good estimate keeps the virtualizer from moving the reader when it measures a row.
 */
const ROW_SIZE: Readonly<Record<"card" | "line" | "block" | "group", number>> = {
  card: 136,
  line: 24,
  block: 42,
  group: 36,
};

function estimateRow(row: FeedRow | undefined): number {
  if (!row) return ROW_SIZE.card;
  if (row.kind === "group") return ROW_SIZE.group;
  const item = row.item;
  let size = ROW_SIZE.card;
  if (!item.lastStep && item.state !== "waiting") size -= ROW_SIZE.line;
  if (item.need || item.stop) size += ROW_SIZE.block;
  if (item.quiet) size += ROW_SIZE.line;
  // The row of buttons, and the choices and the field of a question.
  if (item.actions.length > 1) size += ROW_SIZE.block;
  if (item.need?.form) size += ROW_SIZE.block;
  if (item.need?.risk || item.need?.access) size += ROW_SIZE.block;
  return size;
}

/** What the page asks of the timeline: show one card, and go back to the newest. */
export interface FeedTimelineControl {
  /** Scrolls to a row and gives its card the focus. The timeline pauses there. */
  reveal: (index: number) => void;
  followNewest: () => void;
  /** Gives the focus back to a card, when it is on screen. */
  focusCard: (id: string) => void;
}

export interface FeedTimelineProps {
  rows: readonly FeedRow[];
  /** The number of cards in `rows`, for `aria-setsize`. */
  cardCount: number;
  avatar: (item: FeedItem) => FeedAvatar;
  loading: boolean;
  /** Shown when no row shows. */
  empty: string;
  expanded: ReadonlySet<string>;
  onToggleSteps: (id: string) => void;
  onOpen: (item: FeedItem) => void;
  /** Whether the reader follows the newest card, or read back and paused the timeline. */
  onFollowChange: (following: boolean) => void;
  /** The cards that came while the timeline was paused. */
  onFreshChange: (count: number) => void;
  control: (control: FeedTimelineControl) => void;
  /** What the person does on each card now. */
  controlOf?: ((item: FeedItem) => FeedCardControl | undefined) | undefined;
  /** The stopped cards in the selection. */
  selected?: ReadonlySet<string> | undefined;
  /** The actions on the cards. Absent: the cards are read only. */
  onIntent?: ((item: FeedItem, intent: FeedCardIntent) => void) | undefined;
  /** A key of a focused card that is not a move: A, N or R. Answers whether the page took it. */
  onShortcut?: ((item: FeedItem, key: "a" | "n" | "r") => boolean) | undefined;
}

/**
 * The single timeline of the feed, the newest card at the bottom, as in a conversation. It uses the
 * conversation's virtualizer, which keeps the reader at the end while new cards come and stays in
 * place when the reader scrolled up: only the cards on screen are in the DOM. Scrolling up pauses it,
 * and the cards that come meanwhile are counted, not shown under the reader.
 */
export function FeedTimeline(props: FeedTimelineProps) {
  const { t } = useText();
  const [margin, setMargin] = createSignal(0);
  const [following, setFollowing] = createSignal(true);
  const [fresh, setFresh] = createSignal(0);
  let scroller: HTMLDivElement | undefined;
  let virtualRoot: HTMLDivElement | undefined;
  /** The card ids the reader had seen when the timeline paused. */
  let seen: Set<string> | null = null;
  let follow = true;

  const virtualizer = createChatVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: () => props.rows.length,
    getScrollElement: () => scroller ?? null,
    estimateSize: (index) => estimateRow(props.rows[index]),
    getItemKey: (index) => props.rows[index]?.key ?? index,
    keyVersion: () => `${props.rows.length}:${props.rows[0]?.key ?? ""}:${props.rows.at(-1)?.key ?? ""}`,
    scrollMargin: margin,
    stickToLatest: () => follow,
  });
  const virtualRows = createMemo(() => virtualizer.getVirtualItems());
  /** The place of each card among the cards, from 1, for `aria-posinset`. */
  const positions = createMemo(() => {
    const map = new Map<string, number>();
    let position = 0;
    for (const row of props.rows) {
      if (row.kind !== "item") continue;
      position += 1;
      map.set(row.key, position);
    }
    return map;
  });

  const setFollow = (next: boolean) => {
    if (follow === next) return;
    follow = next;
    setFollowing(next);
    untrack(() => props.onFollowChange(next));
    if (next) {
      seen = null;
      setFresh(0);
      untrack(() => props.onFreshChange(0));
    } else seen = new Set(untrack(() => props.rows).map((row) => row.key));
  };

  const atEnd = (element: HTMLElement) =>
    element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_DISTANCE;

  createEffect(
    () => props.rows,
    (rows) => {
      if (!follow && seen) {
        const known = seen;
        const count = rows.reduce((total, row) => (row.kind === "item" && !known.has(row.key) ? total + 1 : total), 0);
        setFresh(count);
        props.onFreshChange(count);
      }
      requestAnimationFrame(() => {
        if (!scroller) return;
        setMargin(calculateChatScrollMargin(scroller, virtualRoot));
        if (follow) scroller.scrollTop = scroller.scrollHeight;
      });
    },
  );

  onSettled(() => {
    const observer = new ResizeObserver(() => setMargin(calculateChatScrollMargin(scroller, virtualRoot)));
    if (scroller) observer.observe(scroller);
    return () => observer.disconnect();
  });

  let revealFrame = 0;
  onCleanup(() => cancelAnimationFrame(revealFrame));

  /** Gives the focus to a card once the virtualizer has rendered it. */
  const focusRow = (index: number, tries = 6) => {
    cancelAnimationFrame(revealFrame);
    revealFrame = requestAnimationFrame(() => {
      const key = props.rows[index]?.key;
      const card = key ? scroller?.querySelector<HTMLElement>(`[data-feed-id="${CSS.escape(key)}"]`) : null;
      if (card) card.focus({ preventScroll: true });
      else if (tries > 0) focusRow(index, tries - 1);
    });
  };

  const reveal = (index: number) => {
    if (index < 0) return;
    setFollow(false);
    virtualizer.scrollToIndex(index);
    focusRow(index);
  };

  const followNewest = () => {
    setFollow(true);
    if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: preferredMessageScrollBehavior() });
  };

  const focusCard = (id: string) => {
    const card = scroller?.querySelector<HTMLElement>(`[data-feed-id="${CSS.escape(id)}"]`);
    card?.focus({ preventScroll: true });
  };

  props.control({ reveal, followNewest, focusCard });

  /**
   * On a focused card: the arrow keys, J and K, Page Up and Page Down, Home and End move between the
   * cards; A, N and R go to the page. A key in a field or a button of the card is not a shortcut.
   */
  const onCardKey = (event: KeyboardEvent, index: number) => {
    if (event.target !== event.currentTarget) return;
    // A letter with a modifier belongs to the app or the system.
    const letter =
      event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey ? event.key.toLowerCase() : null;
    if (letter === "a" || letter === "n" || letter === "r") {
      const row = props.rows[index];
      if (row?.kind === "item" && props.onShortcut?.(row.item, letter)) event.preventDefault();
      return;
    }
    const cards = props.rows
      .map((row, rowIndex) => (row.kind === "item" ? rowIndex : -1))
      .filter((value) => value >= 0);
    const at = cards.indexOf(index);
    let next: number | undefined;
    const key = event.key;
    if (key === "ArrowDown" || key === "PageDown" || letter === "j") next = cards[at + 1];
    else if (key === "ArrowUp" || key === "PageUp" || letter === "k") next = cards[at - 1];
    else if (event.key === "Home") next = cards[0];
    else if (event.key === "End") next = cards.at(-1);
    if (next === undefined) return;
    event.preventDefault();
    reveal(next);
    if (next === cards.at(-1)) setFollow(true);
  };

  return (
    <div class="feed-timeline-frame">
      <div
        ref={scroller}
        class="feed-timeline"
        role="feed"
        aria-label={t("app.feed.timeline")}
        aria-busy={props.loading ? "true" : "false"}
        onScroll={(event) => setFollow(atEnd(event.currentTarget))}
      >
        <Show
          when={props.rows.length > 0}
          fallback={
            <p class="feed-timeline-empty" role="status">
              {props.loading ? t("app.feed.loading") : props.empty}
            </p>
          }
        >
          <div
            ref={virtualRoot}
            class={["feed-virtual-list", { "feed-virtual-list-static": !virtualizer.isVirtualized() }]}
            style={{ height: virtualizer.isVirtualized() ? `${virtualizer.getTotalSize()}px` : "auto" }}
          >
            <For each={virtualRows()}>
              {(virtualRow) => {
                const row = () => props.rows[virtualRow.index];
                const group = createMemo(() => {
                  const current = row();
                  return current?.kind === "group" ? current : null;
                });
                const card = createMemo(() => {
                  const current = row();
                  return current?.kind === "item" ? current.item : null;
                });
                return (
                  <div
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    class="feed-virtual-row"
                    style={{
                      transform: virtualizer.isVirtualized()
                        ? `translateY(${virtualRow.start - virtualizer.scrollMargin()}px)`
                        : "none",
                    }}
                  >
                    {/* A heading is not a child that an ARIA feed allows, and each card names its project and agent. */}
                    <Show when={group()}>
                      {(head) => (
                        <div class="feed-group-head" aria-hidden="true">
                          <span>
                            {head().label ??
                              t(head().group === "project" ? "app.feed.filter.noProject" : "app.feed.unnamedAgent")}
                          </span>
                          <span class="feed-count">{head().count}</span>
                        </div>
                      )}
                    </Show>
                    <Show when={card()}>
                      {(item) => (
                        <FeedItemCard
                          item={item()}
                          avatar={props.avatar(item())}
                          position={positions().get(item().id) ?? 1}
                          total={props.cardCount}
                          expanded={props.expanded.has(item().id)}
                          onToggleSteps={() => props.onToggleSteps(item().id)}
                          onOpen={() => props.onOpen(item())}
                          onKeyDown={(event) => onCardKey(event, virtualRow.index)}
                          control={props.controlOf?.(item())}
                          selected={props.selected?.has(item().id) ?? false}
                          onIntent={
                            props.onIntent ? (intent: FeedCardIntent) => props.onIntent?.(item(), intent) : undefined
                          }
                        />
                      )}
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
      <Show when={!following() && props.rows.length > 0}>
        <div class="feed-newest">
          <Button
            variant="secondary"
            size="sm"
            class="feed-newest-button"
            aria-label={t("app.feed.jumpToNewest", { count: fresh() })}
            onClick={followNewest}
          >
            <ArrowDown aria-hidden="true" />
            <Show when={fresh() > 0}>
              <span>{t("app.feed.newItems", { count: fresh() })}</span>
            </Show>
          </Button>
        </div>
      </Show>
    </div>
  );
}
