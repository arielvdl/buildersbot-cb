import type { AgentProviderRef } from "@openbot/contracts/agent-providers";
import {
  type AvatarHue,
  type LoadSnapshot,
  type QueueDelivery,
  type QueueSnapshot,
  SIDEBAR_PEOPLE_SECTION_ID,
  SIDEBAR_UNASSIGNED_SECTION_ID,
} from "@openbot/contracts/ipc";
import type { OrbitAgentProfile, OrbitChannel, OrbitsViewInput } from "@openbot/ui/features/orbits/orbits-view";

/**
 * The signals of a busy workspace, as the sidebar and the load panel read them, for the Team panel
 * story and `scripts/team-orbits-smoke.ts`. The names and the states follow the approved mockup
 * (`v10-orbitas`). `orbitsView` turns them into the panel, as the app does.
 */

/** The fixed time of the fixtures, so the elapsed minutes do not change. */
export const ORBITS_NOW = Date.parse("2026-10-31T17:24:00.000Z");
const minutesAgo = (minutes: number) => new Date(ORBITS_NOW - minutes * 60_000).toISOString();

function agent(
  id: string,
  name: string,
  title: string,
  model: string,
  hue: AvatarHue | null,
  provider: AgentProviderRef = "claude",
): OrbitAgentProfile {
  return { id, name, title, provider, model, avatarSeed: id, avatarHue: hue, avatarUrl: null };
}

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

export const ORBITS_AGENTS: OrbitAgentProfile[] = [
  agent("lider-opus", "Lider Opus", "Líder", OPUS, 185),
  agent("backend-ia-naia", "Backend IA Naia", "Backend", OPUS, 185),
  agent("automacao-ia-naia", "Automação IA Naia", "Automação", SONNET, 185),
  agent("front-naia", "Front Naia", "Frontend", OPUS, 185),
  agent("front-fluxos-naia", "Front Fluxos Naia", "Frontend", OPUS, 185),
  agent("design-advisor", "Design Advisor", "Design", SONNET, 185),
  agent("qa-naia", "QA Naia", "QA", SONNET, 185),
  agent("lider-seguranca", "Lider Segurança", "Líder", OPUS, 0),
  agent("red-team", "Red Team", "Ataque", OPUS, 0),
  agent("auditor-deps", "Auditor de dependências", "Auditoria", SONNET, 0),
  agent("builder-studio", "builder studio", "Líder", OPUS, 215),
  agent("release-bot", "Release Bot", "Release", HAIKU, 215),
  agent("roteirista", "Roteirista", "Líder", OPUS, 280),
  agent("editor", "Editor", "Edição", SONNET, 280),
  agent("narrador", "Narrador", "Voz", HAIKU, 280),
  agent("triagem", "Triagem", "Líder", SONNET, 55),
  agent("apontamentos", "Apontamentos da Vanessa", "Registro", HAIKU, 55),
  agent("pesquisa-grok", "Pesquisa Grok", "Pesquisa", "grok-4.6", 100, "grok"),
  agent("revisor-codex", "Revisor Codex", "Revisão", "gpt-6-luna", 150, "codex"),
  agent("ocioso", "Arquivista", "Arquivo", HAIKU, null),
];

function channel(
  id: string,
  name: string,
  title: string,
  lead: string,
  members: string[],
  extra: Partial<OrbitChannel> = {},
): OrbitChannel {
  return {
    id,
    name,
    title,
    archived: false,
    leadAgentId: lead,
    members: [lead, ...members].map((agentId) => ({ agentId })),
    activeTasks: 1,
    lastMessage: null,
    topics: [{ id: `${id}-main`, channelId: id, name: "Main", createdAt: minutesAgo(600), revision: 1 }],
    ...extra,
  };
}

function streaming(authorId: string, authorName: string, text: string): OrbitChannel["lastMessage"] {
  return { authorName, author: { kind: "agent", id: authorId }, status: "streaming", text, at: minutesAgo(0) };
}

export const ORBITS_CHANNELS: OrbitChannel[] = [
  channel(
    "naia",
    "naia-novas-features",
    "Naia",
    "lider-opus",
    ["backend-ia-naia", "automacao-ia-naia", "front-naia", "front-fluxos-naia", "design-advisor", "qa-naia"],
    {
      lastMessage: streaming(
        "lider-opus",
        "Lider Opus",
        "Distribuí mais frentes para agilizar. O Front Naia assume o cadastro v2.1.",
      ),
    },
  ),
  channel("seguranca", "seguranca", "Segurança", "lider-seguranca", ["red-team", "auditor-deps"], {
    lastMessage: streaming(
      "lider-seguranca",
      "Lider Segurança",
      "Os três PRs passaram: #99 e #100 corrigiram o upload, #101 o CORS.",
    ),
  }),
  channel("studio", "builders-studio", "Studio", "builder-studio", ["release-bot"]),
  channel("videos", "videos", "Vídeos", "roteirista", ["editor", "narrador"]),
  channel("bugs", "bugs", "Bugs", "triagem", ["apontamentos"]),
  channel("marketing", "marketing", "Marketing", "ocioso", [], { activeTasks: 0 }),
];

export const ORBITS_LAYOUT: OrbitsViewInput["layout"] = {
  order: [SIDEBAR_PEOPLE_SECTION_ID, "times", "pessoal", SIDEBAR_UNASSIGNED_SECTION_ID],
  sections: [
    { id: "times", name: "Times" },
    { id: "pessoal", name: "Pessoal" },
  ],
  agentAssignments: {
    naia: "times",
    seguranca: "times",
    studio: "times",
    videos: "times",
    bugs: "times",
    marketing: "times",
    "pesquisa-grok": "pessoal",
    "revisor-codex": "pessoal",
  },
  agentOrder: ["naia", "seguranca", "studio", "videos", "bugs", "marketing", "pesquisa-grok", "revisor-codex"],
};

