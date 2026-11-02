/** The sidebar's agent, channel and section confirmations share one pending delete state. */

import { Checkbox, ConfirmDialog } from "@openbot/ui";
import { For, Show } from "solid-js";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";
import { ChannelAvatar } from "../channels/ChannelAvatar";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarDialogs() {
  const {
    closeDelete,
    confirmDelete,
    confirmSectionDelete,
    deleteError,
    deleteTarget,
    channelDeleteTarget,
    channelExclusiveAgents,
    deleting,
    pending,
    props,
    sectionDeleteTarget,
    setDeleteWithAgents,
  } = useSidebarScope();
  const { t } = useText();
  const shared = {
    get confirmLabel() {
      return t("common.delete");
    },
    get pendingLabel() {
      return t("sidebar.delete.pending");
    },
    onCancel: closeDelete,
  };
  // Each dialog unmounts with its target, so its text never shows an empty name while it closes.
  return (
    <>
      <Show when={deleteTarget()}>
        {(agent) => (
          <ConfirmDialog
            {...shared}
            open
            pending={deleting()}
            error={deleteError()}
            media={<AgentAvatar agent={agent()} style={{ width: "44px", height: "44px" }} />}
            title={t("sidebar.delete.title", { name: agent().name })}
            description={t("sidebar.delete.agentDescription")}
            onConfirm={confirmDelete}
          />
        )}
      </Show>

      <Show when={channelDeleteTarget()}>
        {(channel) => (
          <ConfirmDialog
            {...shared}
            open
            pending={deleting()}
            error={deleteError()}
            media={<ChannelAvatar members={channel().members} agents={props.agents} layout="cluster" />}
            title={t("sidebar.delete.title", { name: channel().name })}
            description={t("sidebar.delete.channelDescription")}
            onConfirm={confirmDelete}
          >
            <Show when={channelExclusiveAgents().length > 0}>
              <label class="sidebar-delete-with-agents" for="sidebar-delete-with-agents">
                <Checkbox
                  id="sidebar-delete-with-agents"
                  checked={pending.deletion?.withAgents === true}
                  disabled={deleting()}
                  onChange={(event) => setDeleteWithAgents(event.currentTarget.checked)}
                />
                <span>{t("sidebar.delete.withAgents", { count: channelExclusiveAgents().length })}</span>
              </label>
              <ul class="sidebar-delete-with-agents-list">
                <For each={channelExclusiveAgents()}>{(agent) => <li>{agent.name}</li>}</For>
              </ul>
              <Show when={pending.deletion?.withAgents === true}>
                <p class="sidebar-delete-with-agents-note">{t("sidebar.delete.withAgentsNote")}</p>
              </Show>
            </Show>
          </ConfirmDialog>
        )}
      </Show>

      <Show when={sectionDeleteTarget()}>
        {(section) => (
          <ConfirmDialog
            {...shared}
            open
            pending={deleting()}
            error={deleteError()}
            title={t("sidebar.delete.title", { name: section().name })}
            description={t("sidebar.delete.sectionDescription")}
            onConfirm={confirmSectionDelete}
          />
        )}
      </Show>
    </>
  );
}
