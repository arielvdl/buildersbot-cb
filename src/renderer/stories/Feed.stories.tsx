import { AVATAR_HUES, type FeedItem } from "@openbot/contracts/ipc";
import { FeedPage } from "@openbot/ui/features/feed/FeedPage";
import { type FeedTeamMember, feedAgentKey } from "@openbot/ui/features/feed/feed-view";
import { createMemo } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createFeedStore } from "../src/features/feed/stores/feed-store";
import { createMockFeed, MOCK_FEED_AGENTS, mockFeedActionItems } from "../src/preview/mock-feed";
import "./feed-story.css";

/**
 * The Team of the stories: every agent of the fixtures, with the state of its newest card, and the
 * agents with no card as free.
 */
function storyTeam(items: readonly FeedItem[]): FeedTeamMember[] {
  const latest = new Map(items.map((item) => [item.agentId, item]));
  return MOCK_FEED_AGENTS.map((agent, index) => ({
    key: feedAgentKey({ serverId: "local", agentId: agent.id }),
    name: agent.name,
    state: latest.get(agent.id)?.state ?? "idle",
    detail: null,
    avatarSeed: agent.id,
    avatarHue: AVATAR_HUES[index % AVATAR_HUES.length] ?? null,
    avatarUrl: null,
  }));
}

/**
 * The feed page with the preview mock behind the real store: a full read, then the deltas, as main
 * sends them. `live` adds a card and a step on a timer.
 */
function FeedStory(props: {
  items: number;
  live?: number;
  /** The cards of the actions story instead of a normal day. */
  actions?: boolean;
  onOpen: (item: FeedItem) => void;
}) {
  const api = createMockFeed({
    items: props.actions ? mockFeedActionItems() : props.items,
    live: props.live ? { intervalMs: props.live } : undefined,
    actionDelayMs: 600,
  });
  const feed = createFeedStore(
    () => api,
    (cause) => String(cause),
  );
  const team = createMemo(() => storyTeam(feed.items()));
  return (
    <div class="feed-story">
      <FeedPage
        items={feed.items()}
        team={team()}
        loading={feed.state.loading}
        error={feed.state.error}
        onOpen={props.onOpen}
        onAct={api.act}
      />
    </div>
  );
}

const meta = {
  title: "Features/Feed",
  component: FeedStory,
  parameters: { layout: "fullscreen" },
  args: { items: 40, onOpen: fn() },
} satisfies Meta<typeof FeedStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing ran yet. */
export const Empty: Story = { args: { items: 0 } };

/** A normal day: 40 runs, the newest at the bottom, a few that work, wait, stopped or need the person. */
export const TypicalDay: Story = {};

/** The same day on the light palette. */
export const TypicalDayLight: Story = { globals: { colorScheme: "light" } };

/** The most cards main keeps. Only the cards on screen are in the DOM. */
export const FiveThousand: Story = { args: { items: 5_000 } };

/** 5,000 cards on the light palette. */
export const FiveThousandLight: Story = { args: { items: 5_000 }, globals: { colorScheme: "light" } };

/**
 * New runs come every 0.7 s. Scrolling up pauses the timeline: the new runs are counted in "N new",
 * and the button at the bottom goes back to the newest.
 */
export const Live: Story = { args: { items: 40, live: 700 } };

/** 5,000 cards while new runs come, for the scrolling check. */
export const LiveFiveThousand: Story = { args: { items: 5_000, live: 250 } };

/**
 * One card of each action: a command to approve, a question of the Guard and more access (high risk,
 * a second step), a question with choices, a question with a typed answer, two questions (for the
 * conversation), a run to stop, three stopped tasks to resume or reassign, one by one or selected
 * together, a card that main refuses, and a card of a joined server, which offers only "open".
 * Each action takes 0.6 s, so the waiting state shows.
 */
export const Actions: Story = { args: { items: 0, actions: true } };

/** The actions on the light palette. */
export const ActionsLight: Story = { args: { items: 0, actions: true }, globals: { colorScheme: "light" } };
