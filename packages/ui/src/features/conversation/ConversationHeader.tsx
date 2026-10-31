import { Badge, Button, Clock3, IconButton, Info, Lock, Tooltip } from "@openbot/ui";
import { ProviderModelPicker } from "@openbot/ui/components/ProviderModelPicker";
import type { AgentProfile } from "@openbot/ui/data";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { agentAccessLockLabel } from "@openbot/ui/features/agents/agent-access";
import { RemoteDesktopIcon } from "@openbot/ui/features/conversation/ConversationIcons";
import { SidePanelToggle, type SidePanelToggleProps } from "@openbot/ui/features/conversation/SidePanel";
import { ThreadDetailsDialog } from "@openbot/ui/features/conversation/threads/ThreadDetailsDialog";
import {
  CHAT_PREVIEW_OPEN_DELAY,
  CHAT_PREVIEW_SKIP_DELAY,
  ChatPreviewCard,
} from "@openbot/ui/features/sidebar/SidebarAgentIndicator";
import { useText } from "@openbot/ui/text";
import type { ComponentProps, JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";

export interface ConversationHeaderProps {
  agent: AgentProfile | null | undefined;
  /** The title of a chat that has no one agent, such as a channel. It shows when `agent` is missing. */
  title?: JSX.Element | undefined;
  modelPicker: ComponentProps<typeof ProviderModelPicker>;
  /** A turn of the chat runs: its title shimmers, so the work shows in the header too. */
  working?: boolean | undefined;
  /** A model, effort, provider or account chosen during the running turn. It applies from the next turn. */
  pendingModel?: ConversationHeaderPendingModel | undefined;
  onSettingsIntent: () => void;
  onOpenSettings: () => void;
  /** Set while a side thread is open: the agent's name then opens the agent's own chat, not its settings. */
  onOpenChat?: (() => void) | undefined;
  remoteControl?: ConversationHeaderRemoteControl | undefined;
  /** Missing when the chat has no side panel, such as a deleted channel. */
  sidePanel?: SidePanelToggleProps | undefined;
  /** The thread tabs of the agent, after its name. */
  threads?: JSX.Element | undefined;
  /**
   * Set when the agent has thread tabs: the agent's name is then the first tab, for the agent's own
   * chat, and is selected while that chat is open. As a tab, it previews the chat on hover, and while
   * it is selected, a button before the avatar shows the details of the chat.
   */
  titleSelected?: boolean | undefined;
}

export interface ConversationHeaderPendingModel {
  /** The model, and the effort when it changes too, of the running turn. */
  running: string;
  /** The same for the next turn. */
  next: string;
}

export interface ConversationHeaderRemoteControl {
  enabled: boolean;
  active: boolean;
  visible: boolean;
  onOpen: (trigger: HTMLButtonElement) => void;
}

export function ConversationHeader(props: ConversationHeaderProps) {
  const { t } = useText();
  // The chat is open, so its agent works `live`. A function, not a ternary in the prop: the compiler
  // wraps a ternary prop in a memo, and the avatar reads its mood in a tracked effect.
  const mood = () => (props.working ? "live" : "idle");
  const titleTab = () => (props.titleSelected === undefined ? undefined : "");
  const titleSelected = () => (props.titleSelected ? "" : undefined);
  // The agent's own chat as a tab: its first message and the person's last one, already plain text.
  // Without a first message, such as on a host older than the preview, the tab has no preview.
  const mainFirst = () => (props.titleSelected === undefined ? "" : (props.agent?.firstMessage.trim() ?? ""));
  const mainLast = () => (mainFirst() ? (props.agent?.preview.trim() ?? "") : "");
  const mainDetailsShown = () => props.titleSelected === true && mainFirst() !== "";
  const [previewOpen, setPreviewOpen] = createSignal(false);
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const mainDetails = () => {
    const agent = props.agent;
    return detailsOpen() && agent && mainFirst()
      ? { title: agent.name, firstMessage: mainFirst(), lastMessage: mainLast() }
      : null;
  };
  return (
    <header class="window-drag conversation-header">
      <div class="conversation-heading-group">
        <Show when={props.agent} fallback={props.title}>
          {(agent) => (
            <>
              {/* The name is the trigger of its preview itself, so the heading group keeps it as its first element. */}
              <Tooltip.Root
                open={previewOpen() && !detailsOpen()}
                onOpenChange={setPreviewOpen}
                placement="bottom-start"
                gutter={10}
                openDelay={CHAT_PREVIEW_OPEN_DELAY}
                closeDelay={0}
                skipDelayDuration={CHAT_PREVIEW_SKIP_DELAY}
                disabled={mainFirst() === ""}
              >
                <Tooltip.Trigger
                  as={Button}
                  variant="ghost"
                  size="sm"
                  type="button"
                  class="conversation-title no-drag"
                  data-tab={titleTab()}
                  data-selected={titleSelected()}
                  data-details={mainDetailsShown() ? "" : undefined}
                  aria-label={props.onOpenChat ? t("conversation.header.mainChat") : t("conversation.header.settings")}
                  onPointerEnter={() => props.onOpenChat || props.onSettingsIntent()}
                  onFocus={() => props.onOpenChat || props.onSettingsIntent()}
                  onClick={() => (props.onOpenChat ?? props.onOpenSettings)()}
                >
                  <AgentAvatar agent={agent()} mood={mood()} />
                  <h1 class={props.working ? "conversation-title-working" : undefined}>{agent().name}</h1>
                </Tooltip.Trigger>
                <ChatPreviewCard firstMessage={mainFirst()} preview={mainLast()} />
              </Tooltip.Root>
              {/* After the name in the document, so the heading group keeps the name first; it shows over its start. */}
              <Show when={mainDetailsShown()}>
                <IconButton
                  class="conversation-title-details no-drag"
                  variant="ghost"
                  size="icon-xs"
                  label={t("conversation.threads.details.openMain")}
                  onClick={() => setDetailsOpen(true)}
                >
                  <Info aria-hidden="true" />
                </IconButton>
              </Show>
            </>
          )}
        </Show>
        <ThreadDetailsDialog details={mainDetails()} onClose={() => setDetailsOpen(false)} />
        <Show when={props.agent && agentAccessLockLabel(props.agent, t)}>
          {(label) => (
            <span class="conversation-access-lock" role="img" aria-label={label()} title={label()}>
              <Lock aria-hidden="true" />
            </span>
          )}
        </Show>
        {props.threads}
      </div>
      <div class="conversation-header-actions no-drag">
        <Show when={props.agent && props.pendingModel}>
          {(change) => {
            const detail = () => t("conversation.header.modelNextTurnDetail", change());
            return (
              <Badge variant="info-light" class="conversation-model-pending" role="status" title={detail()}>
                <Clock3 aria-hidden="true" />
                {t("conversation.header.modelNextTurn")}
                <span class="sr-only">{detail()}</span>
              </Badge>
            );
          }}
        </Show>
        <Show when={props.agent}>
          <ProviderModelPicker {...props.modelPicker} />
        </Show>
        <Show when={props.remoteControl}>
          {(control) => (
            <Button
              variant="ghost"
              type="button"
              class="header-panel-toggle remote-desktop-button"
              aria-label={t(control().active ? "conversation.header.resumeRemote" : "conversation.header.openRemote")}
              aria-expanded={control().visible ? "true" : "false"}
              disabled={!control().enabled}
              onClick={(event) => control().onOpen(event.currentTarget)}
              data-cuelume-tap="open"
            >
              <RemoteDesktopIcon />
              <Show when={control().active}>
                <span class="remote-desktop-button-dot" aria-hidden="true" />
              </Show>
            </Button>
          )}
        </Show>
        <Show when={props.sidePanel}>{(sidePanel) => <SidePanelToggle {...sidePanel()} />}</Show>
      </div>
    </header>
  );
}
