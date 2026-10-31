import { avatarMarkAccent } from "@openbot/brand/agent-mark";
import {
  type AgentProviderId,
  type AgentProviderRef,
  isKnownAgentProvider,
  providerDisplayName,
} from "@openbot/contracts/agent-providers";
import {
  type AvatarHue,
  type ChannelSummary,
  type LoadSnapshot,
  type QueueSnapshot,
  SIDEBAR_UNASSIGNED_SECTION_ID,
  type SidebarLayoutSnapshot,
} from "@openbot/contracts/ipc";
import { isAgentWorking } from "../sidebar/agent-working";
import type { SidebarAgentWait } from "../sidebar/sidebar-agent-states";

/**
 * The Team panel ("Equipe") as data: which agents show, in which system, in which state, with which
 * model mark. Pure and DOM-free, so the renderer feeds it the signals the sidebar already reads, and
 * a story feeds it fixtures. See `docs/architecture/team-orbits.md`.
 */

/**
 * What an agent does, as the panel draws it. `stalled` is a channel task that stopped and waits for
 * the person. `failed` is a last turn that failed: the mark stays until the next turn or until the
 * person sees it, so it can be old, and it does not make its system show.
 */
export type OrbitState = "working" | "speaking" | "thinking" | "waiting" | "stalled" | "failed" | "done" | "idle";

/**
 * What a waiting agent waits for. `question`, `approval` and `takeover` wait for the person. `limit`
 * waits for a provider plan to reset. `turn` waits for a free place under the agent cap, or for its
 * queued routine run.
 */
export type OrbitWait = "question" | "approval" | "takeover" | "limit" | "turn";

/** The Claude tiers. Each one has its own mark, because one provider runs most agents. */
export type OrbitTier = "opus" | "sonnet" | "haiku" | "fable";

/**
 * The makers of open models that run through a router, such as OpenCode, OpenRouter or Cultura
 * Builder. No provider of this build has their logo, so each one has a plain shape of its own.
 */
export type OrbitMaker = "kimi" | "glm" | "qwen";

/**
 * The model family of an agent: a Claude tier, the mark of a provider, the shape of a maker, or
 * `other` for a provider that this build does not know. `name` is a product name, so it is not
 * translated; `other` has none.
 */
export type OrbitFamily =
  | { id: OrbitTier; kind: "tier"; name: string }
  | { id: AgentProviderId; kind: "provider"; name: string }
  | { id: OrbitMaker; kind: "maker"; name: string }
  | { id: "other"; kind: "other"; name: null };

export interface OrbitAgent {
  id: string;
  name: string;
  title: string;
  avatarSeed: string;
  avatarHue: AvatarHue | null;
  avatarUrl: string | null;
  family: OrbitFamily;
  state: OrbitState;
  /** Set only while `state` is `waiting`. */
  wait: OrbitWait | null;
  /** One line about the work: the request, the current step, the question, or the stopped task. */
  task: string | null;
  /** Why the channel task stopped, for a stalled agent. Null when the host does not say. */
  stopReason: string | null;
  /** What the bubble says: the question the agent asks, or the message it writes now. */
  says: string | null;
  /** When the running work started, in epoch milliseconds. Only this computer's load reports it. */
  startedAt: number | null;
  /** When the plan of a `limit` wait resets, in epoch seconds. */
  resetsAt: number | null;
  /** The channel and its tab where the work is. Null: the agent's own chat, or not known. */
  place: { channelId: string; topicId: string | null } | null;
}

export interface OrbitSystem {
  /** `channel:<id>` or `section:<id>`. */
  key: string;
  kind: "channel" | "section";
  /** The channel or the section to open. */
  targetId: string;
  name: string;
  /**
   * A colour from the data. A channel takes the hue of its lead, so two channels of one section do
   * not look the same. A section takes its own colour, else the hue of its first agent. Null: the
   * panel picks one from the key, so it does not change while other systems come and go.
   */
  color: string | null;
  /** The lead of a channel, or the first active agent of a section. */
  sunId: string | null;
  /** Every agent of the system, the sun included, in sidebar order. */
  agentIds: string[];
}

