import type { LoadSnapshot } from "@openbot/contracts/ipc";
import { OrbitsPanel } from "@openbot/ui/features/orbits/OrbitsPanel";
import type { OrbitAgent, OrbitSystem } from "@openbot/ui/features/orbits/orbits-view";
import { useLayout } from "../../layout";
import { useNavigation } from "../../navigation";
import { useChannels } from "../channels/channels-context";
import { useSidebar } from "../sidebar/sidebar-context";
import { createOpenChannel, createWorkspaceOrbitsView } from "./orbits-view-source";

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
  const layout = useLayout();
  const channels = useChannels();
  const { selectAgent } = useNavigation();
  const { selectRailSection } = useSidebar();
  const view = createWorkspaceOrbitsView(() => props.load);

  const channelName = (channelId: string) => {
    const channel = channels.state.channels.find((entry) => entry.id === channelId);
    return channel ? channel.title.trim() || channel.name : null;
  };

  const openChannel = createOpenChannel();

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
