import type { ChannelTopic } from "@openbot/contracts/ipc";
import { Button, ConfirmDialog, ErrorReference, IconButton, Info, Input, Tooltip } from "@openbot/ui";
import { ThreadDetailsDialog } from "@openbot/ui/features/conversation/threads/ThreadDetailsDialog";
import { chatPreviewLine, sameMessageText } from "@openbot/ui/features/conversation/threads/thread-preview-text";
import {
  CHAT_PREVIEW_OPEN_DELAY,
  CHAT_PREVIEW_SKIP_DELAY,
  ChatPreviewCard,
  createChatPreviewOpen,
} from "@openbot/ui/features/sidebar/SidebarAgentIndicator";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, For, flush, Show } from "solid-js";
import {
  channelTabClose,
  channelTabDetails,
  channelTabDropIndex,
  channelTabDropSlot,
  channelTabHasDetails,
  moveChannelTopic,
  orderChannelTopics,
  readChannelTabOrders,
  saveChannelTabOrder,
} from "./channel-tabs-model";
import { useChannels } from "./channels-context";

/** The drag data of a tab. A type of its own, so a text field or the file drop never takes it. */
const TAB_DRAG_TYPE = "application/x-openbot-channel-tab";

/**
 * The tabs of an open channel: one conversation each, under the same memory, members and lead.
 *
 * The tabs live beside the transcript rather than in the sidebar, because they belong to the
 * channel that is open. A double click renames one; the cross closes it with its work, and asks
 * first unless the tab is known to be empty and idle. Dragging a tab, or Alt+Shift+Left or Right on
 * a focused tab, moves it; the order is kept on this device only.
 *
 * The strip is a group of buttons (a `fieldset`), not a tablist: it also holds the crosses, the rename field and the
 * add button, and Tab moves through every tab. The open tab has `aria-current`, as the tabs of a chat
 * row in the sidebar do. The buttons and the field are shared controls with their own drawing and no
 * cue, as they had as plain elements.
 */
