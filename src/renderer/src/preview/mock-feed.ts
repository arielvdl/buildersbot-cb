import {
  FEED_CONTRACT_VERSION,
  FEED_DELTA_LIMIT,
  type FeedDelta,
  type FeedDesktopApi,
  type FeedItem,
  type FeedItemState,
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
  /** Adds and changes cards on a timer, as a busy workspace does. */
  live?: { intervalMs: number } | undefined;
}

/** The fixed time of the fixtures, so the times on the cards do not change. */
export const MOCK_FEED_NOW = Date.parse("2026-11-02T14:30:00.000Z");

const PROJECTS = [
  { id: "section-hub", name: "Hub" },
  { id: "section-site", name: "Site" },
  { id: "section-video", name: "iMasters" },
  { id: "section-geo", name: "naia" },
  null,
] as const;

export const MOCK_FEED_AGENTS = [
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
] as const;

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
export function mockFeedItem(index: number, total: number, now = MOCK_FEED_NOW): FeedItem {
  const agent = pick(MOCK_FEED_AGENTS, index * 7);
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
  return {
    v: FEED_CONTRACT_VERSION,
    id: `local:t:${agent.id}:thread-${index}`,
    serverId: "local",
    agentId: agent.id,
    agentName: agent.name,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    threadId: `thread-${index}`,
    channelId: state === "stopped" ? "channel-ops" : null,
    taskId: state === "stopped" ? `task-${index}` : null,
    title: pick(TITLES, index * 5),
    state,
    startedAt: iso(started),
    updatedAt: iso(updated),
    endedAt: open ? null : iso(updated),
    lastStep: steps.at(-1) ?? null,
    steps,
    stepCount,
    need:
      state === "needs-you"
        ? index % 2 === 0
          ? { kind: "approval", requestId: index, approvalKind: "command", label: "git", since: iso(updated) }
          : {
              kind: "prompt",
              requestId: `prompt-${index}`,
              label: "Qual thumbnail sobe?",
              questionCount: 1,
              since: iso(updated),
            }
        : null,
    stop:
      state === "stopped"
        ? { reason: "O provedor não começou esta tarefa.", source: "stopped-work" }
        : state === "failed"
          ? { reason: "A execução terminou com erro.", source: "error" }
          : null,
    ...(state === "waiting" ? { queued: 2 } : {}),
    ...(state === "working" && fromEnd === 13 ? { quiet: { state: "slow" as const, minutes: 16 } } : {}),
    actions: ["open"],
    revision: stepCount,
  };
}

/** `count` cards in timeline order, the newest last. */
export function mockFeedItems(count: number, now = MOCK_FEED_NOW): FeedItem[] {
  return Array.from({ length: count }, (_, index) => mockFeedItem(index, count, now));
}

export function createMockFeed(options: MockFeedOptions = {}): FeedDesktopApi {
  const initial = options.items ?? 40;
  const items = new Map<string, FeedItem>(
    (typeof initial === "number" ? mockFeedItems(initial) : initial).map((item) => [item.id, item]),
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

  return {
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