/** One agent asked another: a message between them is still in a queue. */
export interface OrbitLink {
  from: string;
  to: string;
}

export interface OrbitFamilyCount {
  family: OrbitFamily;
  /** The agents of this family that the panel shows. */
  shown: number;
  /** The agents of this family that generate now: working, speaking or thinking. */
  generating: number;
}

export interface OrbitsView {
  systems: OrbitSystem[];
  agents: Record<string, OrbitAgent>;
  links: OrbitLink[];
  /** Each family of the shown agents, in a fixed order. */
  families: OrbitFamilyCount[];
}

/** The fields of an agent profile that the panel reads. */
export interface OrbitAgentProfile {
  id: string;
  name: string;
  title: string;
  provider: AgentProviderRef;
  model: string;
  avatarSeed: string;
  avatarHue: AvatarHue | null;
  avatarUrl: string | null;
}

export type OrbitChannel = Pick<
  ChannelSummary,
  "id" | "name" | "title" | "archived" | "members" | "leadAgentId" | "activeTasks" | "lastMessage" | "topics"
>;

export interface OrbitsViewInput {
  agents: readonly OrbitAgentProfile[];
  /** The agents that the person hid. They do not show, as in the sidebar. */
  hiddenAgentIds?: ReadonlySet<string> | undefined;
  channels: readonly OrbitChannel[];
  layout: Pick<SidebarLayoutSnapshot, "order" | "sections" | "agentAssignments" | "agentOrder">;
  /** The translated name of the section of the agents that are in no section. */
  unassignedName: string;
  /** What stops each agent until the person acts or its plan resets, from `sidebarAgentWaits` over all its threads. */
  waits: Readonly<Record<string, SidebarAgentWait>>;
  /** The running turn of each agent, its side threads included, as the sidebar reads it. */
  activeTurns: Readonly<Record<string, string | null>>;
  queues: Readonly<Record<string, QueueSnapshot>>;
  failedTurns: Readonly<Record<string, string | undefined>>;
  recentReplies: Readonly<Record<string, boolean>>;
  unreadReplies: Readonly<Record<string, number>>;
  /** The last step that each agent reported in its running turn. */
  turnSteps: Readonly<Record<string, { turnId: string; detail: string } | undefined>>;
  /** The load of this computer, or null on a joined server and before the first reading. */
  load: LoadSnapshot | null;
}

/** The most links the panel draws. They are faint until a pointer or the focus reaches one end. */
export const ORBIT_LINK_LIMIT = 24;
/** The most bubbles at the same time. A bubble is for the agents that need attention most. */
export const ORBIT_BUBBLE_LIMIT = 2;

const TIER_NAMES: Readonly<Record<OrbitTier, string>> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
};
const TIER_ORDER: readonly OrbitTier[] = ["opus", "sonnet", "haiku", "fable"];
const TIER_PATTERN = /(?:^|[^a-z])(opus|sonnet|haiku|fable)(?:[^a-z]|$)/u;
/**
 * Model ids that name the maker of the model when another provider, such as OpenRouter, runs it. A
 * maker with a provider in this build shows the logo of that provider (Gemini runs on Antigravity).
 */
const MODEL_MAKERS: readonly { pattern: RegExp; provider: AgentProviderId }[] = [
  { pattern: /(?:^|\/)(?:gpt|o\d)(?:-|$)/u, provider: "codex" },
  { pattern: /(?:^|\/)grok(?:-|$)/u, provider: "grok" },
  { pattern: /(?:^|\/)deepseek(?:-|$)/u, provider: "deepseek" },
  { pattern: /(?:^|\/)gemini(?:-|$)/u, provider: "antigravity" },
];
/** Model ids of the makers that have no provider in this build. */
const OPEN_MAKERS: readonly { pattern: RegExp; id: OrbitMaker; name: string }[] = [
  { pattern: /(?:^|[/:_-])kimi(?:[-_.]|$)/u, id: "kimi", name: "Kimi" },
  { pattern: /(?:^|[/:_-])(?:glm|chatglm)(?:[-_.]|\d|$)/u, id: "glm", name: "GLM" },
  { pattern: /(?:^|[/:_-])(?:qwen|qwq)(?:[-_.]|\d|$)/u, id: "qwen", name: "Qwen" },
];

