import type {
  AvatarImageInput,
  CentralAuthUser,
  ClientAgentModelOption,
  ClientAgentSummary,
  LoadSnapshot,
  MobileConnectedDevice,
  ServerSummary,
  TaskWatchEvent,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import { Button, Toaster, toast } from "@openbot/ui";
import { DEFAULT_GENERAL_SETTINGS, type GeneralSettingsValue } from "@openbot/ui/features/settings/app-settings";
import { createSignal, onCleanup } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createLoadStore } from "../src/features/load/load-context";
import { SettingsModal } from "../src/features/settings/SettingsModal";
import type { SettingsTab } from "../src/features/settings/settings-tabs";
import { STORY_AGENT_SUMMARIES, STORY_SERVERS } from "../src/preview/fixtures";
import { createMockBilling } from "../src/preview/mock-billing";
import type { MockVoiceOptions } from "../src/preview/mock-voice";
import { createMockBuildersBot } from "./mock-openbot";
import { SettingsPageStory } from "./settings-page-story";
import { previewStorySoundSettings } from "./sound-feedback-fixture";

/** A packaged Windows run, which offers every switch that the defaults hide. */
const storyGeneralSettings: GeneralSettingsValue = {
  ...DEFAULT_GENERAL_SETTINGS,
  launchAtLogin: true,
  keepRunningInBackground: false,
  keepAwake: false,
  keepAwakeOnBattery: false,
  browserInApp: false,
  culturaBuilderFullContext: false,
};

const storyAppInfo = { name: "Builders Bot", version: "0.2.1", platform: "darwin", variant: "dev" } as const;
const storyAccount: CentralAuthUser = {
  id: "user-1",
  email: "person@example.com",
  name: "Norbert",
  avatarUrl: null,
};
/** A model the Guard can choose, as a provider lists it. */
function guardStoryModel(
  provider: ClientAgentModelOption["provider"],
  id: string,
  name: string,
): ClientAgentModelOption {
  return {
    provider,
    id,
    name,
    description: "",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium"],
  };
}

/** The ten models of a ChatGPT account and the fast Cultura Builder model: the Guard's model list has eleven rows. */
const guardStoryModels: ClientAgentModelOption[] = [
  guardStoryModel("cultura-builder", "cultura-builder/builder-fast", "builder-fast"),
  ...["GPT-6.1-Sol", "GPT-6.1 Terra", "GPT-6-Astra", "GPT-6-Sol", "GPT-6-Luna", "GPT-5.6-Sol", "GPT-5.6-Terra"].map(
    (name) => guardStoryModel("codex", name.toLowerCase().replaceAll(" ", "-"), name),
  ),
  guardStoryModel("codex", "gpt-5.6-luna", "GPT-5.6-Luna"),
  guardStoryModel("codex", "gpt-reserve", "GPT-Reserve"),
  guardStoryModel("codex", "codex-auto-review", "Codex Auto Review"),
];

/**
 * The agents of a big team: more than a window has rows. The names start like the list of a person
 * who could not reach the last agents of the Notifications menu, and the last one has an accent, so
 * a search without accents finds it. Each provider has more than one model.
 */
