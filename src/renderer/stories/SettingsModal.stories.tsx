import type {
  AvatarImageInput,
  CentralAuthUser,
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
import { STORY_SERVERS } from "../src/preview/fixtures";
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
}) {
  const previousApi = window.openbot;
  const billingApi = createMockBilling();
  const mock = createMockBuildersBot(props.voice);
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

/** The Guard of this computer: level, review model, when it asks, what leaves the computer, and its links. */
export const Guard: Story = {
  render: () => <SettingsModalStory initialOpen initialTab="guard" />,
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
