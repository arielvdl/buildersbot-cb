import { Clock3, MessageCircleQuestionMark, MousePointer2, ShieldCheck, Tooltip, X } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, Show } from "solid-js";
import type { AvatarMood } from "../../bloub-avatar";
import { TypingDots } from "../../components/TypingDots";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";
import { SIDEBAR_WAIT_ACTION, SIDEBAR_WAIT_HINT, SIDEBAR_WAIT_TITLE } from "./sidebar-filtering";
import type { SidebarAgentState, SidebarChannelWait, SidebarRoutinePhase, SidebarWaitReason } from "./sidebar-types";

/** Long enough that moving the pointer down the list does not flash every waiting row's tooltip. */
const SIDEBAR_WAIT_TOOLTIP_OPEN_DELAY = 350;
/**
 * The chat preview opens a little later than a wait tooltip: the pointer crosses many rows or tabs on
 * its way to one, and each preview would otherwise cover the row or the tab under it.
 */
export const CHAT_PREVIEW_OPEN_DELAY = 450;
/** After a preview closes, the next one opens at once for this time, as the pointer moves along. */
export const CHAT_PREVIEW_SKIP_DELAY = 300;

export function SidebarAgentIndicator(props: { state: () => SidebarAgentState | undefined }) {
  const { t } = useText();
  const [entering, setEntering] = createSignal(false);
  const unreadCount = () => {
    const state = props.state();
    return state?.kind === "unread" ? state.count : 0;
  };
  let mounted = false;

  createEffect(
    () => props.state()?.kind,
    (nextKind, previousKind) => {
      if (!mounted) {
        mounted = true;
        return;
      }
      if (nextKind !== previousKind)
        setEntering(nextKind === "responded" || nextKind === "unread" || nextKind === "waiting");
    },
  );

  return (
    <Show when={props.state()}>
      {(state) => (
        <span
          class={[
            "agent-row-agent-status",
            `agent-row-agent-status-${state().kind}`,
            routinePhase(state()) ? `agent-row-agent-status-routine-${routinePhase(state())}` : "",
            { "agent-row-agent-status-entering": entering() },
          ]}
          aria-hidden="true"
          onAnimationEnd={() => setEntering(false)}
        >
          <Show when={state().kind === "working"}>
            <TypingDots class="agent-row-thinking-dots" />
          </Show>
          <Show
            when={
              routinePhase(state()) === "running" || routinePhase(state()) === "queued" || state().kind === "limited"
            }
          >
            <Clock3 aria-hidden="true" />
          </Show>
          <Show when={waitReason(state())}>{(reason) => <SidebarWaitIcon reason={reason()} />}</Show>
          <Show when={routinePhase(state()) === "failed"}>
            <X aria-hidden="true" />
          </Show>
          <Show when={state().kind === "responded"}>
            <svg viewBox="0 0 12 12">
              <title>{t("sidebar.state.responded")}</title>
              <path d="m3 6.2 1.8 1.8L9 3.8" />
            </svg>
          </Show>
          <Show when={state().kind === "unread"}>
            <span>{unreadCount()}</span>
          </Show>
        </span>
      )}
    </Show>
  );
}

function routinePhase(state: SidebarAgentState): SidebarRoutinePhase | undefined {
  return state.kind === "routine" ? state.phase : undefined;
}

function waitReason(state: SidebarAgentState): SidebarWaitReason | undefined {
  return state.kind === "waiting" ? state.reason : undefined;
}

/** One icon per wait reason, shared by the badge, the action chip and the tooltip. */
export function SidebarWaitIcon(props: { reason: SidebarWaitReason }) {
  return (
    <>
      <Show when={props.reason === "question"}>
        <MessageCircleQuestionMark aria-hidden="true" />
      </Show>
      <Show when={props.reason === "approval"}>
        <ShieldCheck aria-hidden="true" />
      </Show>
      <Show when={props.reason === "takeover"}>
        <MousePointer2 aria-hidden="true" />
      </Show>
    </>
  );
}

/** The chip in the time slot of a waiting row: what the user does next. */
export function SidebarWaitChip(props: { reason: SidebarWaitReason }) {
  const { t } = useText();
  return (
    <span class="agent-row-wait-chip">
      <SidebarWaitIcon reason={props.reason} />
      <span class="agent-row-wait-chip-label">{t(SIDEBAR_WAIT_ACTION[props.reason])}</span>
    </span>
  );
}

/**
 * The tooltip of a row in "Needs you": what the chat waits for, the question or the command, and what
 * selecting the row does. It stays closed while the row's context menu is open.
 */