const MANY_AGENT_NAMES = [
  "Gran Mestre",
  "ferreiro",
  "oraculo",
  "GPT 6.1 Terra",
  "Pest Código",
  ...Array.from({ length: 39 }, (_, index) => `Agente ${String(index + 1).padStart(2, "0")}`),
  "Zé Último",
];
const MANY_AGENT_MODELS = [
  { provider: "claude", model: "claude-opus-5-5" },
  { provider: "codex", model: "gpt-6.1-terra" },
  { provider: "codex", model: "gpt-6.1-sol" },
  { provider: "opencode", model: "glm-5" },
  { provider: "claude", model: "claude-sonnet-5" },
] as const;
const MANY_STORY_AGENTS: ClientAgentSummary[] = MANY_AGENT_NAMES.map((name, index) => {
  const template = STORY_AGENT_SUMMARIES[0];
  if (!template) throw new Error("The preview has no agents.");
  const { provider, model } = MANY_AGENT_MODELS[index % MANY_AGENT_MODELS.length] ?? MANY_AGENT_MODELS[0];
  const id = `team-agent-${index + 1}`;
  return {
    ...template,
    id,
    name,
    title: "",
    provider,
    model,
    notifications: true,
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
});

const storyUpdateStatus: UpdateStatus = {
  phase: "idle",
  currentVersion: "0.2.1",
  availableVersion: null,
  progress: null,
  checkedAt: null,
  message: null,
  errorCode: null,
};

/** What the task reviewer did lately on the story computer: one action of the model, two of the local rules. */
const storyTaskWatchRecent: TaskWatchEvent[] = [
  {
    at: "2026-10-31T21:40:00.000Z",
    channelName: "Pagamentos",
    action: "reassigned",
    agentName: "Writer",
    reason: "no-sign",
    minutes: 32,
    by: "local",
  },
  {
    at: "2026-10-31T21:05:00.000Z",
    channelName: "Pagamentos",
    action: "resumed",
    agentName: null,
    reason: "no-sign",
    minutes: 31,
    by: "local",
  },
  {
    at: "2026-10-31T20:50:00.000Z",
    channelName: "Lançamentos",
    action: "waited",
    agentName: null,
    reason: "queued",
    minutes: 18,
    by: "model",
  },
];

function SettingsModalStory(props: {
  initialOpen: boolean;
  /** Adds the Hosted servers tab with a stopped server and a server whose plan ended. */
  hostedServers?: boolean;
  /** How long the hosted server list takes to answer. */
  hostedServersDelayMs?: number;
  initialTab?: SettingsTab;
  openTab?: SettingsTab;
  /** A restart that a server admin asked for. */
  scheduledRestart?: UpdateStatus["scheduledRestart"];
  /** The downloaded dictation models and the saved voice setting. */
  voice?: MockVoiceOptions;
  /** The task reviewer and Resume by itself start on, and the reviewer has done three things. */
  taskReviewerActive?: boolean;
  /** The window shows a joined server, so the Guard and the task reviewer say they are this computer's. */
  joinedServer?: boolean;
  /** The models that the Guard's model list offers. */
  models?: ClientAgentModelOption[];
  /** A question of the Guard waits in the approvals of the active server. */
  guardAsking?: boolean;
  /** Main never answers the Guard state, so the Guard page stays as it is while it loads. */
  guardLoading?: boolean;
  /** The agents of each server, in place of the preview agents. */
  agents?: ClientAgentSummary[];
}) {
  const previousApi = window.openbot;
  const billingApi = createMockBilling();
  const mock = createMockBuildersBot({ ...props.voice, ...(props.agents ? { agents: props.agents } : {}) });
  const models = props.models;
  if (models) mock.api.agent.listModels = async () => structuredClone(models);
  if (props.guardLoading) mock.api.guard.getState = () => new Promise(() => undefined);
  window.openbot = mock.api;
  if (props.taskReviewerActive) {
    void mock.api.setAutoRecovery({ enabled: true, intervalMinutes: 30, reassign: true });
    void mock.api.setTaskWatch({ enabled: true, quietMinutes: 15 });
  }
  // The same store as the ring of the rail. The story reads the mock, with the actions of the reviewer.
  const load = createLoadStore(
    () => ({
      ...mock.api,
      getLoad: async (): Promise<LoadSnapshot> => {
        const reading = await mock.api.getLoad();
        if (!props.taskReviewerActive) return reading;
        return { ...reading, taskWatch: { ...reading.taskWatch, modelReady: true, recent: storyTaskWatchRecent } };
      },
    }),
    () => false,
  );
  onCleanup(() => {
    mock.dispose();
    toast.dismiss();
    // Storybook can render the story again before it cleans up the first render. That render's API stays.
    if (window.openbot === mock.api) window.openbot = previousApi;
  });
  const hostedServersApi = {
    ...mock.api.hostedServers,
    list: async () => {
      await new Promise((resolve) => window.setTimeout(resolve, props.hostedServersDelayMs ?? 0));
      return mock.api.hostedServers.list();
    },
  };
  const [open, setOpen] = createSignal(props.initialOpen);
  const [value, setValue] = createSignal({ ...storyGeneralSettings });
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>(
    props.scheduledRestart
      ? { ...storyUpdateStatus, phase: "ready", availableVersion: "0.3.0", scheduledRestart: props.scheduledRestart }
      : storyUpdateStatus,
  );
  const [account, setAccount] = createSignal<CentralAuthUser>({ ...storyAccount });
  // The notification level and the mute of each server, as the server list of the app keeps them.
  const [servers, setServers] = createSignal<readonly ServerSummary[]>(
    props.joinedServer ? STORY_SERVERS.map((server) => ({ ...server, active: server.id === "team" })) : STORY_SERVERS,
  );
  const updateServer = (serverId: string, change: Partial<ServerSummary>): void => {
    setServers((list) => list.map((server) => (server.id === serverId ? { ...server, ...change } : server)));
  };
  const [mobileDevices, setMobileDevices] = createSignal<MobileConnectedDevice[]>([
    {
      sessionId: "11111111-1111-4111-8111-111111111111",
      name: "Norbert’s iPhone",
      platform: "ios",
      connectedAt: Date.now() - 86_400_000,
      lastActiveAt: Date.now() - 45_000,
      via: "code",
    },
    {
      sessionId: "22222222-2222-4222-8222-222222222222",
      name: "Pixel 9",
      platform: "android",
      connectedAt: Date.now() - 3_600_000,
      lastActiveAt: Date.now() - 600_000,
      via: "link",
    },
  ]);

  async function updateAccountAvatar(image: AvatarImageInput | null): Promise<void> {
    const avatarUrl = image
      ? `data:${image.mimeType};base64,${btoa(Array.from(image.bytes, (byte) => String.fromCharCode(byte)).join(""))}`
      : null;
    setAccount((current) => ({ ...current, avatarUrl }));
  }

  async function updateAccountName(name: string): Promise<void> {
    setAccount((current) => ({ ...current, name }));
  }

  async function runUpdateAction(): Promise<void> {
    setUpdateStatus({ ...storyUpdateStatus, phase: "up-to-date", checkedAt: new Date().toISOString() });
  }

  return (
    <>
      <SettingsPageStory
        title="Settings"
        controls={
          <Button variant="outline" type="button" onClick={() => setOpen(true)}>
            Open settings
          </Button>
        }
        onEscape={() => setOpen(false)}
      >
        {(page) => (
          <SettingsModal
            page={page()}
            initialTab={props.initialTab}
            openTab={props.openTab}
            open={open()}
            value={value()}
            onValueChange={(next) => {
              previewStorySoundSettings(value(), next);
              setValue(next);
            }}
            appInfo={storyAppInfo}
            servers={servers()}
            onSetServerNotificationLevel={async (serverId, level) =>
              updateServer(serverId, { notificationLevel: level })
            }
            onSetServerMuted={async (serverId, muted, durationMs) =>
              updateServer(serverId, {
                notificationsMuted: muted,
                notificationsMutedUntil: muted && durationMs !== undefined ? Date.now() + durationMs : null,
              })
            }
            updateStatus={updateStatus()}
            onCancelScheduledRestart={async () => {
              const { scheduledRestart: _cancelled, ...rest } = updateStatus();
              setUpdateStatus(rest);
            }}
            account={account()}
            onUpdateAccountName={updateAccountName}
            onUpdateAccountAvatar={updateAccountAvatar}
            onListMobileConnectedDevices={async () => mobileDevices()}
            onListAccountSessions={mock.api.auth.listAccountSessions}
            onRevokeAccountSession={mock.api.auth.revokeAccountSession}
            onRevokeMobileConnectedDevice={async (sessionId) => {
              setMobileDevices((current) => current.filter((device) => device.sessionId !== sessionId));
            }}
            onGetRemoteNetworkRoute={mock.api.getRemoteNetworkRoute}
            onSetRemoteNetworkRoute={(route) => mock.api.setRemoteNetworkRoute({ route })}
            onGetMobileWebAppUrl={mock.api.auth.getMobileWebAppUrl}
            onUpdateAction={runUpdateAction}
            billingApi={billingApi}
            hostedServersApi={props.hostedServers ? hostedServersApi : undefined}
            onAddHostedServer={props.hostedServers ? fn() : undefined}
            load={load}
            onOpenLoadPanel={props.joinedServer ? undefined : fn()}
            guardAsking={props.guardAsking}
          />
        )}
      </SettingsPageStory>
      <Toaster />
    </>
  );
}

const meta = {
  title: "Settings/SettingsModal",
  component: SettingsModal,
  args: {
    open: false,
    value: storyGeneralSettings,
    onValueChange: fn(),
    appInfo: storyAppInfo,
    updateStatus: storyUpdateStatus,
    onUpdateAction: fn(async () => undefined),
    account: storyAccount,
    onUpdateAccountName: fn(async () => undefined),
    onUpdateAccountAvatar: fn(async () => undefined),
  },
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    viewport: {
      options: {
        settingsDesktop: {
          name: "Settings — 1200 × 820",
          styles: { width: "1200px", height: "820px" },
        },
        settingsNarrow: {
          name: "Settings — 640 × 720",
          styles: { width: "640px", height: "720px" },
        },
        settingsPhone: {
          name: "Settings — 420 × 760",
          styles: { width: "420px", height: "760px" },
        },
      },
    },
  },
} satisfies Meta<typeof SettingsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  render: () => <SettingsModalStory initialOpen />,
};

