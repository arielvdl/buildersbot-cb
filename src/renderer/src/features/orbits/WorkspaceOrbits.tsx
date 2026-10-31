import type { LoadSnapshot } from "@openbot/contracts/ipc";
import { OrbitsPanel } from "@openbot/ui/features/orbits/OrbitsPanel";
import { type OrbitAgent, type OrbitSystem, orbitsView } from "@openbot/ui/features/orbits/orbits-view";
import { sidebarAgentWaits } from "@openbot/ui/features/sidebar/sidebar-agent-states";
import { useText } from "@openbot/ui/text";
import { createMemo } from "solid-js";
import { useLayout } from "../../layout";
import { useNavigation } from "../../navigation";
import { useTurns } from "../../turns";
import { attentionByAgent } from "../agents/agent-runtime-snapshot";
import { createAgentWorkingTurns } from "../agents/agent-working-turns";
import { useAgents } from "../agents/agents-context";
import { readChannelLastTopics } from "../channels/channel-tabs-model";
import { useChannels } from "../channels/channels-context";
import { useConversation } from "../conversation/conversation-context";
import { useSidebar } from "../sidebar/sidebar-context";

/**
 * The Team panel of the desktop window, mounted only while it is open. It reads the same signals as
 * the sidebar: the agents, their turns, queues and waits, the channels and the sidebar layout. A
 * joined server sends them on the same path, so the panel needs no route of its own. `load` adds the
 * request and the start time of running work, and the stopped channel tasks; only this computer
 * reports it, so it is null on a joined server.
 */
export function WorkspaceOrbits(props: {
  load: LoadSnapshot | null;
  /** The panel closed. `jumped`: it opened a channel or a chat, which takes the focus. */
  onClose: (jumped: boolean) => void;
}) {
  const { t } = useText();
  const layout = useLayout();
  const channels = useChannels();
  const { selectAgent } = useNavigation();
  const { agentList, userHiddenAgentIds } = useAgents();
  const { queues, failedTurns, usageLimits, pendingPrompts, pendingApprovals, turnProgress } = useTurns();
  const { recentReplies, unreadReplies } = useConversation();
  const { sidebarLayout, selectRailSection } = useSidebar();
  const workingTurns = createAgentWorkingTurns();

  const view = createMemo(() =>
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
      load: props.load,
    }),
  );

  const channelName = (channelId: string) => {
    const channel = channels.state.channels.find((entry) => entry.id === channelId);
    return channel ? channel.title.trim() || channel.name : null;
  };

  /** Opens a channel on the tab of the work, else on the tab that the sidebar would open. */
  const openChannel = (channelId: string, topicId: string | null) => {
    const topics = channels.state.channels.find((entry) => entry.id === channelId)?.topics ?? [];
    const last = readChannelLastTopics()[channelId];
    const topic = topicId ?? topics.find((entry) => entry.id === last)?.id ?? null;
    void channels.open(channelId).then(() => {
      if (topic) void channels.setTopic(topic);
    });
  };

  const openSystem = (system: OrbitSystem) => {
    props.onClose(true);
    if (system.kind === "channel") {
      openChannel(system.targetId, null);
      return;
    }
    layout.setSidebarView("agents");
    if (layout.sectionRailVisible()) selectRailSection(system.targetId);
    if (system.sunId) selectAgent(system.sunId);
  };

  const openAgent = (agent: OrbitAgent) => {
    props.onClose(true);
    if (agent.place) openChannel(agent.place.channelId, agent.place.topicId);
    else selectAgent(agent.id);
  };

  return (
    <OrbitsPanel
      open
      onOpenChange={(open) => {
        if (!open) props.onClose(false);
      }}
      view={view()}
      channelName={channelName}
      onOpenSystem={openSystem}
      onOpenAgent={openAgent}
    />
  );
}
