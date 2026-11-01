import type { ChannelSummary, SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { Sidebar } from "@openbot/ui/features/sidebar/Sidebar";
import type { SidebarAgentState } from "@openbot/ui/features/sidebar/sidebar-types";
import { createSignal, createStore, untrack } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { applySidebarLayoutAction } from "../src/preview/mock-sidebar-layout";
import { requireFixture, STORY_AGENTS } from "./fixtures";

const NAIA = "51111111-1111-4111-8111-111111111111";
const RED_TEAM = "52222222-2222-4222-8222-222222222222";
const CLAUDE_BOTS = "53333333-3333-4333-8333-333333333333";
const VIDEOS = "54444444-4444-4444-8444-444444444444";
const CB = "55555555-5555-4555-8555-555555555555";
const SEC = "56666666-6666-4666-8666-666666666666";

/** A 48 px PNG, as the icon editor stores a picked image. */
const SEC_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAChklEQVR42s3X709OYRgH8O8fgTH2GGMaY4wxVlKRUqRWpKiVKBJFSpFakVqJWolaaX4s6unXUxERERGJfhARERHRm957tjY7M+7nOufcz3Zt18t7O58X97mv7xcT6sommsom1ZRPrjZOqTROraiYZqw0lFdNv1o140r1zNKaWZdNsy+Z5lystblQN7ekft75+vnF1xYUXV9Y2LCooGHxuRtL8m8uPdO4LK9xee6tFTm3bbOb7E432WfdWXXyrmNms1NG85r0e85p911OtLimtrgde+Ce8nBDcqtHUqtn4iOvo4+9E9p8Drdtjn/iG/fU71A7WGn8Y9rBSrP14DOw0gREd4CVJnB/B1hpgqKeg5UmOPIFWGlC9nWClWZHRCdYaUL3dIGVJiy8G7I0BoONfs3uXT3QrDELxKNBEx7WAytpxketJiL0JdRqlN8bGxv93yiP0TV7d76CNo2A8k8WURMZ0gvraf4yUTRR23uh9t6o0ihNFM2B4NewtkZpsqiJDnoDVf+UTpB5xJqYwD5QXj+dGqVJrIkN6APlLZYIEmvitr0FZTNIBIk18f7vQNxTskBizRG/fhA1skDmEWgStvSDkigkgsSaRN/3oOQbiSCxJmnTB1DSlkSQWJPsMwBK9pMIEmtSvAdASaISX2qx5rjXRxBzsRSQRU2q5yfQU7rObU/RpG0cBL0z6MxDFE26xyBUNRjNiZGoyVj/GWr7lIZMTddkun+BtnZHbB3Ee/NHk+U2BM3tzhqaU+uGoL9rjicKyp6yqMl2+QopGnGioGty1n4DK02u8zBYafJWD4OVJt/pO1hpzjr+ACtNgcMIWGkK7UfASlO08idYaYrtfoGVpsR29DcPc5ayoZGyOgAAAABJRU5ErkJggg==";

const base = requireFixture(STORY_AGENTS[0], "Story agent");
const agentNames: [string, string, string][] = [
  ["naia-scout", "Scout", NAIA],
  ["naia-writer", "Writer", NAIA],
  ["red-recon", "Recon", RED_TEAM],
  ["red-exploit", "Exploit", RED_TEAM],
  ["claude-opus", "Opus", CLAUDE_BOTS],
  ["claude-fable", "Fable", CLAUDE_BOTS],
  ["videos-editor", "Editor", VIDEOS],
  ["cb-host", "Host", CB],
  ["sec-audit", "Audit", SEC],
  ["loose-helper", "Helper", ""],
];
const agents = agentNames.map(([id, name]) => ({
  ...base,
  id,
  name,
  title: "",
  threadId: `thread-${id}`,
  avatarSeed: id,
  preview: `${name} is ready.`,
}));

function storyChannel({ id, name, unread, active }: { id: string; name: string; unread: number; active: number }) {
  return {
    id,
    name,
    title: "",
    instructions: "",
    members: agents.slice(0, 2).map((agent) => ({ agentId: agent.id })),
    leadAgentId: null,
    archived: false,
    revision: 1,
    createdAt: "2026-10-01T09:00:00.000Z",
    unreadCount: unread,
    activeTasks: active,
    lastMessage: { at: "2026-10-30T10:00:00.000Z", text: `News in #${name}`, authorName: "Scout" },
  } satisfies ChannelSummary;
}

const channels: ChannelSummary[] = [
  { id: "naia-launch", name: "launch", unread: 3, active: 0 },
  { id: "red-ops", name: "ops", unread: 0, active: 1 },
  { id: "cb-live", name: "live", unread: 12, active: 0 },
].map(storyChannel);

const layout: SidebarLayoutSnapshot = {
  revision: 1,
  sections: [
    { id: NAIA, name: "naia", color: "#a855f7" },
    { id: RED_TEAM, name: "Red Team", color: "#ef4444", icon: { kind: "glyph", glyph: "shield" } },
    { id: CLAUDE_BOTS, name: "Claude Bots", color: "#f97316", icon: { kind: "glyph", glyph: "bot" } },
    { id: VIDEOS, name: "videos", icon: { kind: "glyph", glyph: "film" } },
    { id: CB, name: "cb", color: "#3b82f6", icon: { kind: "letter", text: "CB" } },
    { id: SEC, name: "sec", icon: { kind: "image", dataUrl: SEC_IMAGE } },
  ],
  order: ["people", NAIA, RED_TEAM, CLAUDE_BOTS, VIDEOS, CB, SEC, "unassigned"],
  agentAssignments: {
    ...Object.fromEntries(agentNames.flatMap(([id, , section]) => (section ? [[id, section]] : []))),
    "naia-launch": NAIA,
    "red-ops": RED_TEAM,
    "cb-live": CB,
  },
  agentOrder: [],
};

/** Naia waits for an answer, Red Team works, cb has unread messages: each rail item shows one badge. */
const agentStates: Record<string, SidebarAgentState> = {
  "naia-scout": { kind: "waiting", reason: "question", detail: "Publish the post now?" },
  "naia-writer": { kind: "unread", count: 2 },
  "red-recon": { kind: "working" },
  "claude-opus": { kind: "unread", count: 1 },
};

const args: Parameters<typeof Sidebar>[0] = {
  serverName: "Builders Bot",
  agents,
  channels,
  activeAgentId: "naia-writer",
  people: [],
  directThreads: [],
  activeDirectMemberId: null,
  agentStates,
  agentMoods: {},
  layout,
  layoutMutable: true,
  sectionIconsSupported: true,
  sectionColorSupported: true,
  markersSupported: true,
  collapsedSectionIds: [],
  onMutateLayout: fn(async () => undefined),
  onToggleSection: fn(),
  pinnedItems: [],
  peopleOrder: [],
  onPin: fn(),
  onUnpin: fn(),
  onReorderPinned: fn(),
  onReorderPeople: fn(),
  onSelectAgent: fn(),
  onSelectPerson: fn(),
  onSelectChannel: fn(),
  onCreateAgent: fn(),
  onEditAgent: fn(),
  onDeleteAgent: async () => undefined,
  compact: false,
  onExpand: fn(),
  onOpenSearch: fn(),
  onOpenMarketplace: fn(),
  sectionRail: { selectedId: null, onSelect: fn() },
};

/** The real sidebar. The selection, the open chat and the layout change as in the app. */
function InteractiveSidebar(props: Parameters<typeof Sidebar>[0]) {
  const [selectedId, setSelectedId] = createSignal(untrack(() => props.sectionRail?.selectedId ?? null));
  const [current, setCurrent] = createSignal(untrack(() => props.layout));
  // One chat is open at a time, as in the app: an open channel leaves no agent open.
  const [open, setOpen] = createStore({
    agentId: untrack(() => props.activeAgentId),
    channelId: untrack(() => props.activeChannelId ?? null),
  });
  return (
    <Sidebar
      {...props}
      activeAgentId={open.agentId}
      activeChannelId={open.channelId}
      onSelectAgent={(agentId) => {
        setOpen((state) => {
          state.agentId = agentId;
          state.channelId = null;
        });
        props.onSelectAgent(agentId);
      }}
      onSelectChannel={(channelId) => {
        setOpen((state) => {
          state.agentId = "";
          state.channelId = channelId;
        });
        props.onSelectChannel?.(channelId);
      }}
      layout={current()}
      sectionRail={{
        selectedId: selectedId(),
        onSelect: (sectionId) => {
          setSelectedId(sectionId);
          props.sectionRail?.onSelect(sectionId);
        },
      }}
      onMutateLayout={async (action) => {
        setCurrent((layout) => applySidebarLayoutAction(layout, action));
        await props.onMutateLayout(action);
      }}
    />
  );
}

const meta = {
  title: "Navigation/Section rail",
  component: Sidebar,
  args,
  parameters: { layout: "fullscreen" },
  // The real app frame grid, so the rail takes the column that the server rail takes in the app.
  decorators: [
    (Story, context) => (
      <div
        class="app-frame app-frame-with-server-rail"
        style={`--left-panel-width: ${context.parameters.compactSidebar ? 88 : 280}px; height: 100vh;`}
      >
        {Story()}
      </div>
    ),
  ],
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Each story spreads the plain fixture object, not the Storybook args: a spread of the args object
 * gave the sidebar none of its fields in this story.
 */
function railStory(overrides: Partial<Parameters<typeof Sidebar>[0]>, compactSidebar = false): Story {
  return {
    render: () => <InteractiveSidebar {...args} {...overrides} />,
    parameters: { compactSidebar },
  };
}

/** "All" is selected: the list shows every section, as it did before the rail. */
export const AllSections: Story = railStory({});

/** One section selected: the list shows only the chats of Naia, with its heading. */
export const SectionSelected: Story = railStory({ sectionRail: { selectedId: NAIA, onSelect: fn() } });

/** A remembered section that is gone reads as "All". */
export const RememberedSectionGone: Story = railStory({
  sectionRail: { selectedId: "59999999-9999-4999-8999-999999999999", onSelect: fn() },
});

/** The compact sidebar keeps the rail. */
export const CompactSidebar: Story = railStory(
  { compact: true, sectionRail: { selectedId: RED_TEAM, onSelect: fn() } },
  true,
);

/** A remote server keeps the layout but no icon: each section shows its first letter, and the menu has no icon item. */
export const RemoteServerLetters: Story = railStory({
  sectionIconsSupported: false,
  sectionColorSupported: false,
  layout: { ...layout, sections: layout.sections.map(({ id, name }) => ({ id, name })) },
});

const DONE = "marker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LATER = "marker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RED = "marker:cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * Markers in naia and Red Team: the chats below "Done" are dimmed, the chats below "Later" are black and
 * white, and the chats below "Ops" have a red tint. The open chat (Writer) keeps its full strength.
 * Click a marker to edit it; "+" > New marker adds one at the top of the selected section.
 */
export const Markers: Story = railStory({
  activeAgentId: "naia-writer",
  layout: {
    ...layout,
    markers: [
      { id: DONE, sectionId: NAIA, label: "Done", style: "dim" },
      { id: LATER, sectionId: NAIA, label: "Later", style: "grayscale" },
      { id: RED, sectionId: RED_TEAM, label: "Ops", style: "tint", color: "#ef4444" },
    ],
    itemOrder: [
      "naia-launch",
      DONE,
      "naia-scout",
      "naia-writer",
      LATER,
      RED,
      "red-recon",
      "red-exploit",
      "red-ops",
      ...agentNames.map(([id]) => id).filter((id) => !id.startsWith("naia-") && !id.startsWith("red-")),
      "cb-live",
    ],
  },
});

/**
 * Drag a section icon up or down to reorder the sections, or focus one and press Alt+Arrow. "All",
 * "Unassigned" and the plus button stay in place. The list follows the same order.
 */
export const ReorderSections: Story = railStory({});

const ROUTINES = "marker:dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FINISHED = "marker:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CB_SOON = "marker:ffffffff-ffff-4fff-8fff-ffffffffffff";

/**
 * The open chat in a color. In naia, which has no color, the chats below the green "Routines" marker have
 * a green tint, and the open chat "requests" keeps that green in a stronger tint; "launch", above the
 * marker, and "Writer", below the plain "Done" marker, open in the gray of the theme. Red Team and
 * Claude Bots (a custom color) are boxes with a color; cb is a blue box with a yellow marker. Click a
 * chat to open it, and point at one: each state keeps the hue of its section or marker.
 */
export const ColoredOpenChat: Story = railStory({
  activeAgentId: "",
  activeChannelId: "naia-requests",
  agentStates: {},
  channels: [
    ...channels,
    ...[
      { id: "naia-requests", name: "requests", unread: 0, active: 0 },
      { id: "naia-chat", name: "chat improvements", unread: 0, active: 0 },
    ].map(storyChannel),
  ],
  layout: {
    ...layout,
    sections: layout.sections.map((section) => {
      if (section.id === NAIA) return { id: NAIA, name: "naia" };
      if (section.id === CLAUDE_BOTS) return { ...section, color: "#14b8a6" };
      return section;
    }),
    agentAssignments: { ...layout.agentAssignments, "naia-requests": NAIA, "naia-chat": NAIA },
    markers: [
      { id: ROUTINES, sectionId: NAIA, label: "Routines", style: "tint", color: "#22c55e" },
      { id: FINISHED, sectionId: NAIA, label: "Done", style: "normal" },
      { id: CB_SOON, sectionId: CB, label: "Soon", style: "tint", color: "#eab308" },
    ],
    itemOrder: [
      "naia-launch",
      ROUTINES,
      "naia-requests",
      "naia-chat",
      "naia-scout",
      FINISHED,
      "naia-writer",
      "red-recon",
      "red-exploit",
      "red-ops",
      "claude-opus",
      "claude-fable",
      "videos-editor",
      CB_SOON,
      "cb-host",
      "cb-live",
      "sec-audit",
      "loose-helper",
    ],
  },
});
