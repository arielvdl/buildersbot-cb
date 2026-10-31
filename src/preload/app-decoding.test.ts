import type {
  AccountSession,
  AppInfo,
  ApprovalAutomationPreference,
  AppSetupState,
  CentralAuthState,
  InterruptedWorkOffer,
  LoadSnapshot,
  MobileConnectedDevice,
  NotificationOpenedEvent,
  RunningWork,
  StoppedWork,
  TaskWatchEvent,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  decodeAccountSessions,
  decodeAgentLimitPreference,
  decodeAnalyticsPreference,
  decodeAppAppearancePreference,
  decodeAppInfo,
  decodeAppLanguagePreference,
  decodeApprovalAutomationPreference,
  decodeAppSetupState,
  decodeCentralAuthState,
  decodeChatWindowTargets,
  decodeCustomAgentResult,
  decodeCustomAgents,
  decodeCustomAgentUsage,
  decodeDetectedModelServers,
  decodeDiscoverModelsResult,
  decodeLoadSnapshot,
  decodeMicrophoneAccess,
  decodeMobileConnectedDevices,
  decodeMobileConnectTicket,
  decodeMobileWebAppUrl,
  decodeNotificationOpenedEvent,
  decodeNotificationPreference,
  decodeProviderDetectionSettings,
  decodeResumeInterruptedWorkResult,
  decodeResumeOffer,
  decodeServerCreationAccess,
  decodeServerCreationAdminState,
  decodeUnreadableSecrets,
  decodeUpdatePreference,
  decodeUpdateStatus,
  decodeVoiceServerProbe,
  decodeVoiceServerSettings,
} from "./app-decoding";

const resumeOffer: InterruptedWorkOffer = {
  channels: [{ id: "c1", name: "Launch", stoppedTasks: 2 }],
  agents: [{ id: "a1", name: "Nova" }],
};

const updateStatus = {
  phase: "downloading",
  currentVersion: "1.0.0",
  availableVersion: "1.1.0",
  progress: 40,
  checkedAt: "2026-09-23T10:00:00.000Z",
  message: null,
  errorCode: null,
} satisfies UpdateStatus;

const detectedServer = {
  id: "ollama",
  name: "Ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  models: [{ id: "qwen3" }],
};

const customAgent = {
  id: "goose",
  name: "Goose",
  command: "goose",
  args: ["acp"],
  envNames: ["OPENAI_API_KEY"],
  usagePrompt: null,
  resolvedCommand: "/opt/homebrew/bin/goose",
};

const runningWork = {
  turnId: "turn-1",
  agentId: "writer",
  agentName: "Writer",
  channelId: "channel-1",
  channelName: "cadastro",
  topicName: "Main",
  taskId: "task-1",
  title: "Fix the form",
  startedAt: "2026-10-30T20:00:00.000Z",
} satisfies RunningWork;

const stoppedWork = {
  channelId: "channel-1",
  channelName: "cadastro",
  topicName: null,
  taskId: "task-2",
  title: "Publish the answer",
  reason: "The provider could not start this assignment. Resume to try again.",
  agentName: null,
  state: "paused",
  candidates: [{ agentId: "qa", name: "QA", sameModel: true }],
  auto: null,
} satisfies StoppedWork;

const loadSnapshot = {
  sampledAt: "2026-10-30T20:00:00.000Z",
  memory: { usedMb: 8192, agentsMb: 6000, totalMb: 32768 },
  activeAgents: 1,
  providerProcesses: 4,
  lane: { enabled: false, order: [], running: [], queued: [] },
  running: [runningWork],
  waiting: [{ agentId: "agent-2", agentName: "Writer" }],
  stopped: [stoppedWork],
  recovery: { enabled: false, intervalMinutes: 30, reassign: false, recent: [] },
  agentLimit: { enabled: true, max: 10 },
  taskWatch: { enabled: false, quietMinutes: 15, active: false, modelReady: false, recent: [] },
} satisfies LoadSnapshot;

