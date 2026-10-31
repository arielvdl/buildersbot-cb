import type {
  AgentLimitPreference,
  AutoRecoveryPreference,
  LoadLanePreference,
  LoadSnapshot,
  RunningWork,
  StoppedWork,
} from "@openbot/contracts/ipc";
import { accountUsageProviderRows } from "@openbot/ui/features/account/account-usage-view";
import { HelpMenu } from "@openbot/ui/features/updates/HelpMenu";
import {
  type CustomAgentUsageRailRow,
  type LoadRailProps,
  PageRail,
  type PageRailPage,
  type PageRailPinnablePage,
  type PageRailProps,
} from "@openbot/ui/features/window/PageRail";
import { useText } from "@openbot/ui/text";
import { createSignal } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const nowSeconds = Math.floor(Date.now() / 1_000);

const usageRows = accountUsageProviderRows({
  limits: [
    {
      id: "codex",
      primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: nowSeconds + 2 * 3_600 },
      secondary: { usedPercent: 15, windowDurationMins: 10_080, resetsAt: nowSeconds + 4 * 86_400 },
    },
    {
      id: "cursor",
      primary: { usedPercent: 37, windowDurationMins: 43_200, resetsAt: nowSeconds + 18 * 86_400 },
      secondary: { usedPercent: 82, windowDurationMins: 43_200, resetsAt: nowSeconds + 18 * 86_400 },
    },
  ],
});

/** A merged Cursor plan counts the Grok plan quota: one Grok ring, and its card lists Cursor too. */
const sharedQuotaRows = accountUsageProviderRows({
  limits: [
    {
      id: "grok",
      primary: null,
      secondary: { usedPercent: 64, windowDurationMins: 10_080, resetsAt: nowSeconds + 3 * 86_400 },
    },
    {
      id: "cursor",
      primary: { usedPercent: 64, windowDurationMins: 43_200, resetsAt: nowSeconds + 18 * 86_400 },
      secondary: null,
      sharedQuotaWith: "grok",
    },
  ],
});

/** An example answer. Each agent writes its own text, which the card shows as it is. */
const customAgentUsage: CustomAgentUsageRailRow[] = [
  { id: "devin", name: "Devin", text: "Plan: Team\nACUs used this cycle: 42 of 250\nThe cycle resets in 12 days." },
];

/** The channels of the load panel's queue. */
const loadChannelNames: Record<string, string> = {
  deploys: "naia - deploys",
  security: "segurança",
  videos: "imasters --update",
  releases: "CB - geral",
};

const storyRunning: RunningWork[] = [
  {
    turnId: "t1",
    agentId: "designer",
    agentName: "Design Advisor",
    channelId: "c1",
    channelName: "naia novas features",
    topicName: "cadastro",
    taskId: "k1",
    title: "O servidor de testes está no ar de novo: http://localhost:3000/autopilot/dev-cadastro-chat",
    startedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
  },
  {
    turnId: "t2",
    agentId: "chief",
    agentName: "CEO",
    channelId: null,
    channelName: null,
    topicName: null,
    taskId: null,
    title: "",
    startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  },
  {
    turnId: "t3",
    agentId: "backend",
    agentName: "Backend IA Naia",
    channelId: "c3",
    channelName: "imasters --update · edição de sexta com a vinheta nova",
    topicName: "Aba 4",
    taskId: "k4",
    title:
      "Monte o episódio de sexta com a vinheta nova, a bolinha só na introdução e as legendas em três idiomas, " +
      "e depois agende o vídeo para as 13h de Brasília.",
    startedAt: new Date(Date.now() - 42 * 60_000).toISOString(),
  },
];

const startFailed = "The provider could not start this assignment. Resume to try again.";
const unconfirmed = "The previous turn has no confirmed result. Check its work before you resume.";

const storyStopped: StoppedWork[] = [
  {
    channelId: "c1",
    channelName: "naia novas features",
    topicName: "cadastro",
    taskId: "k2",
    title: "Correção pequena no cadastro em chat, worktree iavista-wt-cadastro-chat, branch feat/cadastro",
    reason: startFailed,
    agentName: "Front Fluxos Naia",
    state: "failed",
    candidates: [
      { agentId: "a2", name: "Design Advisor", sameModel: true },
      { agentId: "a3", name: "QA Naia", sameModel: false },
    ],
    auto: "waiting",
  },
  {
    channelId: "c2",
    channelName: "bugs",
    topicName: null,
    taskId: "k3",
    title: "Publicar a resposta completa no canal, com o diff",
    reason: unconfirmed,
    agentName: null,
    state: "paused",
    candidates: [{ agentId: "a4", name: "Backend IA Naia", sameModel: true }],
    auto: "gave-up",
  },
];

