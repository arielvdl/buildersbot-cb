import type { AgentProviderId, AgentStatus, ProviderRuntimeStatus } from "@openbot/contracts/ipc";
import { Toaster, toast } from "@openbot/ui";
import { onCleanup } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { hostSetupProviderProps } from "../src/features/onboarding/host-setup-provider-props";
import { ServerOnboarding } from "../src/features/onboarding/ServerOnboarding";
import type { HostProviderSettings } from "../src/features/settings/ProviderSettingsSection";
import { STORY_AGENT_STATUS } from "./fixtures";
import { createFakeConnection } from "./provider-connection-fixture";

/** A new hosted server: every CLI is on the host, and none is signed in. */
const newHostStatus: AgentStatus = {
  ...STORY_AGENT_STATUS,
  phase: "blocked",
  providers: [
    { id: "codex", state: "sign-in-required", version: "0.149.1", message: null },
    { id: "claude", state: "sign-in-required", version: "2.1.263", message: null },
    { id: "grok", state: "sign-in-required", version: "1.0.22", message: null },
    { id: "opencode", state: "sign-in-required", version: "1.18.27", message: null },
  ],
  capabilities: { ...STORY_AGENT_STATUS.capabilities, chat: "unavailable" },
};

const connectedHostStatus: AgentStatus = {
  ...newHostStatus,
  phase: "ready",
  providers: (newHostStatus.providers ?? []).map((provider) =>
    provider.id === "claude" ? { ...provider, state: "available", email: "person@example.com" } : provider,
  ),
};

const ready = (version: string): ProviderRuntimeStatus => ({ phase: "ready", progress: 100, message: null, version });
const notDownloaded: ProviderRuntimeStatus = { phase: "not-downloaded", progress: null, message: null, version: null };

const PI_TOO_OLD = "Pi 0.84.1 is too old. Install Pi 1.1.0 or later for native RPC and MCP support.";

/**
 * The host of the owner's report: ChatGPT, Claude and Builders are connected, Grok and Pi are too
 * old, the key providers that run on Pi say so too, and the host has no Cultura Builder sign-in.
 */
const reportedHostStatus: AgentStatus = {
  ...STORY_AGENT_STATUS,
  phase: "ready",
  providers: [
    { id: "cultura-builder", state: "error", version: "1.18.27", message: "Cultura Builder login required." },
    { id: "codex", state: "available", version: "0.156.0", message: null, email: "person@example.com" },
    { id: "claude", state: "available", version: "2.1.263", message: null, email: "person@example.com" },
    {
      id: "grok",
      state: "outdated",
      version: "0.2.102",
      message: "Grok CLI 0.2.102 is too old. Builders Bot requires 1.0.5 or newer.",
    },
    { id: "pi", state: "outdated", version: "0.84.1", message: PI_TOO_OLD },
    { id: "inception", state: "outdated", version: "0.84.1", message: PI_TOO_OLD },
    { id: "deepseek", state: "outdated", version: "0.84.1", message: PI_TOO_OLD },
    { id: "openrouter", state: "outdated", version: "0.84.1", message: PI_TOO_OLD },
    { id: "opencode", state: "available", version: "1.18.27", message: null },
  ],
};

/** A host without Builders: the step suggests installing it. */
const missingBuildersStatus: AgentStatus = {
  ...newHostStatus,
  providers: (newHostStatus.providers ?? []).map((provider) =>
    provider.id === "opencode" ? { ...provider, state: "not-installed", version: null } : provider,
  ),
};

const RUNTIMES: Partial<Record<AgentProviderId, ProviderRuntimeStatus>> = {
  codex: ready("0.149.1"),
  claude: ready("2.1.263"),
  grok: ready("1.0.22"),
  opencode: ready("1.18.27"),
};

function host(
  agentStatus: AgentStatus,
  runtimes: Partial<Record<AgentProviderId, ProviderRuntimeStatus>>,
): HostProviderSettings {
  return {
    agentStatus,
    providerRuntimeStatuses: runtimes,
    onDownloadProvider: fn(),
    onUpdateProvider: fn(),
    customProviders: [],
    connection: createFakeConnection({ connect: ["codex", "claude", "grok"], alternative: [], finishAfterMs: 0 }),
  };
}

type ServerOnboardingProps = Parameters<typeof ServerOnboarding>[0];

function Story(props: {
  agentStatus: AgentStatus;
  runtimes: Partial<Record<AgentProviderId, ProviderRuntimeStatus>>;
  onContinue: ServerOnboardingProps["onContinue"];
  onClose: ServerOnboardingProps["onClose"];
}) {
  onCleanup(() => toast.dismiss());
  return (
    <div style={{ height: "100vh" }}>
      <ServerOnboarding
        serverName="Ada’s server"
        setup={hostSetupProviderProps(host(props.agentStatus, props.runtimes))}
        onContinue={props.onContinue}
        onClose={props.onClose}
      />
      <Toaster />
    </div>
  );
}

const meta = {
  title: "Setup/ServerOnboarding",
  component: Story,
  args: { agentStatus: newHostStatus, runtimes: RUNTIMES, onContinue: fn(), onClose: fn() },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Story>;

export default meta;
type StoryEntry = StoryObj<typeof meta>;

/** Nothing is signed in on the host. Connect on the Claude row opens the paste sign-in. */
export const NothingConnected: StoryEntry = {};

/** The host is signed in to Claude, so Continue opens the agent form. */
export const Connected: StoryEntry = {
  args: { agentStatus: connectedHostStatus },
};

/**
 * The screen of the owner's report. Builders is first and recommended, then the connected accounts.
 * Cultura Builder, Grok, Pi and the key providers that wait for Pi are in "More providers".
 */
export const ReportedHost: StoryEntry = {
  args: {
    agentStatus: reportedHostStatus,
    runtimes: {
      codex: ready("0.156.0"),
      claude: ready("2.1.263"),
      grok: notDownloaded,
      pi: notDownloaded,
      opencode: ready("1.18.27"),
    },
  },
};

/** The host has no Builders: the step suggests installing it, and Builders is the choice. */
export const BuildersMissing: StoryEntry = {
  args: { agentStatus: missingBuildersStatus, runtimes: { ...RUNTIMES, opencode: notDownloaded } },
};

/** Builders downloads on the host: the suggestion shows the progress. */
export const BuildersInstalling: StoryEntry = {
  args: {
    agentStatus: missingBuildersStatus,
    runtimes: { ...RUNTIMES, opencode: { ...notDownloaded, phase: "downloading", progress: 42 } },
  },
};

/** The Builders download failed: the suggestion says why and offers it again. */
export const BuildersFailed: StoryEntry = {
  args: {
    agentStatus: missingBuildersStatus,
    runtimes: {
      ...RUNTIMES,
      opencode: { ...notDownloaded, phase: "download-error", message: "The download stopped. Check the connection." },
    },
  },
};