const taskWatchEvent = {
  at: "2026-10-30T20:40:00.000Z",
  channelName: "cadastro",
  action: "reassigned",
  agentName: "QA",
  reason: "no-sign",
  minutes: 32,
  by: "model",
} satisfies TaskWatchEvent;

/** The snapshot while the task reviewer looks: a run that gave no sign, and what the reviewer did. */
const watchedLoadSnapshot = {
  ...loadSnapshot,
  running: [{ ...runningWork, quiet: { state: "stalled", minutes: 32 } }],
  taskWatch: { enabled: true, quietMinutes: 15, active: true, modelReady: true, recent: [taskWatchEvent] },
} satisfies LoadSnapshot;

const codeSent = {
  status: "code_sent",
  challengeId: "challenge-1",
  email: "user@example.com",
  expiresAt: 2,
  resendAvailableAt: 1,
} satisfies CentralAuthState;

// Each value is what main sends, typed as its contract, so it must come back unchanged.
const voiceServer = {
  address: "http://studio.local:8000/v1",
  hasApiKey: true,
  routes: {
    dictation: true,
    speech: false,
    transcriptionModel: "Systran/faster-whisper-large-v3",
    speechModel: null,
    voice: null,
  },
};

const serverCreationRequest = {
  id: "5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
  userId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  email: "person@example.com",
  name: null,
  reason: "The sales team needs a server.",
  status: "pending",
  createdAt: 1,
  decidedAt: null,
};