/**
 * The family of a model. A Claude tier wins wherever it runs, then the maker that the model id
 * names, then the provider. A provider that this build does not know is `other`. See the map in
 * `docs/architecture/team-orbits.md`.
 */
export function orbitFamily(provider: AgentProviderRef, model: string): OrbitFamily {
  const id = model.toLowerCase();
  const tier = TIER_PATTERN.exec(id)?.[1];
  if (isOrbitTier(tier)) return { id: tier, kind: "tier", name: TIER_NAMES[tier] };
  const maker = MODEL_MAKERS.find((entry) => entry.pattern.test(id))?.provider;
  if (maker) return { id: maker, kind: "provider", name: providerDisplayName(maker) };
  const open = OPEN_MAKERS.find((entry) => entry.pattern.test(id));
  if (open) return { id: open.id, kind: "maker", name: open.name };
  if (isKnownAgentProvider(provider)) return { id: provider, kind: "provider", name: providerDisplayName(provider) };
  return { id: "other", kind: "other", name: null };
}

function isOrbitTier(value: string | undefined): value is OrbitTier {
  return value === "opus" || value === "sonnet" || value === "haiku" || value === "fable";
}

/** The states that generate text or code now. The model filter counts these. */
export function orbitGenerates(state: OrbitState): boolean {
  return state === "working" || state === "speaking" || state === "thinking";
}

/** The waits that only the person can end. */
export function orbitWaitsForPerson(wait: OrbitWait | null): boolean {
  return wait === "question" || wait === "approval" || wait === "takeover";
}

/** The states that put an agent at the edge of its system, as a small dot. */
export function orbitParks(state: OrbitState): boolean {
  return state === "done" || state === "idle" || state === "failed";
}

/** The states that make a system show. A parked agent shows only beside an active one. */
function active(state: OrbitState): boolean {
  return !orbitParks(state);
}

/**
 * How much an agent needs attention, lowest first: a wait for the person, a stopped task, a message
 * that is written now, running work, thinking, another wait, a failed turn, done work, nothing.
 */
export function orbitAttentionRank(agent: Pick<OrbitAgent, "state" | "wait">) {
  if (agent.state === "waiting" && orbitWaitsForPerson(agent.wait)) return 0;
  switch (agent.state) {
    case "stalled":
      return 1;
    case "speaking":
      return 2;
    case "working":
      return 3;
    case "thinking":
      return 4;
    case "waiting":
      return 5;
    case "failed":
      return 6;
    case "done":
      return 7;
    default:
      return 8;
  }
}

