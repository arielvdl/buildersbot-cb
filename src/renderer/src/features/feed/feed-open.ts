import type { FeedItem } from "@openbot/contracts/ipc";
import { createEffect } from "solid-js";
import { useNavigation } from "../../navigation";
import { useAgentTasks } from "../agent-tasks/agent-tasks-context";
import { useAgentThreads } from "../agent-threads/agent-threads-context";
import { createOpenChannel } from "../orbits/orbits-view-source";
import { useServerScope } from "../servers/server-scope";
import { useServerSelection } from "../servers/server-selection";
import { useServers } from "../servers/servers-context";
import { useWindowPage } from "../window/window-page-context";

type FeedOpenTarget = Pick<FeedItem, "serverId" | "agentId" | "threadId" | "channelId">;

/**
 * A card of another server, waiting for the switch to that server. The switch rebuilds the feed page
 * with the rest of the workspace, so the request has to outlive this page; the new page opens it once
 * the workspace has loaded.
 */
let pendingOpen: FeedOpenTarget | null = null;

/**
 * Opens the place of a card: its channel, or the chat of its agent on the tab of its thread. A card of
 * another server switches to that server first. Call it in a component.
 */
export function createFeedOpener() {
  const { activeServerId } = useServers();
  const { selectServer } = useServerSelection();
  const { loaded } = useServerScope();
  const { selectAgent } = useNavigation();
  const windowPage = useWindowPage();
  const agentThreads = useAgentThreads();
  const tasks = useAgentTasks();
  const openChannel = createOpenChannel();

  const openHere = (target: FeedOpenTarget) => {
    if (target.channelId) {
      windowPage.showAgents();
      openChannel(target.channelId, null);
      return;
    }
    if (!selectAgent(target.agentId)) return;
    const task = target.threadId
      ? tasks.snapshot(target.agentId)?.tasks.find((entry) => entry.threadId === target.threadId)
      : undefined;
    if (task) agentThreads.open(target.agentId, task.id);
  };

  createEffect(
    () => ({ ready: loaded(), serverId: activeServerId() }),
    ({ ready, serverId }) => {
      const target = pendingOpen;
      if (!target || !ready || target.serverId !== serverId) return;
      pendingOpen = null;
      openHere(target);
    },
  );

  return (item: FeedItem) => {
    const target: FeedOpenTarget = {
      serverId: item.serverId,
      agentId: item.agentId,
      threadId: item.threadId,
      channelId: item.channelId,
    };
    if (item.serverId === activeServerId()) {
      openHere(target);
      return;
    }
    pendingOpen = target;
    void selectServer(item.serverId, false).then((switched) => {
      if (!switched && pendingOpen === target) pendingOpen = null;
    });
  };
}
