import {
  FEED_ACTION_VERSION,
  FEED_CONTRACT_VERSION,
  FEED_DELTA_LIMIT,
  type FeedAction,
  type FeedActionFailure,
  type FeedActionInput,
  type FeedActionResult,
  type FeedDelta,
  type FeedDesktopApi,
  type FeedItem,
  type FeedItemState,
  type FeedNeed,
  type FeedStep,
} from "@openbot/contracts/ipc";
import type { Listener } from "./mock-support";

/**
 * The feed of the preview and the stories: cards made from fixed lists, with the states of the
 * prototype the owner chose, so a story with 40 or 5,000 cards reads the same each time. A `live`
 * feed adds a card and moves another every `intervalMs`, as main sends deltas.
 */
export interface MockFeedOptions {
  /** The cards when the page opens. 40 by default. */
  items?: FeedItem[] | number;
  /** The agents of the generated cards. The agents of `MOCK_FEED_AGENTS` by default. */
  agents?: ReadonlyArray<MockFeedAgent> | undefined;
  /** Adds and changes cards on a timer, as a busy workspace does. */
  live?: { intervalMs: number } | undefined;
  /** How long an action takes before main answers. 250 ms by default, so the waiting state shows. */
  actionDelayMs?: number | undefined;
}

/** A card whose id has this mark refuses every action, as main does when the card changed meanwhile. */
export const MOCK_FEED_REFUSES = ":refuses:";

/** The fixed time of the fixtures, so the times on the cards do not change. */
export const MOCK_FEED_NOW = Date.parse("2026-11-02T14:30:00.000Z");

const PROJECTS = [
  { id: "section-hub", name: "Hub" },
  { id: "section-site", name: "Site" },
  { id: "section-video", name: "iMasters" },
  { id: "section-geo", name: "naia" },
  null,
] as const;

export interface MockFeedAgent {
  id: string;
  name: string;
  /** An index into the fixture projects. */
  project: number;
}

export const MOCK_FEED_AGENTS: readonly MockFeedAgent[] = [
  { id: "lider", name: "Líder Opus", project: 0 },
  { id: "editor", name: "Editor iMasters", project: 2 },
  { id: "validador", name: "Validador iMasters", project: 2 },
  { id: "radar", name: "Radar iMasters", project: 2 },
  { id: "red-team", name: "Red Team Lead", project: 0 },
  { id: "dev", name: "Dev Builders", project: 0 },
  { id: "geo", name: "Analista GEO", project: 3 },
  { id: "publicador", name: "Publicador", project: 1 },
  { id: "front", name: "Front Site", project: 1 },
  { id: "pesquisa", name: "Pesquisa", project: 4 },
  { id: "suporte", name: "Suporte", project: 4 },
  { id: "dados", name: "Dados", project: 3 },
];

const TITLES = [
  "Deploy do Hub (hub-prod-02)",
  "Citações da marca no ChatGPT e no Perplexity",
  "Revisão do Worker de login",
  "Contrato de eventos remotos v3",
  "Roteiro do episódio de terça",
  "Thumbnail em inglês do especial",
  "Legendas em três línguas",
  "Página de preços nova",
  "Relatório semanal de GEO",
  "Migração do banco para o RDS",
  "",
  "Conferir pronúncia do roteiro",
] as const;

const STEPS = [
  "Lendo o contexto da tarefa",
  "Planejando os próximos passos",
  "Rodando um comando",
  "Revisando o resultado",
  "Editando arquivos",
  "Buscando na web",
  "Escrevendo a resposta",
  "Rodando os testes",
] as const;

/** Most runs ended; a few work, wait, stopped or need the person, as in a normal day. */
const STATES: readonly FeedItemState[] = [
  "done",
  "done",
  "done",
  "working",
  "done",
  "needs-you",
  "done",
  "working",
  "failed",
  "needs-you",
  "stopped",
  "waiting",
  "done",
  "working",
];