export function SidebarWaitTooltip(props: { wait: SidebarChannelWait; menuOpen: boolean; children: JSX.Element }) {
  const { t } = useText();
  const [open, setOpen] = createSignal(false);
  return (
    <Tooltip.Root
      open={open() && !props.menuOpen}
      onOpenChange={setOpen}
      placement="right"
      gutter={10}
      openDelay={SIDEBAR_WAIT_TOOLTIP_OPEN_DELAY}
      closeDelay={0}
      skipDelayDuration={300}
    >
      <Tooltip.Trigger as="div" class="sidebar-agent-tooltip-trigger">
        {props.children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="sidebar-wait-tooltip">
          <span class="sidebar-wait-tooltip-title">
            <SidebarWaitIcon reason={props.wait.reason} />
            {t(SIDEBAR_WAIT_TITLE[props.wait.reason])}
          </span>
          <Show when={props.wait.detail}>
            {(detail) => <span class="sidebar-wait-tooltip-detail">{detail()}</span>}
          </Show>
          <span class="sidebar-wait-tooltip-hint">{t(SIDEBAR_WAIT_HINT[props.wait.reason])}</span>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * The card of a chat preview: the title when the caller has one, what the chat started with, then
 * its last message. The texts are plain text and are cut with an ellipsis: the first message after
 * two lines, or five on the card of a tab (`variant="tab"`), and the last one after three. An empty
 * text does not show.
 */
export function ChatPreviewCard(props: {
  title?: string | undefined;
  firstMessage: string;
  preview: string;
  variant?: "tab" | undefined;
}) {
  const { t } = useText();
  const title = () => props.title?.trim() ?? "";
  const first = () => props.firstMessage.trim();
  const last = () => props.preview.trim();
  return (
    <Tooltip.Portal>
      <Tooltip.Content class="sidebar-chat-preview-tooltip" data-variant={props.variant}>
        <Show when={title()}>{(name) => <span class="sidebar-chat-preview-title">{name()}</span>}</Show>
        <Show when={first()}>
          {(start) => (
            <span class="sidebar-chat-preview-first">
              <span class="sidebar-chat-preview-label">{t("sidebar.preview.startedWith")}</span>
              <span class="sidebar-chat-preview-text">{start()}</span>
            </span>
          )}
        </Show>
        <Show when={last()}>{(text) => <span class="sidebar-chat-preview-last">{text()}</span>}</Show>
      </Tooltip.Content>
    </Tooltip.Portal>
  );
}

/**
 * The open state of the chat preview of a tab. While `blocked` is true, such as while the tab's menu,
 * a rename, a drag or a dialog is open, the preview stays closed and also forgets that it was open:
 * with a controlled `open`, Kobalte does not say that the pointer left, so the card would come back
 * by itself, with no pointer on the tab, when the block ends. After the block, the pointer opens it
 * as usual.
 */
export function createChatPreviewOpen(blocked: () => boolean): {
  open: () => boolean;
  onOpenChange: (open: boolean) => void;
} {
  const [wanted, setWanted] = createSignal(false);
  createEffect(blocked, (isBlocked) => {
    if (isBlocked) setWanted(false);
  });
  return {
    open: () => wanted() && !blocked(),
    onOpenChange: (next) => setWanted(next && !blocked()),
  };
}

/**
 * The hover preview of a chat row: the `ChatPreviewCard` beside the row. It opens without a click,
 * after a short pause, and says what the row is about before the user opens it. It stays closed while
 * the chat's context menu is open, and it does not open when the chat has no text to show.
 */
export function SidebarChatPreviewTooltip(props: {
  title?: string;
  firstMessage: string;
  preview: string;
  menuOpen: boolean;
  /** Where the card opens: beside a row, below a tab. */
  placement?: "right" | "bottom-start";
  children: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  const hasText = () => props.firstMessage.trim() !== "" || props.preview.trim() !== "";
  return (
    <Show when={hasText()} fallback={props.children}>
      <Tooltip.Root
        open={open() && !props.menuOpen}
        onOpenChange={setOpen}
        placement={props.placement ?? "right"}
        gutter={10}
        openDelay={CHAT_PREVIEW_OPEN_DELAY}
        closeDelay={0}
        skipDelayDuration={CHAT_PREVIEW_SKIP_DELAY}
      >
        <Tooltip.Trigger as="div" class="sidebar-agent-tooltip-trigger">
          {props.children}
        </Tooltip.Trigger>
        <ChatPreviewCard title={props.title} firstMessage={props.firstMessage} preview={props.preview} />
      </Tooltip.Root>
    </Show>
  );
}

export function SidebarPinnedAvatar(props: {
  agent: AgentProfile;
  mood: AvatarMood;
  agentState: () => SidebarAgentState | undefined;
}) {
  return (
    <span class="agent-row-avatar sidebar-pinned-avatar">
      <AgentAvatar agent={props.agent} motion="idle" mood={props.mood} />
      <SidebarAgentIndicator state={props.agentState} />
    </span>
  );
}
