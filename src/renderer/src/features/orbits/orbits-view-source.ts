import type { LoadSnapshot } from "@openbot/contracts/ipc";
import { orbitsView } from "@openbot/ui/features/orbits/orbits-view";
import { sidebarAgentWaits } from "@openbot/ui/features/sidebar/sidebar-agent-states";
import { useText } from "@openbot/ui/text";
import { createMemo } from "solid-js";
import { useTurns } from "../../turns";
import { attentionByAgent } from "../agents/agent-runtime-snapshot";
import { createAgentWorkingTurns } from "../agents/agent-working-turns";
import { useAgents } from "../agents/agents-context";
import { readChannelLastTopics } from "../channels/channel-tabs-model";
import { useChannels } from "../channels/channels-context";
import { useConversation } from "../conversation/conversation-context";
import { useSidebar } from "../sidebar/sidebar-context";

/**
 * The Team of the active server, as the Team panel and the Team list of the feed page show it. It
 * reads the same signals as the sidebar, so the two places cannot disagree on what an agent does.
 * Call it in a component.
 */
export function createWorkspaceOrbitsView(load: () => LoadSnapshot | null) {
  const { t } = useText();
  const channels = useChannels();
  const { agentList, userHiddenAgentIds } = useAgents();
  const { queues, failedTurns, usageLimits, pendingPrompts, pendingApprovals, turnProgress } = useTurns();
  const { recentReplies, unreadReplies } = useConversation();
  const { sidebarLayout } = useSidebar();
  const workingTurns = createAgentWorkingTurns();
  return createMemo(() =>
    orbitsView({
      agents: agentList(),
      hiddenAgentIds: userHiddenAgentIds(),
      channels: channels.supported() ? channels.state.channels : [],
      layout: sidebarLayout(),
      unassignedName: t("sidebar.section.unassigned"),
      // A wait in any thread stops the agent, its channel threads included.
      waits: sidebarAgentWaits({
        agentIds: agentList().map((agent) => agent.id),
        pendingPrompts: attentionByAgent(pendingPrompts(), agentList()),
        pendingApprovals: pendingApprovals(),
        usageLimits: usageLimits(),
      }),
      activeTurns: workingTurns(),
      queues: queues(),
      failedTurns: failedTurns(),
      recentReplies: recentReplies(),
      unreadReplies: unreadReplies(),
      turnSteps: turnProgress(),
      load: load(),
    }),
  );
}

/** Opens a channel on the tab of the work, else on the tab that the sidebar would open. Call it in a component. */
export function createOpenChannel() {
  const channels = useChannels();
  return (channelId: string, topicId: string | null) => {
    const topics = channels.state.channels.find((entry) => entry.id === channelId)?.topics ?? [];
    const last = readChannelLastTopics()[channelId];
    const topic = topicId ?? topics.find((entry) => entry.id === last)?.id ?? null;
    void channels.open(channelId, topic);
  };
}
