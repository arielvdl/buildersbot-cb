import type {
  AgentApproval,
  AgentTask,
  AgentTaskHold,
  AttachmentSummary,
  DraftAttachment,
  InstalledSkill,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { isAgentTaskActive } from "@openbot/team-client/agent-tasks";
import { ArrowUp, Button, Image, Square } from "@openbot/ui";
import { createScrollFades } from "@openbot/ui/components/createScrollFades";
import type { AgentMessage, AgentProfile, ComposerMcpServer } from "@openbot/ui/data";
import { AgentActivityIndicator, nextAgentActivityLabel } from "@openbot/ui/features/conversation/AgentActivity";
import { type ChatMessageAuthor, ChatMessageRow } from "@openbot/ui/features/conversation/ChatMessageRow";
import {
  ComposerEditor,
  type ComposerPasteResult,
  type ComposerSelection,
} from "@openbot/ui/features/conversation/ComposerEditor";
import { ComposerNotice } from "@openbot/ui/features/conversation/ComposerNotice";
import { ContextUsageMeter, type ContextUsageView } from "@openbot/ui/features/conversation/ContextUsage";
import { ApprovalCard } from "@openbot/ui/features/conversation/ConversationPrompts";
import { type TextValue, useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { children, createSignal, For, onSettled, Show } from "solid-js";

const HOLD_TEXT = {
  "agent-restarting": "conversation.threads.hold.agentRestarting",
  "usage-limit": "conversation.threads.hold.usageLimit",
  "server-busy": "conversation.threads.hold.serverBusy",
  "agent-busy": "conversation.threads.hold.agentBusy",
  "one-turn": "conversation.threads.hold.oneTurn",
} as const satisfies Record<Exclude<AgentTaskHold, "task-limit">, AppTextKey>;

/** The list stays at its end while new text comes in, when the user has not scrolled up. */
const STICK_DISTANCE = 48;

/**
 * Whether the thread shows this message. A stopped turn can leave an agent message with no text and
 * nothing else in it; the thinking of a turn shows only while the thread runs, in its activity row.
 */
function shownInThread(message: AgentMessage): boolean {
  if (message.kind === "thinking" || message.kind === "memory-changes") return false;
  return (
    message.author === "you" ||
    message.streaming === true ||
    message.body.trim().length > 0 ||
    (message.attachments?.length ?? 0) > 0 ||
    message.imageGeneration !== undefined ||
    message.questionPrompt !== undefined ||
    message.plan !== undefined ||
    message.actionMarker !== undefined
  );
}

/** Why the next message of a queued thread waits. */
export function agentThreadHoldText(task: AgentTask, limit: number, t: TextValue["t"]): string | null {
  if (task.state !== "queued") return null;
  if (task.hold === "task-limit" || task.hold === null)
    return t("conversation.threads.hold.threadLimit", { count: limit });
  return t(HOLD_TEXT[task.hold]);
}

export interface AgentThreadViewProps {
  /** Null for a new thread: its first message starts it. */
  task: AgentTask | null;
  /** How many threads of the agent can run at the same time. */
  limit: number;
  agent: AgentProfile;
  agents: AgentProfile[];
  messages: readonly AgentMessage[];
  /** The agent's skills, for the `$` picker and the skill tags in messages. */
  skills?: InstalledSkill[] | undefined;
  /** The last skill list request failed, so an empty picker says so instead of "no skills". */
  skillsLoadFailed?: boolean | undefined;
  /** The host's MCP servers, offered by the same `$` the skills answer. */
  mcpServers?: ComposerMcpServer[] | undefined;
  /** The unsent text of this thread's message box. The host keeps it for each thread. */
  draft: string;
  /** The files that the draft names. */
  draftAttachments?: DraftAttachment[] | undefined;
  onDraftChange: (text: string) => void;
  /** Receives pasted files. Without it, a file paste does nothing here. */
  onPasteFiles?:
    | ((files: File[], selection: ComposerSelection) => undefined | Promise<ComposerPasteResult | undefined>)
    | undefined;
  onOpenDraftAttachment?: ((attachment: DraftAttachment) => void) | undefined;
  /** Opens the file picker. Without it, the message box has no attach button. */
  onAttachFiles?: (() => void) | undefined;
  /** Sends a message. The host clears the text when the message went; when it did not, the text stays. */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onOpenLink: (url: string) => void;
  onPreview: (attachment: AttachmentSummary) => void;
  onAttachmentAction: (attachment: AttachmentSummary, action: "open" | "reveal" | "download") => void;
  /** The window draws the macOS window controls over the top start corner. The image viewer leaves room. */
  macWindowControls?: boolean | undefined;
  /** The approval that the thread's running turn waits for. */
  approval?: AgentApproval | undefined;
  onRespondApproval: (decision: "accept" | "decline") => Promise<boolean>;
  /** How full the thread's context is, when its provider reported it. */
  context?: ContextUsageView | undefined;
  /** Compacts the thread's context now. Missing when the host cannot. */
  onCompactContext?: (() => Promise<void>) | undefined;
  /** Whether the thread's running turn waits for the person: a question or a browser takeover. */
  waitsForAnswer?: boolean | undefined;
  /** Another card that the thread shows, such as a question or a browser takeover. The app builds it. */
  attention?: JSX.Element | undefined;
}

/**
 * A side thread of an agent, in the place of its chat: the messages, why the thread waits, and a
 * message box. While a turn runs, a message waits in the thread, or steers the turn as the
 * busy-message mode says.
 */
export function AgentThreadView(props: AgentThreadViewProps) {
  const { t } = useText();
  // Resolved once, so the card is built one time for the check and the row.
  const attention = children(() => props.attention);
  const [sending, setSending] = createSignal(false);
  let scroller: HTMLElement | undefined;
  const activityLabel = nextAgentActivityLabel();
  const fades = createScrollFades();
  onSettled(() => {
    const element = scroller;
    const list = element?.firstElementChild;
    if (!element || !list) return fades.stop;
    let atEnd = true;
    const onScroll = () => {
      atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_DISTANCE;
    };
    const follow = new ResizeObserver(() => {
      if (atEnd) element.scrollTop = element.scrollHeight;
    });
    follow.observe(list);
    element.scrollTop = element.scrollHeight;
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      follow.disconnect();
      element.removeEventListener("scroll", onScroll);
      fades.stop();
    };
  });
  const active = () => (props.task ? isAgentTaskActive(props.task) : false);
  const title = () => props.task?.title ?? t("conversation.threads.new");
  const placeholder = () =>
    props.task
      ? t("conversation.threads.view.placeholder", { name: props.agent.name, title: props.task.title })
      : t("conversation.threads.view.newPlaceholder", { name: props.agent.name });
  const send = async () => {
    const text = props.draft.trim();
    if (!text || sending()) return;
    setSending(true);
    try {
      await props.onSend(text);
    } finally {
      setSending(false);
    }
  };
  // An answer from another agent to a request of this thread shows with the name of that agent.
  const author = (message: AgentMessage): ChatMessageAuthor => {
    if (message.author === "you") return { kind: "you", name: t("chat.message.you") };
    const senderId = message.senderAgentId;
    if (senderId === undefined || senderId === props.agent.id)
      return { kind: "agent", name: props.agent.name, agent: props.agent };
    const sender = props.agents.find((candidate) => candidate.id === senderId);
    return {
      kind: "agent",
      name: sender?.name ?? t("chat.message.agentFallback"),
      agent: sender,
      avatarSeed: senderId,
    };
  };
  const failed = () => (props.task?.state === "idle" && props.task.outcome === "failed" ? props.task : undefined);
  const running = () =>
    props.task?.state === "running" && !props.approval && !props.waitsForAnswer ? props.task : undefined;
  const queued = () => (props.task && props.task.queuedMessages.length > 0 ? props.task : undefined);
  const hold = () => (props.task ? agentThreadHoldText(props.task, props.limit, t) : null);
  return (
    <>
      <section
        ref={(element: HTMLElement) => {
          scroller = element;
          fades.bind(element);
        }}
        class={["conversation-scroll agent-thread-scroll", fades.classes()]}
        aria-label={t("conversation.threads.view.label", { title: title() })}
        onScroll={fades.measure}
      >
        <div class="virtual-chat-list virtual-chat-list-static" ref={fades.watch}>
          <Show when={props.task?.origin === "agent"}>
            <p class="agent-thread-origin">
              {t("conversation.threads.view.startedByAgent", { name: props.agent.name })}
            </p>
          </Show>
          <For each={props.messages.filter(shownInThread)} keyed={(message) => message.id}>
            {(message) => (
              <div class="virtual-chat-row">
                <ChatMessageRow
                  message={message()}
                  author={author(message())}
                  agents={props.agents}
                  skills={props.skills}
                  onSelectAgent={() => undefined}
                  onOpenLink={props.onOpenLink}
                  onPreview={props.onPreview}
                  onAttachmentAction={props.onAttachmentAction}
                  onDownload={(attachment) => props.onAttachmentAction(attachment, "download")}
                  macWindowControls={props.macWindowControls}
                />
              </div>
            )}
          </For>
          <Show when={running()}>
            {(task) => (
              <div class="virtual-chat-row">
                <AgentActivityIndicator agent={props.agent} label={activityLabel} detail={task().progress} />
              </div>
            )}
          </Show>
          <Show keyed when={props.approval}>
            {(approval) => (
              <div class="virtual-chat-row">
                <ApprovalCard
                  approval={approval}
                  agentName={props.agent.name}
                  onApprove={() => props.onRespondApproval("accept")}
                  onReject={() => props.onRespondApproval("decline")}
                />
              </div>
            )}
          </Show>
          <Show when={attention.toArray().length > 0}>
            <div class="virtual-chat-row">{attention()}</div>
          </Show>
          <Show when={hold()}>
            {(text) => (
              <div class="virtual-chat-row">
                <p class="agent-queue-hold" role="status">
                  {text()}
                </p>
              </div>
            )}
          </Show>
          <Show when={queued()}>
            {(task) => (
              <section class="agent-thread-queued" aria-label={t("conversation.threads.view.queued")}>
                <For each={task().queuedMessages} keyed={(message) => message.deliveryId}>
                  {(message) => <p class="agent-thread-queued-text">{message().text}</p>}
                </For>
              </section>
            )}
          </Show>
        </div>
      </section>
      <div class="composer-wrap">
        <Show when={failed()}>
          {(task) => (
            <ComposerNotice
              tone="danger"
              title={t("conversation.threads.view.failed")}
              body={task().error || t("conversation.threads.view.failedBody")}
            />
          )}
        </Show>
        <form
          class="composer agent-thread-composer"
          data-compact="true"
          data-attach={props.onAttachFiles ? "" : undefined}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div class="composer-input-label">
            <ComposerEditor
              agentId={props.agent.id}
              agents={props.agents}
              skills={props.skills}
              skillsLoadFailed={props.skillsLoadFailed}
              mcpServers={props.mcpServers}
              attachments={props.draftAttachments}
              value={props.draft}
              placeholder={placeholder()}
              ariaLabel={placeholder()}
              disabled={sending()}
              onSubmit={() => void send()}
              onValueChange={props.onDraftChange}
              onPasteFiles={props.onPasteFiles}
              onOpenAttachment={props.onOpenDraftAttachment}
            />
          </div>
          <div class="composer-toolbar">
            <Show when={props.onAttachFiles}>
              {(attach) => (
                <Button
                  type="button"
                  variant="ghost"
                  class="composer-button"
                  aria-label={t("composer.add.image")}
                  title={t("composer.add.image")}
                  disabled={sending()}
                  onClick={() => attach()()}
                >
                  <Image aria-hidden="true" />
                </Button>
              )}
            </Show>
            <div class="composer-primary-actions">
              {/* One meter for each thread: a pending Compact or an open popover stays with its thread. */}
              <Show when={props.task?.id} keyed>
                {(_taskId) => (
                  <Show when={props.context}>
                    {(usage) => <ContextUsageMeter usage={usage()} compact={props.onCompactContext} />}
                  </Show>
                )}
              </Show>
              <Show when={active()}>
                <Button
                  type="button"
                  variant="ghost"
                  class="voice-button"
                  aria-label={t("composer.send.stop")}
                  title={t("composer.send.stop")}
                  onClick={() => props.onStop()}
                >
                  <Square aria-hidden="true" />
                </Button>
              </Show>
              <Button
                type="submit"
                variant="ghost"
                class="voice-button"
                aria-label={t("composer.send.message")}
                disabled={sending() || props.draft.trim().length === 0}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
            </div>
          </div>
        </form>
      </div>
    </>
  );
}