const longRequest =
  "Rodada do cadastro em chat: revise o fluxo inteiro com o print @[image.png](attachment:0a1b2c3d) e ajuste o " +
  "passo do CNPJ, o resumo final e a mensagem de erro quando a Receita não responde. Depois rode os testes E2E do " +
  "cadastro, suba o preview e mande o link aqui no canal com o que mudou, em tópicos curtos, sem colar o diff inteiro.";

/** Eleven stopped tasks, as the person saw them: long requests, an attachment, one task with no tab. */
const manyStopped: StoppedWork[] = [
  ["naia novas features", "cadastro", longRequest, startFailed, "Backend IA Naia", "failed"],
  ["naia novas features", "Main", "Corrigir o botão de login no Safari", unconfirmed, "Front Fluxos Naia", "paused"],
  ["imasters --update · edição de sexta com a vinheta nova", "Aba 4", longRequest, startFailed, "Editor", "failed"],
  ["bugs", null, "Publicar a resposta completa no canal, com o diff", unconfirmed, null, "paused"],
  ["CB - geral", "Main", "@[image.png](attachment:4e5f6071)", startFailed, "Design Advisor", "failed"],
  [
    "segurança",
    "CVE da semana",
    "Atualizar o next para a versão com a correção e abrir o PR",
    startFailed,
    "QA Naia",
    "failed",
  ],
  ["naia - deploys", "Main", "Subir a release 2.14 na hub-prod-02", unconfirmed, "Backend IA Naia", "paused"],
  ["gotas stream", "Labs", longRequest, startFailed, "Backend IA Naia", "failed"],
  ["CB - geral", "Aula 216", "Revisar a legenda em espanhol", startFailed, "Writer", "failed"],
  ["imasters --update", "Main", "Gerar a thumbnail em inglês", unconfirmed, "Editor", "paused"],
  ["naia novas features", "cadastro", "Rodar o lint só nos arquivos que mudaram", startFailed, "QA Naia", "failed"],
].map(
  ([channelName, topicName, title, reason, agentName, state], index): StoppedWork => ({
    channelId: `m${index}`,
    channelName: channelName ?? "",
    topicName: topicName ?? null,
    taskId: `mk${index}`,
    title: title ?? "",
    reason: reason ?? "",
    agentName: agentName ?? null,
    state: state === "paused" ? "paused" : "failed",
    candidates:
      index % 3 === 2
        ? []
        : [
            { agentId: "a2", name: "Design Advisor", sameModel: true },
            { agentId: "a4", name: "Backend IA Naia", sameModel: true },
            { agentId: "a3", name: "QA Naia", sameModel: false },
          ],
    auto: index === 1 ? "waiting" : index === 2 ? "gave-up" : null,
  }),
);

/** The work in the load panel: none, two of each, or eleven stopped tasks. */
type LoadWork = "none" | "some" | "many";

function loadSnapshot(
  usedMb: number,
  lane: LoadLanePreference,
  recovery: AutoRecoveryPreference,
  work: LoadWork,
  agentLimit: AgentLimitPreference,
): LoadSnapshot {
  return {
    sampledAt: "2026-10-30T20:00:00.000Z",
    memory: { usedMb, agentsMb: Math.round(usedMb * 0.85), totalMb: 32768 },
    activeAgents: 7,
    providerProcesses: 91,
    lane: lane.enabled
      ? { ...lane, running: ["deploys"], queued: ["security", "videos", "releases"] }
      : { ...lane, running: [], queued: [] },
    running: work === "none" ? [] : storyRunning,
    // With the cap on and reached, two agents wait for a place.
    waiting:
      agentLimit.enabled && agentLimit.max <= 7
        ? [
            { agentId: "writer", agentName: "Writer" },
            { agentId: "qa", agentName: "QA Naia" },
          ]
        : [],
    stopped: work === "none" ? [] : work === "many" ? manyStopped : storyStopped,
    agentLimit,
    recovery: {
      ...recovery,
      recent: recovery.enabled
        ? [{ at: "2026-10-30T20:30:00.000Z", channelName: "bugs", action: "resumed", agentName: "Writer" }]
        : [],
    },
  };
}

