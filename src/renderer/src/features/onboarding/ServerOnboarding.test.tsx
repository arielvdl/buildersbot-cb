import type { AgentProviderId, AgentProviderStatus, AgentStatus, ProviderRuntimeStatus } from "@openbot/contracts/ipc";
import type { ProviderKeyApi } from "@openbot/ui/features/settings/OpenCodeKeyDialog";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, type Mock, vi } from "vitest";
import type { ProviderConnectionApi } from "../../components/provider-connection-api";
import type { HostProviderSettings } from "../settings/ProviderSettingsSection";
import { hostSetupProviderProps } from "./host-setup-provider-props";
import { ServerOnboarding } from "./ServerOnboarding";
import { createSetupProviders, SetupProviderPicker, type SetupProviderProps } from "./SetupProviderPicker";

const PI_TOO_OLD = "Pi 0.84.1 is too old. Install Pi 1.1.0 or later for native RPC and MCP support.";

const ready = (version: string): ProviderRuntimeStatus => ({ phase: "ready", progress: 100, message: null, version });
const notDownloaded: ProviderRuntimeStatus = { phase: "not-downloaded", progress: null, message: null, version: null };

function status(providers: AgentProviderStatus[]): AgentStatus {
  return {
    phase: "ready",
    cliVersion: null,
    auth: { kind: "chatgpt", email: "owner@example.com" },
    providers,
    capabilities: { chat: "ready", browser: "ready", computerUse: "unavailable" },
    message: null,
    fullAccess: true,
  };
}

/**
 * The joined server of the owner's report: ChatGPT, Claude and Builders are connected, Grok and Pi
 * are too old, the key providers that run on Pi say so too, and the host has no Cultura Builder
 * sign-in of its own.
 */
const OWNER_HOST = status([
  { id: "cultura-builder", state: "error", version: "1.18.27", message: "Cultura Builder login required." },
  { id: "codex", state: "available", version: "0.156.0", message: null, email: "owner@example.com" },
  { id: "claude", state: "available", version: "2.1.263", message: null, email: "owner@example.com" },
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
]);

const OWNER_RUNTIMES: Partial<Record<AgentProviderId, ProviderRuntimeStatus>> = {
  codex: ready("0.156.0"),
  claude: ready("2.1.263"),
  grok: notDownloaded,
  pi: notDownloaded,
  opencode: ready("1.18.27"),
};

/** Every function a provider action can reach, so a test can tell a button that does nothing. */
interface Spies {
  connect: Mock<(provider: AgentProviderId) => Promise<void>>;
  alternative: Mock<(provider: AgentProviderId) => void>;
  download: Mock<(provider: AgentProviderId) => Promise<void>>;
  cancelDownload: Mock<(provider: AgentProviderId) => Promise<void>>;
  update: Mock<(provider: AgentProviderId) => Promise<void>>;
  signIn: Mock<(provider: AgentProviderId) => Promise<void>>;
  install: Mock<(provider: AgentProviderId) => Promise<void>>;
  keyState: Mock<ProviderKeyApi["getProviderApiKeyState"]>;
}

function spies(): Spies {
  return {
    connect: vi.fn(async () => undefined),
    alternative: vi.fn(),
    download: vi.fn(async () => undefined),
    cancelDownload: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    signIn: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    keyState: vi.fn(async (provider: AgentProviderId) => ({ provider, status: "missing" as const })),
  };
}

const calls = (all: Spies) => Object.values(all).reduce((total, spy: Mock) => total + spy.mock.calls.length, 0);

function keys(all: Spies): ProviderKeyApi {
  return {
    getProviderApiKeyState: all.keyState,
    setProviderApiKey: async () => undefined,
    clearProviderApiKey: async () => undefined,
    openExternal: async () => undefined,
  };
}