export function ChannelTabs(props: { channelId: string; archived: boolean }) {
  const channels = useChannels();
  const { t, sourceText } = useText();
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [orders, setOrders] = createSignal(readChannelTabOrders());
  /** The tab that the pointer drags, and the gap it would be dropped in. */
  const [dragged, setDragged] = createSignal<string | null>(null);
  const [slot, setSlot] = createSignal<number | null>(null);
  /**
   * The tab whose close waits for an answer, with the warning it got. It stays after the dialog
   * closes, so the text does not change while the dialog fades out.
   */
  const [closing, setClosing] = createSignal<{ topicId: string; work: boolean } | null>(null);
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [closeError, setCloseError] = createSignal<string | null>(null);
  /** The tab whose details show in a dialog. */
  const [detailsId, setDetailsId] = createSignal<string | null>(null);
  let strip: HTMLFieldSetElement | undefined;

  /** In the service's order, which is the order the tabs were made in. */
  const serviceTopics = () => channels.state.channels.find((channel) => channel.id === props.channelId)?.topics ?? [];
  const topics = createMemo(() => orderChannelTopics(serviceTopics(), orders()[props.channelId]));
  const isOpen = (topic: ChannelTopic) => channels.state.topicId === topic.id;
  const movable = () => !props.archived && topics().length > 1;
  /** A tab that is not open shows its unread count; the open one is being read. */
  const unread = (topic: ChannelTopic) => (isOpen(topic) ? 0 : (topic.unreadCount ?? 0));
  const working = (topic: ChannelTopic) => (topic.activeTasks ?? 0) > 0;
  const openTabButton = () => strip?.querySelector<HTMLElement>('.channel-tab-name[aria-current="true"]') ?? undefined;
  /** A tab that closes elsewhere while its dialog is open takes the dialog with it. */
  const closingTopic = () => serviceTopics().find((topic) => topic.id === closing()?.topicId);

  /** The tab whose details show. Undefined also when it left the channel, such as by a close elsewhere. */
  const detailsTopic = createMemo(() => {
    const topic = serviceTopics().find((item) => item.id === detailsId());
    return topic && channelTabHasDetails(topic) ? topic : undefined;
  });
  const shownDetails = createMemo(() => {
    const topic = detailsTopic();
    return topic ? channelTabDetails(topic) : null;
  });
  // The dialog closes by its `open` prop when its tab goes, and Kobalte then does not call
  // `onOpenChange`. The id goes too, so the previews open again and a later tab does not open it.
  createEffect(
    () => detailsId() !== null && detailsTopic() === undefined,
    (gone) => {
      if (gone) setDetailsId(null);
    },
  );

  async function add(): Promise<void> {
    // The name follows the position, so two new tabs are told apart before either is renamed.
    await channels.createTopic(t("channel.topic.defaultName", { n: topics().length + 1 }));
  }

  /** Puts a tab at `to` and keeps the order on this device. */
  function reorder(topicId: string, to: number): void {
    const ids = topics().map((topic) => topic.id);
    const next = moveChannelTopic(ids, topicId, to);
    if (next.every((value, index) => value === ids[index])) return;
    setOrders(
      saveChannelTabOrder(
        props.channelId,
        next,
        serviceTopics().map((topic) => topic.id),
      ),
    );
  }

  /** The gap under the pointer, from the middle of each tab as it shows now. */
  function slotAt(x: number): number {
    const tabs = [...(strip?.querySelectorAll<HTMLElement>(".channel-tab") ?? [])];
    return channelTabDropSlot(
      tabs.map((tab) => {
        const box = tab.getBoundingClientRect();
        return box.left + box.width / 2;
      }),
      x,
    );
  }

  function endDrag(): void {
    setDragged(null);
    setSlot(null);
  }

  /** Where the dragged tab would land, drawn on the tab beside the gap. A drop that moves nothing has no mark. */
  function dropMark(index: number): "before" | "after" | undefined {
    const gap = slot();
    const from = topics().findIndex((topic) => topic.id === dragged());
    if (gap === null || channelTabDropIndex(from, gap) === null) return undefined;
    if (gap === index) return "before";
    return gap === topics().length && index === topics().length - 1 ? "after" : undefined;
  }

  function close(topic: ChannelTopic): void {
    const kind = channelTabClose(topic);
    if (kind === "now") {
      void closeNow(topic.id);
      return;
    }
    setCloseError(null);
    setClosing({ topicId: topic.id, work: kind === "confirm-work" });
    setConfirmOpen(true);
  }

  /**
   * An empty, idle tab closes without a dialog. A failure shows on the channel, as every failed
   * command does, with its Retry.
   */
  async function closeNow(topicId: string): Promise<void> {
    if (!(await channels.deleteTopic(topicId))) return;
    flush();
    // The cross that had the focus went with its tab.
    if (!document.activeElement || document.activeElement === document.body) openTabButton()?.focus();
  }

  /** The dialog stays open on a failure, with the failure, so the user can try again or cancel. */
  async function confirmClose(): Promise<void> {
    const target = closing();
    if (!target) return;
    setCloseError(null);
    if (await channels.deleteTopic(target.topicId)) {
      flush();
      setConfirmOpen(false);
      return;
    }
    // A command that another one held back sets no error, but it did not close the tab either.
    setCloseError(channels.state.error ?? t("channel.error.update"));
  }

  return (
    <Show when={topics().length > 0}>
      <fieldset
        ref={strip}
        class="channel-tabs"
        aria-label={t("channel.topic.name")}
        onDragStart={(event) => {
          // Only a tab itself; text dragged out of the rename field stays a text drag.
          const tab = event.target instanceof HTMLElement && event.target.matches(".channel-tab") ? event.target : null;
          const topicId = tab?.dataset.topicId;
          if (!topicId || !event.dataTransfer) return;
          event.dataTransfer.setData(TAB_DRAG_TYPE, topicId);
          event.dataTransfer.effectAllowed = "move";
          setDragged(topicId);
        }}
        onDragEnd={endDrag}
        onDragOver={(event) => {
          if (!dragged() || !event.dataTransfer?.types.includes(TAB_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setSlot(slotAt(event.clientX));
        }}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node && event.currentTarget.contains(next))) setSlot(null);
        }}
        onDrop={(event) => {
          const topicId = dragged();
          if (!topicId || !event.dataTransfer?.types.includes(TAB_DRAG_TYPE)) return;
          // The conversation under the header takes a drop as files to attach.
          event.preventDefault();
          event.stopPropagation();
          const to = channelTabDropIndex(
            topics().findIndex((topic) => topic.id === topicId),
            slotAt(event.clientX),
          );
          endDrag();
          if (to !== null) reorder(topicId, to);
        }}
      >
        <For each={topics()}>
          {(topic, index) => {
            // The name is all a tab shows, so the pointer over it previews what a person wrote in the tab
            // first and last, as plain text on few lines. It stays closed while a tab moves or details show.
            const preview = createChatPreviewOpen(() => dragged() !== null || detailsTopic() !== undefined);
            const firstLine = createMemo(() => chatPreviewLine(topic.firstMessage ?? ""));
            const lastLine = createMemo(() => {
              const line = chatPreviewLine(topic.lastUserMessage ?? "");
              return sameMessageText(firstLine(), line) ? "" : line;
            });
            return (
              // `no-drag`: the header moves the window, and a tab in that region gets no drag events.
              <span
                class="channel-tab no-drag"
                data-topic-id={topic.id}
                data-active={isOpen(topic) ? "" : undefined}
                data-dragging={dragged() === topic.id ? "" : undefined}
                data-drop={dropMark(index())}
                draggable={movable() && renaming() !== topic.id ? "true" : "false"}
              >
                {/* Only the open tab has the details button, before its name, as an agent's open thread tab has. */}
                <Show when={isOpen(topic) && renaming() !== topic.id && channelTabHasDetails(topic)}>
                  <IconButton
                    class="channel-tab-details"
                    variant="ghost"
                    size="icon-xs"
                    label={t("conversation.threads.details.open")}
                    onClick={() => setDetailsId(topic.id)}
                  >
                    <Info aria-hidden="true" />
                  </IconButton>
                </Show>
                <Show
                  when={renaming() === topic.id}
                  fallback={
                    <Tooltip.Root
                      open={preview.open()}
                      onOpenChange={preview.onOpenChange}
                      placement="bottom-start"
                      gutter={10}
                      openDelay={CHAT_PREVIEW_OPEN_DELAY}
                      closeDelay={0}
                      skipDelayDuration={CHAT_PREVIEW_SKIP_DELAY}
                      disabled={!channelTabHasDetails(topic)}
                    >
                      <Tooltip.Trigger
                        as={Button}
                        variant="unstyled"
                        data-cuelume-tap={undefined}
                        class="channel-tab-name"
                        aria-current={isOpen(topic) ? "true" : undefined}
                        aria-keyshortcuts={movable() ? "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight" : undefined}
                        onClick={() => void channels.setTopic(topic.id)}
                        onDblClick={() => void setRenaming(topic.id)}
                        onKeyDown={(event: KeyboardEvent) => {
                          // Alt+Left and Alt+Right are Back and Forward outside macOS, so a move takes Shift too,
                          // as on an agent's thread tabs.
                          if (!event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey) return;
                          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                          event.preventDefault();
                          event.stopPropagation();
                          if (!movable()) return;
                          const button = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
                          reorder(topic.id, index() + (event.key === "ArrowLeft" ? -1 : 1));
                          flush();
                          // The element moved in the list, which can drop its focus.
                          if (button && document.activeElement !== button) button.focus();
                        }}
                      >
                        <span class={["channel-tab-label", { "channel-tab-label-working": working(topic) }]}>
                          {topic.name}
                        </span>
                        <Show when={working(topic)}>
                          <span class="sr-only">{t("sidebar.state.working")}</span>
                        </Show>
                        <Show when={unread(topic)}>
                          {(count) => (
                            <span
                              class="channel-tab-unread"
                              role="img"
                              aria-label={t("sidebar.channel.unread", { count: count() })}
                              title={t("sidebar.channel.unread", { count: count() })}
                            />
                          )}
                        </Show>
                      </Tooltip.Trigger>
                      <ChatPreviewCard
                        title={topic.name}
                        firstMessage={firstLine()}
                        preview={lastLine()}
                        variant="tab"
                      />
                    </Tooltip.Root>
                  }
                >
                  <Input
                    class="channel-tab-input"
                    data-cuelume-type={undefined}
                    value={topic.name}
                    aria-label={t("channel.topic.rename")}
                    autofocus
                    onBlur={(event) => {
                      void setRenaming(null);
                      const name = event.currentTarget.value.trim();
                      if (name && name !== topic.name) void channels.renameTopic(topic.id, name);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") void setRenaming(null);
                    }}
                  />
                </Show>
                <Show when={topics().length > 1 && !props.archived}>
                  <Button
                    variant="unstyled"
                    data-cuelume-tap={undefined}
                    class="channel-tab-close"
                    aria-label={`${t("channel.topic.delete")}: ${topic.name}`}
                    onClick={() => close(topic)}
                  >
                    ×
                  </Button>
                </Show>
              </span>
            );
          }}
        </For>
        <Show when={!props.archived}>
          <Button variant="ghost" size="sm" class="channel-tab-add" aria-label={t("channel.topic.new")} onClick={add}>
            +
          </Button>
        </Show>
      </fieldset>
      <ThreadDetailsDialog details={shownDetails()} onClose={() => setDetailsId(null)} returnFocus={openTabButton} />
      <ConfirmDialog
        open={confirmOpen() && closingTopic() !== undefined}
        initialFocus="cancel"
        title={closing()?.work ? t("channel.topic.closeBusyTitle") : t("channel.topic.closeTitle")}
        description={closing()?.work ? t("channel.topic.closeBusyDescription") : t("channel.topic.closeDescription")}
        confirmLabel={t("channel.topic.delete")}
        error={
          closeError() ? (
            <>
              {sourceText(closeError() ?? "")}
              <ErrorReference reference={channels.state.errorReference} />
            </>
          ) : undefined
        }
        // A closed tab takes its cross with it, so the focus goes to the tab that is open now.
        restoreFocusTarget={closingTopic() ? undefined : openTabButton()}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={confirmClose}
      />
    </Show>
  );
}

/** The tabs of a channel, for a caller that only has its id. */
export function ChannelTabsFor(props: { channelId: string }) {
  const channels = useChannels();
  const archived = () => channels.state.channels.find((channel) => channel.id === props.channelId)?.archived ?? false;
  return <ChannelTabs channelId={props.channelId} archived={archived()} />;
}

export type { ChannelTopic };
