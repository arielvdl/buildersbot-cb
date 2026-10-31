import type { AgentProviderRef } from "@openbot/contracts/agent-providers";
import {
  type AvatarHue,
  DEFAULT_TASK_WATCH_PREFERENCE,
  type LoadSnapshot,
  type QueueDelivery,
  type QueueSnapshot,
  SIDEBAR_PEOPLE_SECTION_ID,
  SIDEBAR_UNASSIGNED_SECTION_ID,
} from "@openbot/contracts/ipc";
import type { OrbitAgentProfile, OrbitChannel, OrbitsViewInput } from "@openbot/ui/features/orbits/orbits-view";

/**
 * The signals of a busy workspace, as the sidebar and the load panel read them, for the Team panel
 * story and `scripts/team-orbits-smoke.ts`. The states follow the approved mockup (`v10-orbitas`);
 * the names are neutral. `orbitsView` turns them into the panel, as the app does.
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
  agent("lider-produto", "Líder Produto", "Líder", OPUS, 185),
  agent("backend", "Backend", "Backend", OPUS, 185),
  agent("automacao", "Automação", "Automação", SONNET, 185),
  agent("front", "Front", "Frontend", OPUS, 185),
  agent("front-fluxos", "Front Fluxos", "Frontend", OPUS, 185),
  agent("design", "Design", "Design", SONNET, 185),
  agent("qa", "QA", "QA", SONNET, 185),
  agent("lider-seguranca", "Líder Segurança", "Líder", OPUS, 0),
  agent("red-team", "Red Team", "Ataque", OPUS, 0),
  agent("auditor", "Auditor", "Auditoria", SONNET, 0),
  agent("lider-release", "Líder Release", "Líder", OPUS, 215),
  agent("release-bot", "Release Bot", "Release", HAIKU, 215),
  agent("roteirista", "Roteirista", "Líder", OPUS, 280),
  agent("editor", "Editor", "Edição", SONNET, 280),
  agent("narrador", "Narrador", "Voz", HAIKU, 280),
  agent("triagem", "Triagem", "Líder", SONNET, 55),
  agent("registro", "Registro", "Registro", HAIKU, 55),
  agent("pesquisa", "Pesquisa", "Pesquisa", "grok-4.6", 100, "grok"),
  agent("revisor", "Revisor", "Revisão", "gpt-6-luna", 150, "codex"),
  agent("tradutor", "Tradutor", "Tradução", "moonshotai/kimi-k3", 320, "openrouter"),
  agent("arquivista", "Arquivista", "Arquivo", HAIKU, null),
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
    "produto",
    "produto",
    "Produto",
    "lider-produto",
    ["backend", "automacao", "front", "front-fluxos", "design", "qa"],
    {
      lastMessage: streaming(
        "lider-produto",
        "Líder Produto",
        "Distribuí mais frentes para agilizar. O Front assume o cadastro v2.1.",
      ),
    },
  ),
  channel("seguranca", "seguranca", "Segurança", "lider-seguranca", ["red-team", "auditor"], {
    lastMessage: streaming(
      "lider-seguranca",
      "Líder Segurança",
      "Os três PRs passaram: #99 e #100 corrigiram o upload, #101 o CORS.",
    ),
  }),
  channel("release", "release", "Release", "lider-release", ["release-bot"]),
  channel("videos", "videos", "Vídeos", "roteirista", ["editor", "narrador"]),
  channel("bugs", "bugs", "Bugs", "triagem", ["registro"]),
  channel("marketing", "marketing", "Marketing", "arquivista", [], { activeTasks: 0 }),
];

export const ORBITS_LAYOUT: OrbitsViewInput["layout"] = {
  order: [SIDEBAR_PEOPLE_SECTION_ID, "times", "pessoal", SIDEBAR_UNASSIGNED_SECTION_ID],
  sections: [
    // A coloured section: its channels still take the hue of their leads.
    { id: "times", name: "Times", color: "#a855f7" },
    { id: "pessoal", name: "Pessoal" },
  ],
  agentAssignments: {
    produto: "times",
    seguranca: "times",
    release: "times",
    videos: "times",
    bugs: "times",
    marketing: "times",
    pesquisa: "pessoal",
    revisor: "pessoal",
    tradutor: "pessoal",
  },
  agentOrder: ["produto", "seguranca", "release", "videos", "bugs", "marketing", "pesquisa", "revisor", "tradutor"],
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
  backend: queue("backend", [], "produto"),
  automacao: queue("automacao", [], "produto"),
  auditor: queue("auditor", [delivery("auditor", "queued", { kind: "agent", agentId: "backend" })], "seguranca"),
  design: queue("design", [delivery("design", "starting", { kind: "user" })]),
  roteirista: queue("roteirista", [delivery("roteirista", "starting", { kind: "user" })]),
  "release-bot": queue("release-bot", [], "release"),
  "lider-release": queue("lider-release", [], "release"),
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
    run("backend", "Backend", "produto", "Lado do servidor da v2.1 do cadastro em chat", 12),
    run("automacao", "Automação", "produto", "Retomar as 8 ferramentas do cadastro em chat", 31),
    run("auditor", "Auditor", "seguranca", "Varrendo 312 pacotes contra a base de CVEs", 7),
    run("lider-release", "Líder Release", "release", "Release 1.4.0", 18),
    run("release-bot", "Release Bot", "release", "Assinando o pacote do macOS", 4),
    run("editor", "Editor", "videos", "Montando a cena 3 de 9", 22),
    run("triagem", "Triagem", "bugs", "Contagem de citações: 9 tamanhos não batem", 9),
  ],
  waiting: [
    { agentId: "front", agentName: "Front" },
    { agentId: "tradutor", agentName: "Tradutor" },
  ],
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
  // "Resume by itself" is off, so the task reviewer does not look.
  taskWatch: { ...DEFAULT_TASK_WATCH_PREFERENCE, active: false, modelReady: false, recent: [] },
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
    revisor: { kind: "limited", resetsAt: Math.round(ORBITS_NOW / 1000) + 3 * 3600 },
  },
  activeTurns: { pesquisa: "turn-pesquisa" },
  queues: ORBITS_QUEUES,
  // An old failed turn: a still mark beside the work of its channel.
  failedTurns: { qa: "turn-qa-old" },
  recentReplies: { "front-fluxos": true },
  unreadReplies: {},
  turnSteps: {
    triagem: { turnId: "turn-triagem", detail: "Lendo o contador de citações" },
    pesquisa: { turnId: "turn-pesquisa", detail: "Buscando as notícias de hoje" },
  },
  load: ORBITS_LOAD,
};

/** The same workspace on a joined server: no load, so no request titles, times or stopped tasks. */
export const ORBITS_REMOTE_INPUT: OrbitsViewInput = { ...ORBITS_INPUT, load: null };

