import type {
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
    taskId: null,
    title: "",
    startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  },
];

const storyStopped: StoppedWork[] = [
  {
    channelId: "c1",
    channelName: "naia novas features",
    taskId: "k2",
    title: "Correção pequena no cadastro em chat, worktree iavista-wt-cadastro-chat, branch feat/cadastro",
    reason: "The provider could not start this assignment. Resume to try again.",
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
    taskId: "k3",
    title: "Publicar a resposta completa no canal, com o diff",
    reason: "The previous turn has no confirmed result. It may have stopped when Builders Bot restarted.",
    agentName: null,
    state: "paused",
    candidates: [{ agentId: "a4", name: "Backend IA Naia", sameModel: true }],
    auto: "gave-up",
  },
];

function loadSnapshot(
  usedMb: number,
  lane: LoadLanePreference,
  recovery: AutoRecoveryPreference,
  withWork: boolean,
): LoadSnapshot {
  return {
    sampledAt: "2026-10-30T20:00:00.000Z",
    memory: { usedMb, agentsMb: Math.round(usedMb * 0.85), totalMb: 32768 },
    activeAgents: 7,
    providerProcesses: 91,
    lane: lane.enabled
      ? { ...lane, running: ["deploys"], queued: ["security", "videos", "releases"] }
      : { ...lane, running: [], queued: [] },
    running: withWork ? storyRunning : [],
    stopped: withWork ? storyStopped : [],
    recovery: {
      ...recovery,
      recent: recovery.enabled
        ? [{ at: "2026-10-30T20:30:00.000Z", channelName: "bugs", action: "resumed", agentName: "Writer" }]
        : [],
    },
  };
}

/** The load ring with a lane that follows its switch, as the window's controller does. */
function loadProps(usedMb: number, withWork: boolean): () => LoadRailProps {
  const [lane, setLane] = createSignal<LoadLanePreference>({ enabled: false, order: [] });
  const [recovery, setRecovery] = createSignal<AutoRecoveryPreference>({
    enabled: false,
    intervalMinutes: 30,
    reassign: false,
  });
  return () => ({
    snapshot: loadSnapshot(usedMb, lane(), recovery(), withWork),
    channelName: (id) => loadChannelNames[id] ?? id,
    onOpenChange: fn(),
    onLaneChange: setLane,
    onRunNow: fn(),
    onStop: fn(),
    onResumeAll: fn(),
    onResume: fn(),
    onReassign: fn(),
    onRecoveryChange: setRecovery,
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
  loadWork?: boolean;
}) {
  const { t } = useText();
  const load = props.loadMb === undefined ? undefined : loadProps(props.loadMb, props.loadWork ?? false);
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

/** The web client: no macOS window buttons, so the logo in the top row links to the OpenBot site. */
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
  args: { loadMb: 14000, loadWork: true },
};
