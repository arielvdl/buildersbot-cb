import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { FeedItem } from "@openbot/contracts/ipc";
import {
  Button,
  Check,
  Input,
  NativeSelect,
  Play,
  Send,
  Spinner,
  Square,
  TriangleAlert,
  UserRoundPlus,
  X,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, For, Show } from "solid-js";
import {
  FEED_FAILURE_LABEL,
  FEED_PENDING_LABEL,
  type FeedCardControl,
  type FeedCardIntent,
  feedCan,
} from "./feed-actions-view";

export interface FeedCardActionsProps {
  /** The card as it shows: while an answer runs, it waits for nothing. */
  item: FeedItem;
  /** The card as main sent it, for what waits on it. */
  source: FeedItem;
  title: string;
  control: FeedCardControl | undefined;
  onIntent: (intent: FeedCardIntent) => void;
}

/** The longest answer typed on a card. A longer answer belongs in the conversation. */
const ANSWER_LIMIT = Math.min(INPUT_LIMITS.promptAnswerText, 2_000);

/**
 * What the person can do on a card, without leaving the feed: approve or deny an approval, answer a
 * simple question, stop a run, resume or reassign a stopped task. A high risk approval, a denial asked
 * with a key and a stop wait for a second, explicit step. While an action runs, the card says so;
 * when main refuses it, the card shows why and is as it was.
 */
