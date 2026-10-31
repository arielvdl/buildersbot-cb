import { sidebarChatSectionId, sidebarSectionRailFocus } from "@openbot/ui/features/sidebar/sidebar-section-rail";
import { createMemo } from "solid-js";
import { useLayout } from "../../layout";
import { useAgents } from "../agents/agents-context";
import { useChannels } from "../channels/channels-context";
import { useSidebar } from "./sidebar-context";

/**
 * The section that the rail selects, for the Workflows and the Schedule pages. It reads the same chats as
 * the list (`WorkspaceSidebar`), so the page and the rail always agree. Null is "All", and it is also
 * the answer while the left column shows the servers.
 */
export function useSectionRailFocus() {
  const layout = useLayout();
  const sidebar = useSidebar();
  const { agentList } = useAgents();
  const channels = useChannels();
  const chatIds = createMemo(() => [
    ...agentList().map((agent) => agent.id),
    ...(channels.supported() && layout.sidebarView() !== "routines"
      ? channels.state.channels.filter((channel) => !channel.archived).map((channel) => channel.id)
      : []),
  ]);
  const focus = createMemo(() =>
    layout.sectionRailVisible()
      ? sidebarSectionRailFocus(sidebar.sidebarLayout(), sidebar.selectedRailSectionId(), chatIds())
      : null,
  );
  return {
    focus,
    /** Whether an agent or a channel is in the selected section. Every chat is in "All". */
    inSection(chatId: string): boolean {
      const section = focus();
      return section === null || sidebarChatSectionId(sidebar.sidebarLayout(), chatId) === section;
    },
  };
}