export const Narrow: Story = {
  render: () => <SettingsModalStory initialOpen />,
  parameters: { viewport: { defaultViewport: "settingsNarrow" } },
};

export const Profile: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="profile" />,
};

export const Notifications: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="notifications" />,
};

/**
 * Notifications on a server with 45 agents, in a short window: the menu of "Choose for an agent"
 * stays in the window, scrolls, searches and filters by provider and model.
 */
export const NotificationsManyAgents: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="notifications" agents={MANY_STORY_AGENTS} />,
};

/**
 * The Guard of this computer: the siren, level, review model, when it asks, what leaves the computer,
 * and its links. Light, with no Cultura Builder sign-in, and eleven models in the model list.
 */
export const Guard: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="guard" models={guardStoryModels} />,
};

/** The task reviewer ("Fiscal") while it is off: the switch, its threshold, the Guard's model and the load panel. */
export const TaskReviewer: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="task-reviewer" />,
};

/** The task reviewer on, with Resume by itself, the Guard's model ready and three recent actions. */
export const TaskReviewerActive: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="task-reviewer" taskReviewerActive />,
};

/** The task reviewer while the window shows a joined server: the page says it is this computer's. */
export const TaskReviewerJoinedServer: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="task-reviewer" joinedServer />,
};

/** The Guard while the window shows a joined server. */
export const GuardJoinedServer: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="guard" joinedServer />,
};