const valid: [string, (value: unknown) => unknown, unknown][] = [
  [
    "a server creation access with a denied request",
    decodeServerCreationAccess,
    {
      canCreate: false,
      administrator: false,
      creationAvailable: true,
      request: { id: "request-1", status: "denied", createdAt: 1, decidedAt: 2 },
    },
  ],
  [
    "the server creation administrator state",
    decodeServerCreationAdminState,
    {
      requests: [serverCreationRequest],
      grants: [{ userId: "user-2", email: "other@example.com", name: "Other", grantedAt: 3, note: "Ops" }],
    },
  ],
  ["a voice server", decodeVoiceServerSettings, voiceServer],
  [
    "a voice server whose saved key cannot be read",
    decodeVoiceServerSettings,
    { ...voiceServer, hasApiKey: false, apiKeyUnreadable: true },
  ],
  ["no voice server", decodeVoiceServerSettings, null],
  ["a refused microphone", decodeMicrophoneAccess, "denied"],
  ["no unreadable secret", decodeUnreadableSecrets, []],
  [
    "two unreadable secrets",
    decodeUnreadableSecrets,
    [
      { store: "voice-api-key", file: "voice-api-key.json" },
      { store: "custom-agents", file: "custom-agents.json" },
    ],
  ],
  ["a microphone grant that the system does not tell", decodeMicrophoneAccess, "unknown"],
  [
    "a voice server test that found models",
    decodeVoiceServerProbe,
    { ok: true, models: { transcription: ["whisper-1"], speech: ["kokoro"], voices: ["af_heart"] } },
  ],
  [
    "a voice server test that failed",
    decodeVoiceServerProbe,
    { ok: false, field: "apiKey", message: "studio.local:8000 refused the API key." },
  ],
  [
    "app info",
    decodeAppInfo,
    { name: "Builders Bot", version: "1.0.0", platform: "darwin", variant: "dev" } satisfies AppInfo,
  ],
  [
    "setup state",
    decodeAppSetupState,
    { completed: true, preferredProvider: "codex", preferredModel: null } satisfies AppSetupState,
  ],
  ["analytics preference", decodeAnalyticsPreference, { enabled: false }],
  [
    "approval automation",
    decodeApprovalAutomationPreference,
    {
      defaultAutoApprove: true,
      autoApproveOverrides: { "agent-1": false },
    } satisfies ApprovalAutomationPreference,
  ],
  ["language preference", decodeAppLanguagePreference, { language: "fr" }],
  ["appearance preference", decodeAppAppearancePreference, { appearance: "light", transparentWindow: true }],
  ["signed out", decodeCentralAuthState, { status: "signed_out" } satisfies CentralAuthState],
  ["code sent", decodeCentralAuthState, codeSent],
  [
    "code sent with every option",
    decodeCentralAuthState,
    {
      ...codeSent,
      developmentCode: "123456",
      issue: { code: "rate_limited", message: "Wait.", retryAfterSeconds: 30 },
    } satisfies CentralAuthState,
  ],
  [
    "signed in",
    decodeCentralAuthState,
    {
      status: "signed_in",
      user: { id: "user-1", email: "user@example.com", name: null, avatarUrl: null },
    } satisfies CentralAuthState,
  ],
  [
    "signed in with an analytics answer",
    decodeCentralAuthState,
    {
      status: "signed_in",
      user: { id: "user-1", email: "user@example.com", name: null, avatarUrl: null, analyticsEnabled: true },
    } satisfies CentralAuthState,
  ],
  [
    "account error",
    decodeCentralAuthState,
    { status: "error", issue: { code: "offline", message: "No network." } } satisfies CentralAuthState,
  ],
  ["Mobile Connect ticket", decodeMobileConnectTicket, { qrData: "openbot://mobile-connect", expiresAt: 1 }],
  ["web app address", decodeMobileWebAppUrl, "https://buildersbot.culturabuilder.com/app"],
  [
    "connected devices",
    decodeMobileConnectedDevices,
    [
      { sessionId: "session-1", name: "Phone", platform: "ios", connectedAt: 1, lastActiveAt: 2, via: "link" },
    ] satisfies MobileConnectedDevice[],
  ],
  [
    "account sessions",
    decodeAccountSessions,
    [
      { sessionId: "session-1", name: "Mac", kind: "desktop", current: true, connectedAt: 1, lastActiveAt: 2 },
    ] satisfies AccountSession[],
  ],
  ["update status", decodeUpdateStatus, updateStatus],
  ["host-managed update status", decodeUpdateStatus, { ...updateStatus, managedByHost: true } satisfies UpdateStatus],
  ["update preference", decodeUpdatePreference, { autoDownload: true, allowRemoteUpdates: true, autoInstall: false }],
  ["notification preference", decodeNotificationPreference, { desktopNotifications: true, messagePreview: false }],
  [
    "opened notification",
    decodeNotificationOpenedEvent,
    { serverId: "local", agentId: "agent-1", threadId: null } satisfies NotificationOpenedEvent,
  ],
  [
    "opened channel notification",
    decodeNotificationOpenedEvent,
    { serverId: "local", agentId: "agent-1", threadId: null, channelId: "channel-1" } satisfies NotificationOpenedEvent,
  ],
  ["chat windows", decodeChatWindowTargets, [{ serverId: "local", agentId: "agent-1" }]],
  ["detected model servers", decodeDetectedModelServers, [detectedServer]],
  ["custom agents", decodeCustomAgents, [customAgent, { ...customAgent, id: "qwen", resolvedCommand: null }]],
  ["a custom agent with a usage prompt", decodeCustomAgents, [{ ...customAgent, usagePrompt: "/usage" }]],
  [
    // The released acp-registry-v1 install codec keeps only the fields that it knew.
    "a registry install result with no usage prompt",
    decodeCustomAgentResult,
    {
      agents: [Object.fromEntries(Object.entries(customAgent).filter(([key]) => key !== "usagePrompt"))],
      restart: "not-running",
    },
  ],
  ["custom agent usage", decodeCustomAgentUsage, [{ id: "devin", text: "Plan: Pro\n42% left" }]],
  ["a model list", decodeDiscoverModelsResult, { models: [{ id: "qwen3" }] }],
  [
    "detection settings",
    decodeProviderDetectionSettings,
    { enabled: true, addresses: ["http://192.168.1.20:11434/v1"], folders: ["~/bin"], hiddenIds: [] },
  ],
  ["no resume offer", decodeResumeOffer, null],
  ["a resume offer", decodeResumeOffer, resumeOffer],
  ["a resume result with work left", decodeResumeInterruptedWorkResult, { offer: resumeOffer, failed: 1 }],
  ["a resume result with nothing left", decodeResumeInterruptedWorkResult, { offer: null, failed: 0 }],
  ["a load snapshot with the tab of each work, or no tab", decodeLoadSnapshot, loadSnapshot],
  ["a load snapshot while the task reviewer looks", decodeLoadSnapshot, watchedLoadSnapshot],
  [
    "a load snapshot with a failed start that the task reviewer left",
    decodeLoadSnapshot,
    {
      ...watchedLoadSnapshot,
      taskWatch: {
        ...watchedLoadSnapshot.taskWatch,
        recent: [
          { ...taskWatchEvent, action: "gave-up", agentName: null, reason: "start-failed", minutes: null, by: "local" },
        ],
      },
    },
  ],
  ["an agent limit at the low end", decodeAgentLimitPreference, { enabled: true, max: 1 }],
  ["an agent limit that is off", decodeAgentLimitPreference, { enabled: false, max: 64 }],
];

