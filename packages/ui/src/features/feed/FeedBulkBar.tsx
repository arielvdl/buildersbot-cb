import type { FeedCandidate } from "@openbot/contracts/ipc";
import { Button, NativeSelect, Play, UserRoundPlus, X } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For, Show } from "solid-js";

export interface FeedBulkBarProps {
  /** The stopped cards in the selection. */
  selected: number;
  /** The stopped cards that the filters show and that the person can select. */
  selectable: number;
  /** The agents that can take at least one selected task. */
  candidates: readonly FeedCandidate[];
  recipient: string;
  busy: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onResume: () => void;
  onRecipient: (agentId: string) => void;
  onReassign: () => void;
}

/**
 * The actions on many stopped tasks at once: select the stopped cards that show, then resume them or
 * give them to one agent. Main checks each card, as the stopped work page of Settings does, and the
 * cards that it does not do say why.
 */
export function FeedBulkBar(props: FeedBulkBarProps) {
  const { t } = useText();
  return (
    <Show when={props.selected > 0 || props.selectable > 1}>
      <fieldset class="feed-bulk" aria-label={t("app.feed.bulk.label")}>
        <Show
          when={props.selected > 0}
          fallback={
            <Button variant="ghost" size="xs" class="feed-card-action" onClick={() => props.onSelectAll()}>
              {t("app.feed.bulk.selectStopped", { count: props.selectable })}
            </Button>
          }
        >
          <span class="feed-bulk-count">{t("app.feed.bulk.selected", { count: props.selected })}</span>
          <Button
            variant="secondary"
            size="xs"
            class="feed-card-action"
            disabled={props.busy}
            onClick={() => props.onResume()}
          >
            <Play aria-hidden="true" />
            {t("app.feed.bulk.resume")}
          </Button>
          <Show when={props.candidates.length > 0}>
            <NativeSelect
              size="sm"
              class="feed-select"
              aria-label={t("app.feed.action.reassignTo")}
              value={props.recipient}
              disabled={props.busy}
              onChange={(event) => props.onRecipient(event.currentTarget.value)}
            >
              <option value="">{t("app.feed.action.chooseAgent")}</option>
              <For each={props.candidates} keyed={(candidate) => candidate.agentId}>
                {(candidate) => <option value={candidate().agentId}>{candidate().name}</option>}
              </For>
            </NativeSelect>
            <Button
              variant="secondary"
              size="xs"
              class="feed-card-action"
              disabled={props.busy || !props.recipient}
              onClick={() => props.onReassign()}
            >
              <UserRoundPlus aria-hidden="true" />
              {t("app.feed.bulk.reassign")}
            </Button>
          </Show>
          <Button variant="ghost" size="xs" class="feed-card-action" onClick={() => props.onClear()}>
            <X aria-hidden="true" />
            {t("app.feed.bulk.clear")}
          </Button>
        </Show>
      </fieldset>
    </Show>
  );
}