/** A question of the Guard waits for the person: the siren of the page sounds the alarm. */
export const GuardAsking: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="guard" models={guardStoryModels} guardAsking />,
};

/**
 * A joined server has a question that says it is the Guard's. The page shows the Guard of this
 * computer, so its siren stays calm.
 */
export const GuardJoinedServerAsking: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="guard" joinedServer guardAsking />,
};

/** The page before main answers: the siren is asleep with no level name, and the level cards wait. */
export const GuardLoading: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="guard" models={guardStoryModels} guardLoading />,
};

export const Voice: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="voice" />,
};

export const VoiceWhisperHungarian: Story = {
  render: () => (
    <SettingsModalStory
      initialOpen
      initialTab="voice"
      voice={{
        voiceModelsReady: ["parakeet-tdt-0.6b-v3", "whisper-turbo"],
        voiceSettings: { modelId: "whisper-turbo", language: "hu" },
      }}
    />
  ),
};

/** Downloaded models, and the speech model, each with Remove. */
export const VoiceModelsDownloaded: Story = {
  render: () => (
    <SettingsModalStory
      initialOpen
      initialTab="voice"
      voice={{ voiceModelsReady: ["parakeet-tdt-0.6b-v3", "bark-3.0-plus"], speechModelReady: true }}
    />
  ),
};

export const GuardNarrow: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="guard" models={guardStoryModels} />,
  parameters: { viewport: { defaultViewport: "settingsNarrow" } },
};

/** The install guide for each phone, the Cultura Builder sign-in steps and the phones of the earlier app. */
export const MobileConnect: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="mobile-connect" />,
};

/** No plan yet. Choose a plan: the mock then shows it as active, as after a Stripe payment. */
export const Billing: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="billing" />,
};

/** An account that can create hosted servers. Start, renew and delete change the mock list. */
export const HostedServers: Story = {
  render: () => <SettingsModalStory initialOpen hostedServers initialTab="hosted-servers" />,
};

/** "Manage servers" with a list that answers after 300 ms: the tab opens at once and shows no spinner. */
export const HostedServersFastList: Story = {
  render: () => <SettingsModalStory initialOpen hostedServers hostedServersDelayMs={300} openTab="hosted-servers" />,
};

/** "Manage servers" with a list that answers after 3 s: the spinner fades in after its delay. */
export const HostedServersSlowList: Story = {
  render: () => <SettingsModalStory initialOpen hostedServers hostedServersDelayMs={3_000} openTab="hosted-servers" />,
};

export const ScheduledRemoteUpdate: Story = {
  render: () => (
    <SettingsModalStory
      initialOpen
      initialTab="updates"
      scheduledRestart={{ requestedBy: "Ada Lovelace", mode: "when-idle", waitingFor: ["agent-turn"] }}
    />
  ),
};

export const Interactive: Story = {
  render: () => <SettingsModalStory initialOpen={false} />,
};