/** The load ring with a lane that follows its switch, as the window's controller does. */
function loadProps(usedMb: number, work: LoadWork): () => LoadRailProps {
  const [lane, setLane] = createSignal<LoadLanePreference>({ enabled: false, order: [] });
  const [recovery, setRecovery] = createSignal<AutoRecoveryPreference>({
    enabled: false,
    intervalMinutes: 30,
    reassign: false,
  });
  const [agentLimit, setAgentLimit] = createSignal<AgentLimitPreference>({ enabled: false, max: 10 });
  return () => ({
    snapshot: loadSnapshot(usedMb, lane(), recovery(), work, agentLimit()),
    channelName: (id) => loadChannelNames[id] ?? id,
    onOpenChange: fn(),
    onLaneChange: setLane,
    onRunNow: fn(),
    onStop: fn(),
    onResumeAll: fn(),
    onResume: fn(),
    onReassign: fn(),
    onRecoveryChange: setRecovery,
    onAgentLimitChange: setAgentLimit,
  });
}

/** The page rail as the desktop window shows it. Hover a button, or move to it with Tab, to see its tooltip. */
function RailPreview(props: {
  updateReady?: boolean;
  logo?: PageRailProps["logo"];
  customAgentUsage?: readonly CustomAgentUsageRailRow[];
  usageRows?: PageRailProps["usageRows"];
  /** The memory in use, in MB, of a load ring. Absent: no ring. */
  loadMb?: number;
  /** Work that runs and work that stopped, in the load panel. */
  loadWork?: LoadWork;
}) {
  const { t } = useText();
  const load = props.loadMb === undefined ? undefined : loadProps(props.loadMb, props.loadWork ?? "none");
  const [current, setCurrent] = createSignal<PageRailPage | null>("agents");
  const [pinned, setPinned] = createSignal<readonly PageRailPinnablePage[]>(["usage"]);
  return (
    // The extra box keeps the rail out of the rule that hides it in a narrow window.
    <div class="app-window" style={{ height: "100vh" }}>
      <div style={{ display: "flex" }}>
        <PageRail
          hidden={false}
          current={current()}
          pinned={pinned()}
          onPinChange={(page, pin) =>
            setPinned((pages) => (pin ? [...pages, page] : pages.filter((other) => other !== page)))
          }
          usageRows={props.usageRows ?? usageRows}
          customAgentUsage={props.customAgentUsage}
          load={load?.()}
          onAgents={() => setCurrent("agents")}
          onRoutines={() => setCurrent("routines")}
          onSchedule={() => setCurrent("schedule")}
          onUsage={() => setCurrent("usage")}
          onMarketplace={fn()}
          onSettings={() => setCurrent("settings")}
          settingsNotice={props.updateReady ? t("account.update.ready") : undefined}
          logo={props.logo}
          help={
            <HelpMenu
              news={[]}
              triggerClass="window-rail-button"
              onOpenWhatsNew={fn()}
              onOpenChangelog={fn()}
              onOpenGuides={fn()}
              onOpenDiscord={fn()}
              onSendFeedback={fn()}
            />
          }
        />
      </div>
    </div>
  );
}

const meta = {
  title: "Window/PageRail",
  component: RailPreview,
} satisfies Meta<typeof RailPreview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The Settings tooltip also says what the dot stands for. */
export const SettingsNotice: Story = {
  args: { updateReady: true },
};

/** A custom agent with a usage command: its logo with no ring. Hover it to see the answer. */
export const CustomAgentUsage: Story = {
  args: { customAgentUsage },
};

/** Grok and a merged Cursor plan share one quota, so the rail shows the Grok ring alone. */
export const SharedQuota: Story = {
  args: { usageRows: sharedQuotaRows },
};

/** The web client: no macOS window buttons, so the logo in the top row links to the Builders Bot site. */
export const WebLogo: Story = {
  args: { logo: { variant: "production", href: "/" } },
};

/** Windows and Linux: the logo is in the top row, with no link. */
export const DesktopLogo: Story = {
  args: { logo: { variant: "production" } },
};

/** The load ring at a quarter of the memory: green. Click it for the panel and the one-channel mode. */
export const Load: Story = {
  args: { loadMb: 8192 },
};

/** Past 80% of the memory the arc is red. */
export const LoadHigh: Story = {
  args: { loadMb: 28000 },
};

/** Two agents run and two tasks stopped: the ring carries a red count, and the panel lists what to do about each. */
export const LoadWithStoppedWork: Story = {
  args: { loadMb: 14000, loadWork: "some" },
};

/**
 * Eleven stopped tasks with long requests, an attachment and a task with no tab. Hover or focus the
 * icon at the right of a channel for the reason, and click a request to read all of it. Make the
 * window narrow to see the actions wrap.
 */
export const LoadWithManyStoppedTasks: Story = {
  args: { loadMb: 14000, loadWork: "many" },
};