const malformed: [string, (value: unknown) => unknown, unknown][] = [
  ["a server creation access with no permission flag", decodeServerCreationAccess, { administrator: true }],
  [
    "a server creation access with no availability flag",
    decodeServerCreationAccess,
    { canCreate: true, administrator: false, request: null },
  ],
  [
    "a server creation request with an unknown status",
    decodeServerCreationAccess,
    {
      canCreate: false,
      administrator: false,
      creationAvailable: true,
      request: { id: "r", status: "cancelled", createdAt: 1, decidedAt: null },
    },
  ],
  [
    "an administrator state with one malformed request",
    decodeServerCreationAdminState,
    { requests: [serverCreationRequest, { ...serverCreationRequest, userId: "" }], grants: [] },
  ],
  ["a resume offer with no agent list", decodeResumeOffer, { channels: [] }],
  ["an agent limit of zero", decodeAgentLimitPreference, { enabled: true, max: 0 }],
  ["an agent limit above 64", decodeAgentLimitPreference, { enabled: true, max: 65 }],
  ["an agent limit that is not whole", decodeAgentLimitPreference, { enabled: true, max: 2.5 }],
  ["a load snapshot with no agent limit", decodeLoadSnapshot, { ...loadSnapshot, agentLimit: undefined }],
  ["a load snapshot with no task reviewer", decodeLoadSnapshot, { ...loadSnapshot, taskWatch: undefined }],
  [
    "a task reviewer threshold below 5 minutes",
    decodeLoadSnapshot,
    { ...loadSnapshot, taskWatch: { ...loadSnapshot.taskWatch, quietMinutes: 4 } },
  ],
  [
    "a task reviewer threshold above 120 minutes",
    decodeLoadSnapshot,
    { ...loadSnapshot, taskWatch: { ...loadSnapshot.taskWatch, quietMinutes: 121 } },
  ],
  [
    "a task reviewer action that does not exist",
    decodeLoadSnapshot,
    {
      ...watchedLoadSnapshot,
      taskWatch: { ...watchedLoadSnapshot.taskWatch, recent: [{ ...taskWatchEvent, action: "deleted" }] },
    },
  ],
  [
    "a task reviewer decision by an unknown judge",
    decodeLoadSnapshot,
    {
      ...watchedLoadSnapshot,
      taskWatch: { ...watchedLoadSnapshot.taskWatch, recent: [{ ...taskWatchEvent, by: "agent" }] },
    },
  ],
  [
    "more task reviewer actions than the panel lists",
    decodeLoadSnapshot,
    {
      ...watchedLoadSnapshot,
      taskWatch: { ...watchedLoadSnapshot.taskWatch, recent: Array.from({ length: 6 }, () => taskWatchEvent) },
    },
  ],
  [
    "a quiet run with minutes that are not whole",
    decodeLoadSnapshot,
    { ...loadSnapshot, running: [{ ...runningWork, quiet: { state: "stalled", minutes: 2.5 } }] },
  ],
  [
    "a quiet run in a state that does not exist",
    decodeLoadSnapshot,
    { ...loadSnapshot, running: [{ ...runningWork, quiet: { state: "dead", minutes: 40 } }] },
  ],
  [
    "a resume offer with no stopped task",
    decodeResumeOffer,
    { channels: [{ id: "c1", name: "Launch", stoppedTasks: 0 }], agents: [] },
  ],
  ["a resume offer with an empty id", decodeResumeOffer, { channels: [], agents: [{ id: "", name: "Nova" }] }],
  ["a resume result with a negative count", decodeResumeInterruptedWorkResult, { offer: null, failed: -1 }],
  [
    "stopped work with a tab name that is not text",
    decodeLoadSnapshot,
    { ...loadSnapshot, stopped: [{ ...stoppedWork, topicName: 7 }] },
  ],
  [
    "running work with no tab name",
    decodeLoadSnapshot,
    {
      ...loadSnapshot,
      running: [Object.fromEntries(Object.entries(runningWork).filter(([key]) => key !== "topicName"))],
    },
  ],
  // The key never comes back to the renderer, so a record that carries one fails closed.
  ["a voice server with its key", decodeVoiceServerSettings, { ...voiceServer, apiKey: "sk-secret" }],
  [
    "a voice server with a key state that is not a boolean",
    decodeVoiceServerSettings,
    { ...voiceServer, apiKeyUnreadable: "yes" },
  ],
  [
    "a voice server that dictates with no model",
    decodeVoiceServerSettings,
    { ...voiceServer, routes: { ...voiceServer.routes, transcriptionModel: null } },
  ],
  [
    "a voice server that speaks with no voice",
    decodeVoiceServerSettings,
    { ...voiceServer, routes: { ...voiceServer.routes, speech: true, speechModel: "kokoro", voice: null } },
  ],
  ["a voice server test with an unknown field", decodeVoiceServerProbe, { ok: false, field: "model", message: "" }],
  ["an unknown microphone grant", decodeMicrophoneAccess, "blocked"],
  ["an unreadable secret of an unknown store", decodeUnreadableSecrets, [{ store: "keychain", file: "x.json" }]],
  [
    "an unreadable secret with a path in its file name",
    decodeUnreadableSecrets,
    [{ store: "voice-api-key", file: "../voice-api-key.json" }],
  ],
  ["a microphone grant that is not text", decodeMicrophoneAccess, true],
  [
    "a voice server test with an empty model",
    decodeVoiceServerProbe,
    { ok: true, models: { transcription: [""], speech: [], voices: [] } },
  ],
  [
    "app info on an unknown platform",
    decodeAppInfo,
    { name: "Builders Bot", version: "1", platform: "aix", variant: "dev" },
  ],
  [
    "setup state with an unknown provider",
    decodeAppSetupState,
    { completed: true, preferredProvider: "other", preferredModel: null },
  ],
  ["analytics preference without a switch", decodeAnalyticsPreference, {}],
  ["approval automation without overrides", decodeApprovalAutomationPreference, { defaultAutoApprove: true }],
  ["language preference with an unknown tag", decodeAppLanguagePreference, { language: "xx" }],
  ["appearance preference with no transparent window", decodeAppAppearancePreference, { appearance: "dark" }],
  [
    "appearance preference with a string transparent window",
    decodeAppAppearancePreference,
    { appearance: "dark", transparentWindow: "true" },
  ],
  ["an unknown account status", decodeCentralAuthState, { status: "banned" }],
  ["signed in without a user", decodeCentralAuthState, { status: "signed_in" }],
  ["code sent with a text expiry", decodeCentralAuthState, { ...codeSent, expiresAt: "soon" }],
  ["Mobile Connect ticket without data", decodeMobileConnectTicket, { expiresAt: 1 }],
  [
    "a web app address on an app store",
    decodeMobileWebAppUrl,
    "https://apps.apple.com/us/app/openbot-run/id6807024266",
  ],
  ["a web app address on Google Play", decodeMobileWebAppUrl, "https://play.google.com/store/apps/details?id=x"],
  ["a web app address as a deep link", decodeMobileWebAppUrl, "openbot://mobile-connect?ticket=x"],
  ["a web app address over plain HTTP", decodeMobileWebAppUrl, "http://example.com/app"],
  ["a web app address that is not text", decodeMobileWebAppUrl, { url: "https://example.com/app" }],
  ["a device on an unknown platform", decodeMobileConnectedDevices, [{ sessionId: "s", name: "n", platform: "tv" }]],
  ["account sessions that are not a list", decodeAccountSessions, { sessionId: "s" }],
  ["update status in an unknown phase", decodeUpdateStatus, { ...updateStatus, phase: "done" }],
  ["update status with an unknown failure", decodeUpdateStatus, { ...updateStatus, errorCode: "boom" }],
  ["update preference without a switch", decodeUpdatePreference, null],
  ["notification preference without a switch", decodeNotificationPreference, { desktopNotifications: "yes" }],
  ["opened notification without an agent", decodeNotificationOpenedEvent, { serverId: "local", threadId: null }],
  [
    "opened notification with a non-string channel",
    decodeNotificationOpenedEvent,
    { serverId: "local", agentId: "agent-1", threadId: null, channelId: 7 },
  ],
  ["a chat window without an agent", decodeChatWindowTargets, [{ serverId: "local" }]],
  ["chat windows that are not a list", decodeChatWindowTargets, { serverId: "local", agentId: "agent-1" }],
  // A scan row never carries a credential, so one that does is refused with the whole list.
  ["a detected server with a key", decodeDetectedModelServers, [{ ...detectedServer, apiKey: "sk-x" }]],
  ["a detected server with headers", decodeDetectedModelServers, [{ ...detectedServer, headers: [] }]],
  // A custom agent summary never carries an environment value, so one that does is refused with the whole list.
  ["a custom agent with its environment", decodeCustomAgents, [{ ...customAgent, env: [] }]],
  ["a custom agent with its ciphertext", decodeCustomAgents, [{ ...customAgent, secret: "c2VhbGVk" }]],
  ["a custom agent with a value", decodeCustomAgents, [{ ...customAgent, value: "sk-x" }]],
  ["a custom agent with a two-line usage prompt", decodeCustomAgents, [{ ...customAgent, usagePrompt: "/usage\nrm" }]],
  ["custom agent usage of an invalid id", decodeCustomAgentUsage, [{ id: "Not An Id", text: "42%" }]],
  ["custom agent usage with no text", decodeCustomAgentUsage, [{ id: "devin", text: null }]],
  [
    "an account analytics answer that is not a yes or a no",
    decodeCentralAuthState,
    {
      status: "signed_in",
      user: { id: "user-1", email: "user@example.com", name: null, avatarUrl: null, analyticsEnabled: "yes" },
    },
  ],
  ["a model list with an empty id", decodeDiscoverModelsResult, { models: [{ id: "" }] }],
  [
    "detection settings without a switch",
    decodeProviderDetectionSettings,
    { addresses: [], folders: [], hiddenIds: [] },
  ],
];

describe("app decoding", () => {
  it.each(valid)("keeps %s unchanged", (_name, decode, value) => {
    expect(decode(value)).toEqual(value);
  });

  it.each(malformed)("rejects %s", (_name, decode, value) => {
    expect(() => decode(value)).toThrow(/^Invalid /);
  });
});
