import type { FeedItemState } from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For } from "solid-js";
import { FEED_STATE_LABEL, type FeedCounts } from "./feed-view";

const COUNTERS = [
  { state: "needs-you", count: "needsYou" },
  { state: "stopped", count: "stopped" },
  { state: "working", count: "working" },
] as const satisfies ReadonlyArray<{ state: FeedItemState; count: keyof FeedCounts }>;

export interface FeedJumpBarProps {
  following: boolean;
  /** Cards that came while the timeline was paused. */
  fresh: number;
  counts: FeedCounts;
  /** Shows the next card in this state. */
  onJump: (state: FeedItemState) => void;
}

/** Live or paused, and the counters that go to the next card that needs the person, stopped or works. */
export function FeedJumpBar(props: FeedJumpBarProps) {
  const { t } = useText();
  return (
    <div class="feed-jumpbar">
      <span class="feed-live" data-following={props.following ? "" : undefined}>
        <span class="feed-dot" aria-hidden="true" />
        {props.following ? t("app.feed.live") : t("app.feed.paused")}
        {!props.following && props.fresh > 0 ? ` · ${t("app.feed.newItems", { count: props.fresh })}` : ""}
      </span>
      <For each={COUNTERS} keyed={(counter) => counter.state}>
        {(counter) => {
          const total = () => props.counts[counter().count];
          const label = () => t(FEED_STATE_LABEL[counter().state]);
          return (
            <Button
              variant="unstyled"
              class="feed-counter"
              data-state={counter().state}
              disabled={total() === 0}
              onClick={() => props.onJump(counter().state)}
            >
              <span class="feed-dot" aria-hidden="true" />
              {label()}
              <span class="feed-count">{total()}</span>
              <span class="sr-only">{t("app.feed.jumpNext")}</span>
            </Button>
          );
        }}
      </For>
    </div>
  );
}
