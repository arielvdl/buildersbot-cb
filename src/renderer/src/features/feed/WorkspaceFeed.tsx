import { FeedPage } from "@openbot/ui/features/feed/FeedPage";
import { type FeedTeamMember, type FeedTeamState, feedAgentKey } from "@openbot/ui/features/feed/feed-view";
import type { OrbitAgent } from "@openbot/ui/features/orbits/orbits-view";
import { useText } from "@openbot/ui/text";
import { createMemo } from "solid-js";
import { useLoad } from "../load/load-context";
import { createWorkspaceOrbitsView } from "../orbits/orbits-view-source";
import { useServers } from "../servers/servers-context";
import { createFeedOpener } from "./feed-open";
import { feedPort } from "./feed-port";
import { createFeedStore } from "./stores/feed-store";

/** What an agent of the Team panel does, in the states of the feed. */
function teamState(agent: OrbitAgent): FeedTeamState {
  if (agent.wait === "question" || agent.wait === "approval" || agent.wait === "takeover") return "needs-you";
  if (agent.wait === "limit" || agent.state === "stalled") return "stopped";
  switch (agent.state) {
    case "working":
    case "speaking":
    case "thinking":
      return "working";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

/**
 * The feed page of the desktop window. The cards come from main, for every server; the Team list
 * beside them is the Team of the active server, from the same signals as the Team panel, plus every
 * other agent that has a card. An action on a card goes to main with ids only (`feed.act`), and main
 * calls the operation of the conversation or of the load panel.
 */
export function WorkspaceFeed() {
  const { t, errorMessage } = useText();
  const { activeServerId } = useServers();
  const load = useLoad();
  const feed = createFeedStore(feedPort, (cause) => errorMessage(cause, t("app.feed.loadFailed")));
  const orbits = createWorkspaceOrbitsView(() => (load.railShown() ? load.snapshot() : null));
  const team = createMemo((): FeedTeamMember[] =>
    Object.values(orbits().agents).map((agent) => ({
      key: feedAgentKey({ serverId: activeServerId(), agentId: agent.id }),
      name: agent.name,
      state: teamState(agent),
      // The step of the agent's newest card: a summary, never the request.
      detail: null,
      avatarSeed: agent.avatarSeed,
      avatarHue: agent.avatarHue,
      avatarUrl: agent.avatarUrl,
    })),
  );
  const open = createFeedOpener();
  return (
    <FeedPage
      items={feed.items()}
      team={team()}
      loading={feed.state.loading}
      error={feed.state.error}
      onOpen={open}
      onAct={(input) => feedPort().act(input)}
    />
  );
}