/** A workspace where nothing runs. An old failed turn does not make its channel show. */
export const ORBITS_QUIET_INPUT: OrbitsViewInput = {
  ...ORBITS_INPUT,
  channels: ORBITS_CHANNELS.map((entry) => ({ ...entry, activeTasks: 0, lastMessage: null })),
  waits: {},
  activeTurns: {},
  queues: {},
  failedTurns: { qa: "turn-qa-old", narrador: "turn-narrador-old" },
  recentReplies: {},
  turnSteps: {},
  load: null,
};

const withoutKey = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));

/** The busy workspace after the Backend agent finished: its work left the load, and it has a reply. */
export const ORBITS_BACKEND_DONE_INPUT: OrbitsViewInput = {
  ...ORBITS_INPUT,
  queues: withoutKey(ORBITS_QUEUES, "backend"),
  recentReplies: { ...ORBITS_INPUT.recentReplies, backend: true },
  load: { ...ORBITS_LOAD, running: ORBITS_LOAD.running.filter((work) => work.agentId !== "backend") },
};

/** The busy workspace after the Bugs channel and the Pesquisa agent stopped: their systems leave. */
export const ORBITS_BUGS_GONE_INPUT: OrbitsViewInput = {
  ...ORBITS_INPUT,
  channels: ORBITS_CHANNELS.map((entry) => (entry.id === "bugs" ? { ...entry, activeTasks: 0 } : entry)),
  queues: withoutKey(ORBITS_QUEUES, "triagem"),
  activeTurns: {},
  load: { ...ORBITS_LOAD, running: ORBITS_LOAD.running.filter((work) => work.agentId !== "triagem") },
};

/** Two agents of the Produto channel ask the person, while its lead writes a message. */
export const ORBITS_TWO_ASK_INPUT: OrbitsViewInput = {
  ...ORBITS_INPUT,
  waits: {
    ...ORBITS_INPUT.waits,
    front: { kind: "waiting", reason: "approval", detail: "Posso apagar a pasta build antes do teste?" },
    qa: { kind: "waiting", reason: "question", detail: "Rodo os testes de ponta a ponta agora?" },
  },
};