/** The agents in attention order. The sort is stable, so equal agents keep the order given. */
export function orbitAttentionOrder<T extends Pick<OrbitAgent, "state" | "wait">>(agents: readonly T[]): T[] {
  return agents
    .map((agent, index) => ({ agent, index, rank: orbitAttentionRank(agent) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.agent);
}

/**
 * The agents that show a bubble: the first ones in attention order that have something to say and
 * match the model filter. Each system has one bubble at most, because its bubble takes the top of the
 * system: the next bubble goes to an agent of another system. A done or idle agent has no bubble.
 */
export function orbitBubbleIds(
  agents: readonly OrbitAgent[],
  systems: readonly Pick<OrbitSystem, "key" | "agentIds">[],
  family: string | null,
  limit = ORBIT_BUBBLE_LIMIT,
): string[] {
  const systemOf = new Map<string, string>();
  for (const system of systems) for (const agentId of system.agentIds) systemOf.set(agentId, system.key);
  const bubbles: string[] = [];
  const used = new Set<string>();
  const candidates = agents.filter((agent) => agent.says && active(agent.state) && orbitMatches(agent, family));
  for (const agent of orbitAttentionOrder(candidates)) {
    const key = systemOf.get(agent.id);
    if (key === undefined || used.has(key)) continue;
    used.add(key);
    bubbles.push(agent.id);
    if (bubbles.length >= limit) break;
  }
  return bubbles;
}

/** Whether an agent matches the model filter. No filter matches every agent. */
export function orbitMatches(agent: Pick<OrbitAgent, "family">, family: string | null): boolean {
  return family === null || agent.family.id === family;
}

/** The model filter after a tap on a family: the family, or no filter when it was already on. */
export function toggledOrbitFamily(current: string | null, family: string): string | null {
  return current === family ? null : family;
}

/**
 * The most animated elements at the same time. A continuous animation costs CPU on each frame (the
 * performance review measured it), so the agents that need attention most move, and the others hold
 * their place with the same colours.
 */
export const ORBIT_MOTION_BUDGET = 60;

/** The animated elements of one agent: its node, then the loops that its state draws. */
const MOTION_COST: Readonly<Record<OrbitState, number>> = {
  // The node on its orbit, two trail dots, the sparks and the racing arc.
  working: 5,
  // The soft pulse and the node.
  speaking: 2,
  thinking: 1,
  waiting: 1,
  stalled: 1,
  // A failed turn holds still: it can be old, and a loop would call for attention it may not need.
  failed: 0,
  done: 0,
  idle: 0,
};

/** The agents that animate, in attention order, until the budget is spent. */
export function orbitMotionIds(agents: readonly OrbitAgent[], budget = ORBIT_MOTION_BUDGET): Set<string> {
  const moving = new Set<string>();
  let left = budget;
  for (const agent of orbitAttentionOrder(agents)) {
    const cost = MOTION_COST[agent.state];
    if (cost === 0 || cost > left) continue;
    left -= cost;
    moving.add(agent.id);
  }
  return moving;
}

/** The counts of the panel's top line, for the agents that match the model filter. */
export function orbitCounts(agents: readonly OrbitAgent[], family: string | null) {
  const pool = agents.filter((agent) => orbitMatches(agent, family));
  const first = (test: (agent: OrbitAgent) => boolean) => orbitAttentionOrder(pool.filter(test))[0]?.id ?? null;
  const needsYou = (agent: OrbitAgent) => agent.state === "waiting" && orbitWaitsForPerson(agent.wait);
  const stalled = (agent: OrbitAgent) => agent.state === "stalled";
  return {
    generating: pool.filter((agent) => orbitGenerates(agent.state)).length,
    needsYou: pool.filter(needsYou).length,
    firstNeedsYou: first(needsYou),
    stalled: pool.filter(stalled).length,
    firstStalled: first(stalled),
  };
}

/** The channel work of each agent, from this computer's load. */
interface LoadIndex {
  running: Map<string, LoadSnapshot["running"][number]>;
  /** The stopped channel tasks, by agent, where the stopped task names its agent. */
  stopped: Map<string, LoadSnapshot["stopped"][number]>;
  waiting: Set<string>;
}

function indexLoad(load: LoadSnapshot | null, channels: readonly OrbitChannel[], agents: readonly OrbitAgentProfile[]) {
  const index: LoadIndex = { running: new Map(), stopped: new Map(), waiting: new Set() };
  if (!load) return index;
  for (const work of load.running) if (!index.running.has(work.agentId)) index.running.set(work.agentId, work);
  for (const work of load.waiting) index.waiting.add(work.agentId);
  // A stopped task names its agent by name only. The name finds the member of that channel.
  for (const work of load.stopped) {
    const channel = channels.find((entry) => entry.id === work.channelId);
    if (!channel || work.agentName === null) continue;
    const member = channel.members
      .map((entry) => agents.find((agent) => agent.id === entry.agentId))
      .find((agent) => agent?.name === work.agentName);
    if (member && !index.stopped.has(member.id)) index.stopped.set(member.id, work);
  }
  return index;
}

/** The channel where each agent writes a message now. */
function speakers(channels: readonly OrbitChannel[]): Map<string, OrbitChannel> {
  const writing = new Map<string, OrbitChannel>();
  for (const channel of channels) {
    const message = channel.lastMessage;
    if (message?.status !== "streaming" || !message.author || message.author.kind === "member") continue;
    if (!writing.has(message.author.id)) writing.set(message.author.id, channel);
  }
  return writing;
}

/** The leads that route a request: their channel runs a task, and no member shows that it works. */
function routingLeads(channels: readonly OrbitChannel[], generating: (agentId: string) => boolean): Set<string> {
  const leads = new Set<string>();
  for (const channel of channels) {
    if (channel.activeTasks <= 0 || !channel.leadAgentId) continue;
    if (!channel.members.some((member) => generating(member.agentId))) leads.add(channel.leadAgentId);
  }
  return leads;
}

function topicIdByName(channel: OrbitChannel | undefined, name: string | null): string | null {
  if (!channel || name === null) return null;
  return channel.topics?.find((topic) => topic.name === name)?.id ?? null;
}

function epochMs(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** The agent's state and its details, from the signals the sidebar reads and this computer's load. */
function describeAgents(input: OrbitsViewInput, profiles: readonly OrbitAgentProfile[]): Record<string, OrbitAgent> {
  const load = indexLoad(input.load, input.channels, profiles);
  const writing = speakers(input.channels);
  const channelById = new Map(input.channels.map((channel) => [channel.id, channel]));
  const working = (agentId: string) =>
    isAgentWorking(agentId, input.activeTurns, input.queues) || load.running.has(agentId);
  /** A turn that the provider starts now: nothing of it runs yet. */
  const starting = (agentId: string) => {
    const queue = input.queues[agentId];
    const deliveries = queue?.deliveries ?? [];
    return (
      deliveries.some((delivery) => delivery.status === "starting") &&
      !deliveries.some((delivery) => delivery.status === "running") &&
      !input.activeTurns[agentId] &&
      queue?.hold?.agentId !== agentId &&
      !load.running.has(agentId)
    );
  };
  const routing = routingLeads(input.channels, (agentId) => working(agentId) || writing.has(agentId));
  const agents: Record<string, OrbitAgent> = {};
  for (const profile of profiles) {
    const id = profile.id;
    const wait = input.waits[id];
    const running = load.running.get(id);
    const stopped = load.stopped.get(id);
    const queue = input.queues[id];
    const deliveries = queue?.deliveries ?? [];
    const step = input.turnSteps[id]?.detail.trim() || null;
    const speakingIn = writing.get(id);
    const holdChannel = queue?.hold?.agentId === id ? queue.hold.channelId : null;
    const agent: OrbitAgent = {
      id,
      name: profile.name,
      title: profile.title,
      avatarSeed: profile.avatarSeed,
      avatarHue: profile.avatarHue,
      avatarUrl: profile.avatarUrl,
      family: orbitFamily(profile.provider, profile.model),
      state: "idle",
      wait: null,
      task: running?.title.trim() || step,
      stopReason: null,
      says: null,
      startedAt: running ? epochMs(running.startedAt) : null,
      resetsAt: null,
      place: null,
    };
    const channelId = running?.channelId ?? holdChannel ?? speakingIn?.id ?? stopped?.channelId ?? null;
    if (channelId) {
      agent.place = { channelId, topicId: topicIdByName(channelById.get(channelId), running?.topicName ?? null) };
    }
    if (wait?.kind === "waiting") {
      agent.state = "waiting";
      agent.wait = wait.reason;
      agent.says = wait.detail;
      agent.task = wait.detail ?? agent.task;
    } else if (speakingIn) {
      agent.state = "speaking";
      agent.says = speakingIn.lastMessage?.text.trim() || null;
    } else if (starting(id) || routing.has(id)) {
      agent.state = "thinking";
    } else if (working(id)) {
      agent.state = "working";
    } else if (stopped) {
      agent.state = "stalled";
      agent.task = stopped.title.trim() || agent.task;
      agent.stopReason = stopped.reason.trim() || null;
    } else if (wait?.kind === "limited") {
      agent.state = "waiting";
      agent.wait = "limit";
      agent.resetsAt = wait.resetsAt;
    } else if (
      load.waiting.has(id) ||
      deliveries.some((delivery) => delivery.sender.kind === "routine" && delivery.status === "queued")
    ) {
      agent.state = "waiting";
      agent.wait = "turn";
    } else if (input.failedTurns[id]) {
      agent.state = "failed";
    } else if (input.recentReplies[id] || (input.unreadReplies[id] ?? 0) > 0) {
      agent.state = "done";
    }
    agents[id] = agent;
  }
  return agents;
}

/** The place of each chat in the sidebar: its section in section order, then its row. */
function sidebarOrder(layout: OrbitsViewInput["layout"]): (chatId: string) => [number, number] {
  const sectionIndex = new Map(layout.order.map((sectionId, index) => [sectionId, index]));
  const rowIndex = new Map(layout.agentOrder.map((chatId, index) => [chatId, index]));
  const unassigned = sectionIndex.get(SIDEBAR_UNASSIGNED_SECTION_ID) ?? layout.order.length;
  return (chatId) => [
    sectionIndex.get(layout.agentAssignments[chatId] ?? SIDEBAR_UNASSIGNED_SECTION_ID) ?? unassigned,
    rowIndex.get(chatId) ?? Number.MAX_SAFE_INTEGER,
  ];
}

function bySidebarOrder<T>(items: readonly T[], id: (item: T) => string, order: (chatId: string) => [number, number]) {
  return [...items].sort((left, right) => {
    const [leftSection, leftRow] = order(id(left));
    const [rightSection, rightRow] = order(id(right));
    return leftSection - rightSection || leftRow - rightRow;
  });
}

/**
 * Puts each agent in one system. A lead stays the sun of the first channel it leads that has work,
 * so a channel keeps its center. Another member goes to the channel where its work is, else to its
 * first channel with work, else to its first channel. An agent in no channel goes to the system of
 * its sidebar section, but only while it is active: a section of idle agents would only add dots.
 */
function placeAgents(
  input: OrbitsViewInput,
  agents: Record<string, OrbitAgent>,
  channels: readonly OrbitChannel[],
  order: (chatId: string) => [number, number],
): OrbitSystem[] {
  const members = (channel: OrbitChannel) =>
    channel.members.map((member) => member.agentId).filter((agentId) => agents[agentId] !== undefined);
  const hasWork = (channel: OrbitChannel) =>
    members(channel).some((agentId) => {
      const agent = agents[agentId];
      return (
        agent !== undefined && active(agent.state) && (agent.place === null || agent.place.channelId === channel.id)
      );
    });
  const home = new Map<string, string>();
  const ledBy = (agentId: string) =>
    channels.filter((channel) => channel.leadAgentId === agentId && members(channel).includes(agentId));
  for (const agentId of Object.keys(agents)) {
    const led = ledBy(agentId);
    const own = channels.filter((channel) => members(channel).includes(agentId));
    const place = agents[agentId]?.place?.channelId;
    const pick =
      led.find((channel) => channel.id === place) ??
      led.find(hasWork) ??
      led[0] ??
      own.find((channel) => channel.id === place) ??
      own.find(hasWork) ??
      own[0];
    if (pick) home.set(agentId, pick.id);
  }

  const systems: OrbitSystem[] = [];
  for (const channel of channels) {
    const placed = members(channel).filter((agentId) => home.get(agentId) === channel.id);
    if (!placed.some((agentId) => active(agents[agentId]?.state ?? "idle"))) continue;
    const lead = channel.leadAgentId && placed.includes(channel.leadAgentId) ? channel.leadAgentId : null;
    systems.push({
      key: `channel:${channel.id}`,
      kind: "channel",
      targetId: channel.id,
      name: channel.title.trim() || channel.name,
      color: hueOf(agents[lead ?? placed[0] ?? ""]),
      sunId: lead ?? placed[0] ?? null,
      agentIds: lead ? [lead, ...placed.filter((agentId) => agentId !== lead)] : placed,
    });
  }

  const loose = bySidebarOrder(
    Object.values(agents).filter((agent) => !home.has(agent.id) && active(agent.state)),
    (agent) => agent.id,
    order,
  );
  const bySection = new Map<string, string[]>();
  for (const agent of loose) {
    const sectionId = input.layout.agentAssignments[agent.id] ?? SIDEBAR_UNASSIGNED_SECTION_ID;
    bySection.set(sectionId, [...(bySection.get(sectionId) ?? []), agent.id]);
  }
  const sectionSystems = [...bySection].map(([sectionId, agentIds]): OrbitSystem => {
    const section = input.layout.sections.find((entry) => entry.id === sectionId);
    return {
      key: `section:${sectionId}`,
      kind: "section",
      targetId: sectionId,
      name: section?.name.trim() || input.unassignedName,
      color: section?.color ?? hueOf(agents[agentIds[0] ?? ""]),
      sunId: agentIds[0] ?? null,
      agentIds,
    };
  });
  // Channels first, then sections, each in sidebar order: a system keeps its place while its agents change.
  const sectionRank = (system: OrbitSystem) => order(system.agentIds[0] ?? "")[0];
  return [
    ...bySidebarOrder(systems, (system) => system.targetId, order),
    ...sectionSystems.sort((left, right) => sectionRank(left) - sectionRank(right)),
  ];
}

/** The colour of the hue that the person picked for the agent. An agent with no hue gives none. */
function hueOf(agent: OrbitAgent | undefined): string | null {
  return agent && agent.avatarHue !== null ? avatarMarkAccent(agent.avatarHue) : null;
}

function linksOf(queues: OrbitsViewInput["queues"], shown: ReadonlySet<string>): OrbitLink[] {
  const links: OrbitLink[] = [];
  const seen = new Set<string>();
  for (const queue of Object.values(queues)) {
    for (const delivery of queue.deliveries) {
      if (delivery.sender.kind !== "agent") continue;
      if (delivery.status !== "queued" && delivery.status !== "starting" && delivery.status !== "running") continue;
      const from = delivery.sender.agentId;
      const to = queue.agentId;
      const key = `${from}\n${to}`;
      if (from === to || seen.has(key) || !shown.has(from) || !shown.has(to)) continue;
      seen.add(key);
      links.push({ from, to });
      if (links.length >= ORBIT_LINK_LIMIT) return links;
    }
  }
  return links;
}

/** The Claude tiers first, from the largest model, then the other families by name, then `other`. */
function familyRank(family: OrbitFamily): number {
  switch (family.kind) {
    case "tier":
      return TIER_ORDER.indexOf(family.id);
    case "other":
      return TIER_ORDER.length + 1;
    default:
      return TIER_ORDER.length;
  }
}

/** The families of the shown agents, in a fixed order: a mark does not move while the work changes. */
function familyCounts(agents: readonly OrbitAgent[]): OrbitFamilyCount[] {
  const counts = new Map<string, OrbitFamilyCount>();
  for (const agent of agents) {
    const entry = counts.get(agent.family.id) ?? { family: agent.family, shown: 0, generating: 0 };
    entry.shown += 1;
    if (orbitGenerates(agent.state)) entry.generating += 1;
    counts.set(agent.family.id, entry);
  }
  return [...counts.values()].sort(
    (left, right) =>
      familyRank(left.family) - familyRank(right.family) ||
      (left.family.name ?? "").localeCompare(right.family.name ?? ""),
  );
}

/**
 * The model marks at the top of the panel: the families that generate now, and the family of the
 * filter while it is on, so the person can always clear the filter. The order is that of `families`.
 */
export function orbitFamilyChips(families: readonly OrbitFamilyCount[], family: string | null): OrbitFamilyCount[] {
  return families.filter((entry) => entry.generating > 0 || entry.family.id === family);
}

/** The whole panel, from the signals of the sidebar and this computer's load. */
export function orbitsView(input: OrbitsViewInput): OrbitsView {
  const profiles = input.agents.filter((agent) => !input.hiddenAgentIds?.has(agent.id));
  const all = describeAgents(input, profiles);
  const order = sidebarOrder(input.layout);
  const channels = bySidebarOrder(
    input.channels.filter((channel) => !channel.archived),
    (channel) => channel.id,
    order,
  );
  const systems = placeAgents(input, all, channels, order);
  const shownIds = new Set(systems.flatMap((system) => system.agentIds));
  const agents: Record<string, OrbitAgent> = {};
  for (const agentId of shownIds) {
    const agent = all[agentId];
    if (agent) agents[agentId] = agent;
  }
  return {
    systems,
    agents,
    links: linksOf(input.queues, shownIds),
    families: familyCounts(Object.values(agents)),
  };
}