export function FeedCardActions(props: FeedCardActionsProps) {
  const { t, sourceText } = useText();
  let confirmButton: HTMLButtonElement | undefined;
  const need = () => props.source.need;
  const can = (action: Parameters<typeof feedCan>[2]) => feedCan(props.source, props.control, action);
  const pending = () => props.control?.pending;
  const confirming = () => props.control?.confirming;
  const form = () => (can("answer") ? need()?.form : undefined);

  // The second step takes the focus, so Enter confirms and Escape cancels.
  createEffect(
    () => confirming(),
    (step) => {
      if (step) queueMicrotask(() => confirmButton?.focus());
    },
  );

  const confirmLabel = () => {
    const step = confirming();
    if (step === "approve") return t("app.feed.confirm.approve");
    if (step === "deny") return t("app.feed.confirm.deny");
    return t("app.feed.confirm.stop");
  };
  const confirmHint = () => {
    const step = confirming();
    if (step === "approve") return t("app.feed.confirm.highRisk");
    if (step === "deny") return t("app.feed.confirm.denyHint");
    return t("app.feed.confirm.stopHint");
  };
  const pendingLabel = () => {
    const action = pending()?.action;
    if (!action) return "";
    return action === "reassign"
      ? t("app.feed.pending.reassign", { name: pending()?.name ?? t("app.feed.unnamedAgent") })
      : t(FEED_PENDING_LABEL[action]);
  };
  const access = () => {
    const value = need()?.access;
    if (!value) return [];
    return [
      ...(value.network ? [t("app.feed.access.network")] : []),
      ...(value.read ? [t("app.feed.access.read", { count: value.read })] : []),
      ...(value.write ? [t("app.feed.access.write", { count: value.write })] : []),
    ];
  };
  const cancelOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    props.onIntent({ type: "cancel" });
  };
  const hasActions = () =>
    can("approve") || can("deny") || can("answer") || can("stop") || can("resume") || can("reassign");

  return (
    <>
      <Show when={props.item.need?.kind === "approval" && (need()?.risk === "high" || access().length > 0)}>
        <div class="feed-card-risk" data-risk={need()?.risk}>
          <Show when={need()?.risk === "high"}>
            <span class="feed-chip feed-chip-risk">
              <TriangleAlert aria-hidden="true" />
              {t("app.feed.risk.high")}
            </span>
          </Show>
          <For each={access()} keyed={false}>
            {(label) => <span class="feed-chip">{label()}</span>}
          </For>
          <Show when={need()?.reason}>{(reason) => <p class="feed-card-reason">{sourceText(reason())}</p>}</Show>
        </div>
      </Show>
      <Show when={form()}>
        {(answer) => (
          <form
            class="feed-card-answer"
            onSubmit={(event) => {
              event.preventDefault();
              props.onIntent({ type: "text" });
            }}
          >
            <Show when={answer().choices.length > 0}>
              <fieldset class="feed-card-choices" aria-label={t("app.feed.action.choices")}>
                <For each={answer().choices} keyed={false}>
                  {(choice, index) => (
                    <Button
                      variant="secondary"
                      size="xs"
                      type="button"
                      class="feed-card-choice"
                      onClick={() => props.onIntent({ type: "choice", index })}
                    >
                      <span class="feed-card-choice-key" aria-hidden="true">
                        {String.fromCharCode(65 + index)}
                      </span>
                      {choice()}
                    </Button>
                  )}
                </For>
              </fieldset>
            </Show>
            <Show when={answer().text}>
              <div class="feed-card-text">
                <Input
                  size="sm"
                  value={props.control?.draft ?? ""}
                  placeholder={t("app.feed.action.answerPlaceholder")}
                  aria-label={t("app.feed.action.answer")}
                  maxlength={ANSWER_LIMIT}
                  onInput={(event) => props.onIntent({ type: "draft", text: event.currentTarget.value })}
                />
                <Button
                  variant="secondary"
                  size="xs"
                  type="submit"
                  class="feed-card-action"
                  disabled={!props.control?.draft?.trim()}
                >
                  <Send aria-hidden="true" />
                  {t("app.feed.action.send")}
                </Button>
              </div>
            </Show>
          </form>
        )}
      </Show>
      <Show when={pending() || confirming() || hasActions()}>
        <fieldset class="feed-card-actions" aria-label={t("app.feed.action.label", { title: props.title })}>
          <Show
            when={!pending()}
            fallback={
              <span class="feed-card-pending">
                <Spinner size="sm" />
                {pendingLabel()}
              </span>
            }
          >
            <Show
              when={!confirming()}
              fallback={
                <div class="feed-card-confirm" data-step={confirming()}>
                  <span class="feed-card-confirm-hint">{confirmHint()}</span>
                  <Button
                    ref={(element: HTMLButtonElement) => {
                      confirmButton = element;
                    }}
                    variant={confirming() === "approve" ? "default" : "destructive"}
                    size="xs"
                    type="button"
                    onKeyDown={cancelOnEscape}
                    onClick={() => props.onIntent({ type: "confirm" })}
                  >
                    {confirmLabel()}
                  </Button>
                  <Button
                    variant="secondary"
                    size="xs"
                    type="button"
                    onKeyDown={cancelOnEscape}
                    onClick={() => props.onIntent({ type: "cancel" })}
                  >
                    {t("app.feed.action.cancel")}
                  </Button>
                </div>
              }
            >
              <Show when={can("approve")}>
                <Button
                  variant="default"
                  size="xs"
                  type="button"
                  class="feed-card-action"
                  aria-keyshortcuts="A"
                  onClick={() => props.onIntent({ type: "approve", via: "pointer" })}
                >
                  <Check aria-hidden="true" />
                  {t("app.feed.action.approve")}
                </Button>
              </Show>
              <Show when={can("deny")}>
                <Button
                  variant="secondary"
                  size="xs"
                  type="button"
                  class="feed-card-action"
                  aria-keyshortcuts="N"
                  onClick={() => props.onIntent({ type: "deny", via: "pointer" })}
                >
                  <X aria-hidden="true" />
                  {t("app.feed.action.deny")}
                </Button>
              </Show>
              <Show when={can("resume")}>
                <Button
                  variant="secondary"
                  size="xs"
                  type="button"
                  class="feed-card-action"
                  aria-keyshortcuts="R"
                  onClick={() => props.onIntent({ type: "resume" })}
                >
                  <Play aria-hidden="true" />
                  {t("app.feed.action.resume")}
                </Button>
              </Show>
              <Show when={can("reassign") && (props.source.reassignTo?.length ?? 0) > 0}>
                <NativeSelect
                  size="sm"
                  class="feed-select feed-card-recipient"
                  aria-label={t("app.feed.action.reassignTo")}
                  value={props.control?.recipient ?? ""}
                  onChange={(event) => props.onIntent({ type: "recipient", agentId: event.currentTarget.value })}
                >
                  <option value="">{t("app.feed.action.chooseAgent")}</option>
                  <For each={props.source.reassignTo ?? []} keyed={(candidate) => candidate.agentId}>
                    {(candidate) => <option value={candidate().agentId}>{candidate().name}</option>}
                  </For>
                </NativeSelect>
                <Button
                  variant="secondary"
                  size="xs"
                  type="button"
                  class="feed-card-action"
                  disabled={!props.control?.recipient}
                  onClick={() => props.onIntent({ type: "reassign" })}
                >
                  <UserRoundPlus aria-hidden="true" />
                  {t("app.feed.action.reassign")}
                </Button>
              </Show>
              <Show when={can("stop")}>
                <Button
                  variant="destructive-ghost"
                  size="xs"
                  type="button"
                  class="feed-card-action feed-card-stop-action"
                  onClick={() => props.onIntent({ type: "stop" })}
                >
                  <Square aria-hidden="true" />
                  {t("app.feed.action.stop")}
                </Button>
              </Show>
            </Show>
          </Show>
        </fieldset>
      </Show>
      <Show when={props.control?.notice}>
        {(notice) => (
          <p class="feed-card-notice">
            <TriangleAlert aria-hidden="true" />
            {t(FEED_FAILURE_LABEL[notice()])}
          </p>
        )}
      </Show>
    </>
  );
}