/** A connection whose Connect opens a dialog for `dialog` and the browser of this computer for `browser`. */
function connection(
  all: Spies,
  routes: { dialog?: readonly AgentProviderId[]; browser?: boolean },
): ProviderConnectionApi {
  return {
    connectKind: (provider) => (routes.dialog?.includes(provider) ? "dialog" : routes.browser ? "browser" : null),
    alternativeKind: () => null,
    connect: all.connect,
    alternative: all.alternative,
    provider: () => null,
    state: () => ({ phase: "starting" }),
    opener: () => null,
    useApp: () => null,
    closeUseApp: () => undefined,
    submit: () => undefined,
    cancel: () => undefined,
    openVerificationUrl: () => undefined,
    openRelayPage: async () => undefined,
    pasteRelayAddress: async () => undefined,
  };
}

/**
 * The host as `useHostProviderSettings` gives it: runtime downloads, keys and the code routes of
 * `providers-v4`. The runtimes are read through `runtimes`, so a test can move a download along.
 */
function host(
  all: Spies,
  agentStatus: AgentStatus = OWNER_HOST,
  runtimes: () => Partial<Record<AgentProviderId, ProviderRuntimeStatus>> = () => OWNER_RUNTIMES,
): HostProviderSettings {
  return {
    agentStatus,
    get providerRuntimeStatuses() {
      return runtimes();
    },
    providerAvailableVersions: {},
    onDownloadProvider: all.download,
    onCancelProviderDownload: all.cancelDownload,
    onUpdateProvider: all.update,
    customProviders: [],
    providerKeys: keys(all),
    connection: connection(all, { dialog: ["codex", "claude", "grok", "cursor", "cline"] }),
  };
}

function renderServer(settings: HostProviderSettings) {
  render(() => (
    <ServerOnboarding serverName="marketing" setup={hostSetupProviderProps(settings)} onContinue={vi.fn()} />
  ));
}

/**
 * Clicks each button that names `provider`, and expects each click to reach one of the spies, or
 * one of `feedback`, such as the toast that says what to do.
 */
function expectNoDeadButton(all: Spies, provider: string, feedback: readonly Mock[] = []): void {
  const count = () => calls(all) + feedback.reduce((total, spy) => total + spy.mock.calls.length, 0);
  for (const button of screen.queryAllByRole("button", { name: new RegExp(provider, "u") })) {
    const before = count();
    fireEvent.click(button);
    expect(count(), `“${button.getAttribute("aria-label") ?? button.textContent}” did nothing`).toBeGreaterThan(before);
  }
}

describe("the Cultura Builder row of setup", () => {
  it("offers no button that does nothing on a joined server, whose host has no Cultura Builder sign-in", async () => {
    const all = spies();
    renderServer(host(all));
    await screen.findByRole("radiogroup", { name: "Choose the AI provider of this server" });
    expectNoDeadButton(all, "Cultura Builder");
  });

  it("offers no button that does nothing on this computer, where Connect is the sign-in", async () => {
    const all = spies();
    const setup: SetupProviderProps = {
      agentStatus: status([
        { id: "cultura-builder", state: "error", version: "1.18.27", message: "Cultura Builder login required." },
        { id: "opencode", state: "available", version: "1.18.27", message: null },
      ]),
      providerRuntimeStatuses: { opencode: ready("1.18.27") },
      onDownloadProvider: all.download,
      onCancelProviderDownload: all.cancelDownload,
      onUpdateProvider: all.update,
      onInstallProvider: all.install,
      providerKeys: keys(all),
      connection: connection(all, { browser: true }),
    };
    function PlanStep() {
      const providers = createSetupProviders(setup, undefined, { includeFree: () => false });
      return (
        <SetupProviderPicker
          providers={providers}
          ariaLabel="Providers"
          label="Providers"
          hint=""
          disabled={false}
          menuMount={undefined}
        />
      );
    }
    render(() => <PlanStep />);
    await screen.findByRole("button", { name: "Connect Cultura Builder" });
    expectNoDeadButton(all, "Cultura Builder");
    expect(all.connect).toHaveBeenCalledWith("cultura-builder");
  });
});