let deliveryCount = 0;
function delivery(
  recipientAgentId: string,
  status: QueueDelivery["status"],
  sender: QueueDelivery["sender"],
): QueueDelivery {
  deliveryCount += 1;
  return {
    id: `delivery-${deliveryCount}`,
    messageId: `message-${deliveryCount}`,
    recipientAgentId,
    sender,
    text: "",
    attachments: [],
    replyToMessageId: null,
    status,
    position: status === "queued" ? 1 : null,
    turnId: status === "running" ? `turn-${recipientAgentId}` : null,
    error: null,
    createdAt: minutesAgo(5),
  };
}

function queue(agentId: string, deliveries: QueueDelivery[], holdChannel?: string): QueueSnapshot {
  return {
    agentId,
    deliveries,
    ...(holdChannel
      ? { hold: { reason: "channel-task" as const, channelId: holdChannel, channelName: holdChannel, agentId } }
      : {}),
  };
}

export const ORBITS_QUEUES: Record<string, QueueSnapshot> = {
  "backend-ia-naia": queue("backend-ia-naia", [], "naia"),
  "automacao-ia-naia": queue("automacao-ia-naia", [], "naia"),
  "auditor-deps": queue(
    "auditor-deps",
    [delivery("auditor-deps", "queued", { kind: "agent", agentId: "backend-ia-naia" })],
    "seguranca",
  ),
  "design-advisor": queue("design-advisor", [delivery("design-advisor", "starting", { kind: "user" })]),
  roteirista: queue("roteirista", [delivery("roteirista", "starting", { kind: "user" })]),
  "release-bot": queue("release-bot", [], "studio"),
  "builder-studio": queue("builder-studio", [], "studio"),
  editor: queue("editor", [delivery("editor", "queued", { kind: "agent", agentId: "roteirista" })], "videos"),
  triagem: queue("triagem", [], "bugs"),
};

export const ORBITS_LOAD: LoadSnapshot = {
  sampledAt: minutesAgo(0),
  memory: { usedMb: 6200, agentsMb: 4100, totalMb: 16384 },
  activeAgents: 7,
  providerProcesses: 9,
  lane: { enabled: false, order: [], running: [], queued: [] },
  running: [
    run("backend-ia-naia", "Backend IA Naia", "naia", "Lado do servidor da v2.1 do cadastro em chat", 12),
    run("automacao-ia-naia", "Automação IA Naia", "naia", "Retomar as 8 ferramentas do cadastro em chat", 31),
    run("auditor-deps", "Auditor de dependências", "seguranca", "Varrendo 312 pacotes contra o cve.now", 7),
    run("builder-studio", "builder studio", "studio", "Release 0.56.0", 18),
    run("release-bot", "Release Bot", "studio", "Assinando o pacote do macOS", 4),
    run("editor", "Editor", "videos", "Montando a cena 3 de 9", 22),
    run("triagem", "Triagem", "bugs", "Contagem de citações: 9 tamanhos não batem", 9),
  ],
  waiting: [{ agentId: "front-naia", agentName: "Front Naia" }],
  stopped: [
    {
      channelId: "videos",
      channelName: "videos",
      topicName: "Main",
      taskId: "task-voz",
      title: "Gerando a voz do episódio",
      reason: "O provedor de voz não respondeu.",
      agentName: "Narrador",
      state: "failed",
      candidates: [],
      auto: null,
    },
  ],
  recovery: { enabled: false, intervalMinutes: 30, reassign: false, recent: [] },
  agentLimit: { enabled: true, max: 7 },
};

function run(agentId: string, agentName: string, channelId: string, title: string, minutes: number) {
  return {
    turnId: `turn-${agentId}`,
    agentId,
    agentName,
    channelId,
    channelName: channelId,
    topicName: "Main",
    taskId: `task-${agentId}`,
    title,
    startedAt: minutesAgo(minutes),
  };
}

/** The busy workspace on this computer. */
export const ORBITS_INPUT: OrbitsViewInput = {
  agents: ORBITS_AGENTS,
  channels: ORBITS_CHANNELS,
  layout: ORBITS_LAYOUT,
  unassignedName: "Agents",
  waits: {
    "red-team": {
      kind: "waiting",
      reason: "question",
      detail: "Posso rodar o teste de injeção no chat público agora?",
    },
    "revisor-codex": { kind: "limited", resetsAt: Math.round(ORBITS_NOW / 1000) + 3 * 3600 },
  },
  activeTurns: { "pesquisa-grok": "turn-grok" },
  queues: ORBITS_QUEUES,
  failedTurns: {},
  recentReplies: { "front-fluxos-naia": true },
  unreadReplies: {},
  turnSteps: {
    triagem: { turnId: "turn-triagem", detail: "Lendo o contador de citações" },
    "pesquisa-grok": { turnId: "turn-grok", detail: "Buscando as notícias de hoje" },
  },
  load: ORBITS_LOAD,
};

/** The same workspace on a joined server: no load, so no request titles, times or stopped tasks. */
export const ORBITS_REMOTE_INPUT: OrbitsViewInput = { ...ORBITS_INPUT, load: null };

/** A workspace where nothing runs. */
export const ORBITS_QUIET_INPUT: OrbitsViewInput = {
  ...ORBITS_INPUT,
  channels: ORBITS_CHANNELS.map((entry) => ({ ...entry, activeTasks: 0, lastMessage: null })),
  waits: {},
  activeTurns: {},
  queues: {},
  recentReplies: {},
  turnSteps: {},
  load: null,
};