function pick<T>(list: readonly T[], index: number): T {
  const value = list[index % list.length];
  if (value === undefined) throw new Error("A fixture list is empty.");
  return value;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

/** One card of the fixtures. `index` 0 is the oldest. */
export function mockFeedItem(
  index: number,
  total: number,
  now = MOCK_FEED_NOW,
  agents: readonly MockFeedAgent[] = MOCK_FEED_AGENTS,
): FeedItem {
  const agent = pick(agents, index * 7);
  const project = PROJECTS[agent.project] ?? null;
  // The newest runs are the open ones.
  const fromEnd = total - 1 - index;
  const state = fromEnd < 14 ? pick(STATES, fromEnd) : index % 11 === 0 ? "failed" : "done";
  const started = now - (fromEnd + 1) * 90_000;
  const stepCount = 1 + (index % 9);
  const steps: FeedStep[] = Array.from({ length: Math.min(stepCount, 20) }, (_, step) => ({
    at: iso(started + (step + 1) * 7_000),
    kind: "progress",
    text: pick(STEPS, index + step),
  }));
  const open = state === "working" || state === "needs-you" || state === "waiting";
  const updated = open ? now - (fromEnd % 3) * 20_000 : started + stepCount * 7_000;
  const need = state === "needs-you" ? mockNeed(fromEnd, index, iso(updated)) : null;
  const stopped = state === "stopped";
  return {
    v: FEED_CONTRACT_VERSION,
    id: stopped ? `local:task:task-${index}` : `local:t:${agent.id}:thread-${index}`,
    serverId: "local",
    agentId: agent.id,
    agentName: agent.name,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    threadId: stopped ? null : `thread-${index}`,
    channelId: stopped ? "channel-ops" : null,
    taskId: stopped ? `task-${index}` : null,
    title: pick(TITLES, index * 5),
    state,
    startedAt: iso(started),
    updatedAt: iso(updated),
    endedAt: open ? null : iso(updated),
    lastStep: steps.at(-1) ?? null,
    steps,
    stepCount,
    need,
    stop:
      state === "stopped"
        ? { reason: "O provedor não começou esta tarefa.", source: "stopped-work" }
        : state === "failed"
          ? { reason: "A execução terminou com erro.", source: "error" }
          : null,
    ...(state === "waiting" ? { queued: 2 } : {}),
    ...(state === "working" && fromEnd === 13 ? { quiet: { state: "slow" as const, minutes: 16 } } : {}),
    ...(stopped ? { reassignTo: mockCandidates(agents, agent.id) } : {}),
    actions: mockActions(state, need, stopped),
    revision: stepCount,
  };
}

/** What waits on a card that needs the person: a command, a question of the Guard, or a question. */
function mockNeed(fromEnd: number, index: number, since: string): FeedNeed {
  if (fromEnd === 5)
    return {
      kind: "approval",
      requestId: index,
      approvalKind: "command",
      label: "curl",
      guard: true,
      since,
      risk: "high",
      reason: "The Guard asks you to check this step. The command sends a file to a server outside the workspace.",
    };
  if (fromEnd === 9)
    return {
      kind: "prompt",
      requestId: `prompt-${index}`,
      label: "Qual thumbnail sobe?",
      questionCount: 1,
      since,
      form: { choices: ["Azul", "Vermelha"], text: true },
    };
  return { kind: "approval", requestId: index, approvalKind: "command", label: "git", since };
}

function mockCandidates(agents: readonly MockFeedAgent[], ownerId: string) {
  return agents
    .filter((agent) => agent.id !== ownerId)
    .slice(0, 3)
    .map((agent) => ({ agentId: agent.id, name: agent.name }));
}

/** The actions that main offers on a card of this computer, by the same rule. */
function mockActions(state: FeedItemState, need: FeedNeed | null, stoppedTask: boolean): FeedAction[] {
  const actions: FeedAction[] = ["open"];
  if (need?.kind === "approval") actions.push("approve", "deny");
  else if (need?.kind === "prompt" && need.form) actions.push("answer");
  if (state === "working" || state === "needs-you") actions.push("stop");
  if (stoppedTask) actions.push("resume", "reassign");
  return actions;
}

/**
 * The cards of the actions story: one of each thing that the person can do on a card, a card that
 * refuses every action, and a card of a joined server, which offers only "open".
 */
export function mockFeedActionItems(now = MOCK_FEED_NOW): FeedItem[] {
  const at = (minutes: number) => iso(now - minutes * 60_000);
  const card = (id: string, agentIndex: number, patch: Partial<FeedItem>): FeedItem => {
    const agent = pick(MOCK_FEED_AGENTS, agentIndex);
    const project = PROJECTS[agent.project] ?? null;
    const item: FeedItem = {
      v: FEED_CONTRACT_VERSION,
      id,
      serverId: "local",
      agentId: agent.id,
      agentName: agent.name,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      threadId: `thread-${id}`,
      channelId: null,
      taskId: null,
      title: "",
      state: "working",
      startedAt: at(12),
      updatedAt: at(1),
      endedAt: null,
      lastStep: { at: at(1), kind: "progress", text: "Rodando um comando" },
      steps: [{ at: at(1), kind: "progress", text: "Rodando um comando" }],
      stepCount: 1,
      need: null,
      stop: null,
      actions: ["open"],
      revision: 1,
      ...patch,
    };
    return { ...item, actions: patch.actions ?? mockActions(item.state, item.need, item.id.includes(":task:")) };
  };
  const stoppedTask = (id: string, agentIndex: number, title: string, reason: string): FeedItem =>
    card(`local:task:${id}`, agentIndex, {
      threadId: null,
      channelId: "channel-ops",
      taskId: id,
      title,
      state: "stopped",
      endedAt: at(20),
      stop: { reason, source: "stopped-work" },
      reassignTo: mockCandidates(MOCK_FEED_AGENTS, pick(MOCK_FEED_AGENTS, agentIndex).id),
    });
  const ended = (id: string, agentIndex: number, title: string, minutes: number): FeedItem =>
    card(id, agentIndex, {
      title,
      state: "done",
      startedAt: at(minutes + 6),
      updatedAt: at(minutes),
      endedAt: at(minutes),
    });
  return [
    ended("local:t:lider:thread-done-1", 0, "Contrato de eventos remotos v3", 50),
    ended("local:t:dados:thread-done-2", 11, "Migração do banco para o RDS", 42),
    ended("local:t:front:thread-done-3", 8, "Página de preços nova", 35),
    stoppedTask(
      "deploy",
      0,
      "ops · Deploy do Hub",
      "O provedor falhou por pouco tempo. Isto pode já estar feito: MCP slack.post_message.",
    ),
    stoppedTask("legendas", 1, "ops · Legendas em três línguas", "O provedor não começou esta tarefa."),
    stoppedTask("relatorio", 6, "geo · Relatório semanal", "O plano chegou ao limite."),
    card("local:t:dev:thread-run", 5, { title: "Página de preços nova" }),
    card("local:t:editor:thread-command", 1, {
      title: "Roteiro do episódio de terça",
      state: "needs-you",
      need: { kind: "approval", requestId: 41, approvalKind: "command", label: "git", since: at(2) },
    }),
    card("local:t:red-team:thread-guard", 4, {
      title: "Revisão do Worker de login",
      state: "needs-you",
      need: {
        kind: "approval",
        requestId: 42,
        approvalKind: "command",
        label: "curl",
        guard: true,
        since: at(2),
        risk: "high",
        reason: "The Guard asks you to check this step. The command sends a file to a server outside the workspace.",
      },
    }),
    card("local:t:geo:thread-access", 6, {
      title: "Citações da marca",
      state: "needs-you",
      need: {
        kind: "approval",
        requestId: "perm-43",
        approvalKind: "permissions",
        label: "",
        since: at(2),
        risk: "high",
        reason: "Precisa da rede para baixar os relatórios.",
        access: { network: true, write: 1 },
      },
    }),
    card("local:t:validador:thread-choice", 2, {
      title: "Thumbnail em inglês do especial",
      state: "needs-you",
      need: {
        kind: "prompt",
        requestId: "prompt-44",
        label: "Qual thumbnail sobe?",
        questionCount: 1,
        since: at(1),
        form: { choices: ["Azul", "Vermelha"], text: true },
      },
    }),
    card("local:t:radar:thread-text", 3, {
      title: "Roteiro do especial",
      state: "needs-you",
      need: {
        kind: "prompt",
        requestId: "prompt-45",
        label: "Qual é o título do vídeo?",
        questionCount: 1,
        since: at(1),
        form: { choices: [], text: true },
      },
    }),
    card("local:t:pesquisa:thread-two", 9, {
      title: "Pesquisa de concorrentes",
      state: "needs-you",
      need: { kind: "prompt", requestId: "prompt-46", label: "Quais mercados?", questionCount: 2, since: at(1) },
    }),
    card(`local:t:publicador${MOCK_FEED_REFUSES}thread`, 7, {
      title: "Publicar o especial",
      state: "needs-you",
      need: { kind: "approval", requestId: 47, approvalKind: "command", label: "gh", since: at(1) },
    }),
    card("hub-ops:t:suporte:thread-remote", 10, {
      serverId: "hub-ops",
      title: "Atendimento do Hub",
      state: "needs-you",
      need: { kind: "approval", requestId: 48, approvalKind: "command", label: "psql", since: at(1) },
      actions: ["open"],
    }),
  ];
}

/** `count` cards in timeline order, the newest last. */
export function mockFeedItems(
  count: number,
  now = MOCK_FEED_NOW,
  agents: readonly MockFeedAgent[] = MOCK_FEED_AGENTS,
): FeedItem[] {
  return Array.from({ length: count }, (_, index) => mockFeedItem(index, count, now, agents));
}

export function createMockFeed(options: MockFeedOptions = {}): FeedDesktopApi {
  const initial = options.items ?? 40;
  const items = new Map<string, FeedItem>(
    (typeof initial === "number" ? mockFeedItems(initial, MOCK_FEED_NOW, options.agents) : initial).map((item) => [
      item.id,
      item,
    ]),
  );
  const listeners = new Set<Listener<FeedDelta>>();
  let cursor = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let next = items.size;

  const send = (upserts: FeedItem[], removes: string[] = []) => {
    cursor += 1;
    const delta: FeedDelta = { v: FEED_CONTRACT_VERSION, cursor, upserts: upserts.slice(0, FEED_DELTA_LIMIT), removes };
    for (const listener of listeners) listener(structuredClone(delta));
  };

  /** One tick of a busy workspace: a new run starts, and the newest working run takes a step. */
  const tick = () => {
    const now = Date.now();
    const created = {
      ...mockFeedItem(next, next + 1, now),
      id: `local:t:live:${next}`,
      state: "working" as const,
      need: null,
    };
    next += 1;
    items.set(created.id, created);
    const working = [...items.values()].reverse().find((item) => item.state === "working" && item.id !== created.id);
    const changed: FeedItem[] = [created];
    if (working) {
      const step: FeedStep = { at: iso(now), kind: "progress", text: pick(STEPS, working.stepCount) };
      const updated: FeedItem = {
        ...working,
        lastStep: step,
        steps: [...working.steps, step].slice(-20),
        stepCount: working.stepCount + 1,
        updatedAt: iso(now),
        revision: working.revision + 1,
      };
      items.set(updated.id, updated);
      changed.push(updated);
    }
    send(changed);
  };

  const delay = options.actionDelayMs ?? 250;
  const wait = () => new Promise((done) => setTimeout(done, delay));
  /** The change that main's answer to an action makes on a card, as its events would. */
  const change = (item: FeedItem, input: FeedActionInput): FeedItem | null => {
    const now = new Date().toISOString();
    const next = { ...item, updatedAt: now, revision: item.revision + 1 };
    switch (input.action) {
      case "approve":
      case "deny":
      case "answer":
        return { ...next, state: "working", need: null, actions: mockActions("working", null, false) };
      case "stop":
        return {
          ...next,
          state: "stopped",
          need: null,
          endedAt: now,
          stop: { reason: "", source: "interrupted" },
          actions: ["open"],
        };
      case "resume":
      case "reassign":
        return null;
    }
  };
  /** The checks of main, on the cards of the mock: the card, its request, the confirmation. */
  const refusal = (item: FeedItem | undefined, input: FeedActionInput): FeedActionFailure | null => {
    if (!item) return "gone";
    if (item.serverId !== "local") return "remote";
    if (item.id.includes(MOCK_FEED_REFUSES)) return "stale";
    if (!item.actions.includes(input.action)) return "not-allowed";
    if (
      (input.action === "approve" || input.action === "deny" || input.action === "answer") &&
      item.need?.requestId !== input.requestId
    )
      return "stale";
    if (input.action === "approve" && item.need?.risk === "high" && !input.confirmed) return "unconfirmed";
    return null;
  };
  const act = async (input: FeedActionInput): Promise<FeedActionResult> => {
    await wait();
    const ids = "itemIds" in input ? [...new Set(input.itemIds)] : [input.itemId];
    const failed: FeedActionResult["failed"] = [];
    const upserts: FeedItem[] = [];
    const removes: string[] = [];
    for (const id of ids) {
      const item = items.get(id);
      const reason = refusal(item, input);
      if (reason || !item) {
        failed.push({ itemId: id, reason: reason ?? "gone" });
        continue;
      }
      const next = change(item, input);
      if (next) {
        items.set(id, next);
        upserts.push(next);
      } else {
        items.delete(id);
        removes.push(id);
      }
    }
    if (upserts.length > 0 || removes.length > 0) send(upserts, removes);
    return { v: FEED_ACTION_VERSION, done: ids.length - failed.length, failed };
  };

  return {
    act,
    getSnapshot: async () => ({
      v: FEED_CONTRACT_VERSION,
      cursor,
      items: structuredClone([...items.values()]),
      truncated: false,
    }),
    setWatching: async ({ watching }) => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (watching && options.live) timer = setInterval(tick, options.live.intervalMs);
    },
    onDelta: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
