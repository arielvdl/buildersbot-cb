import type {
  AccountSession,
  AppInfo,
  ApprovalAutomationPreference,
  AppSetupState,
  CentralAuthState,
  InterruptedWorkOffer,
  MobileConnectedDevice,
  NotificationOpenedEvent,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  decodeAccountSessions,
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
  decodeMobileConnectedDevices,
  decodeMobileConnectTicket,
  decodeMobileWebAppUrl,
  decodeNotificationOpenedEvent,
  decodeNotificationPreference,
  decodeProviderDetectionSettings,
  decodeResumeInterruptedWorkResult,
  decodeResumeOffer,
  decodeUpdatePreference,
  decodeUpdateStatus,
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

const codeSent = {
  status: "code_sent",
  challengeId: "challenge-1",
  email: "user@example.com",
  expiresAt: 2,
  resendAvailableAt: 1,
} satisfies CentralAuthState;

// Each value is what main sends, typed as its contract, so it must come back unchanged.
const valid: [string, (value: unknown) => unknown, unknown][] = [
  [
    "app info",
    decodeAppInfo,
    { name: "OpenBot", version: "1.0.0", platform: "darwin", variant: "dev" } satisfies AppInfo,
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
];

const malformed: [string, (value: unknown) => unknown, unknown][] = [
  ["a resume offer with no agent list", decodeResumeOffer, { channels: [] }],
  [
    "a resume offer with no stopped task",
    decodeResumeOffer,
    { channels: [{ id: "c1", name: "Launch", stoppedTasks: 0 }], agents: [] },
  ],
  ["a resume offer with an empty id", decodeResumeOffer, { channels: [], agents: [{ id: "", name: "Nova" }] }],
  ["a resume result with a negative count", decodeResumeInterruptedWorkResult, { offer: null, failed: -1 }],
  [
    "app info on an unknown platform",
    decodeAppInfo,
    { name: "OpenBot", version: "1", platform: "aix", variant: "dev" },
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
