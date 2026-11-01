import { ProviderModelPicker } from "@openbot/ui/components/ProviderModelPicker";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_AGENT_STATUS, STORY_MODELS } from "./fixtures";
import {
  PICKER_CHECKING_STATUS,
  PICKER_MANY_MODELS,
  PICKER_MODELS,
  PICKER_OPENROUTER_READY_STATUS,
  PICKER_READY_STATUS,
  PICKER_RUNTIMES,
} from "./provider-picker-fixtures";

const args: Parameters<typeof ProviderModelPicker>[0] = {
  provider: "codex",
  value: "gpt-5.6-luna",
  modelOptions: STORY_MODELS,
  agentStatus: STORY_AGENT_STATUS,
  onChange: fn(),
};

const meta = {
  title: "Conversation/ProviderModelPicker",
  component: ProviderModelPicker,
  args,
  parameters: { layout: "centered" },
} satisfies Meta<typeof ProviderModelPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pill: Story = {
  args: { reasoningEffort: "medium", onReasoningEffortChange: fn() },
};

/** A Claude model with every effort level. */
export const AllEffortLevels: Story = {
  args: {
    provider: "claude",
    value: "claude-opus-5-5",
    modelOptions: STORY_MODELS.map((model) =>
      model.id === "claude-opus-5-5"
        ? { ...model, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] }
        : model,
    ),
    reasoningEffort: "high",
    onReasoningEffortChange: fn(),
  },
};

export const Field: Story = {
  args: { variant: "field", label: "Model" },
};

export const Disabled: Story = {
  args: { disabled: true, disabledReason: "Choose a provider first." },
};

/** Providers that cannot run stay off the rail. The agent's own provider stays, with its message. */
export const UnavailableProvidersOpen: Story = {
  args: {
    modelOptions: STORY_MODELS.filter((model) => model.provider === "claude"),
    agentStatus: {
      ...STORY_AGENT_STATUS,
      providers: STORY_AGENT_STATUS.providers?.map((provider) =>
        provider.id === "claude"
          ? provider
          : {
              ...provider,
              state: "not-installed" as const,
              version: null,
              message: provider.id === "codex" ? "Run `codex login` to use Codex." : null,
            },
      ),
    },
  },
};

/** Signed-out providers stay off the rail, and the plus opens the settings. */
export const ConnectedProvidersOnly: Story = {
  args: {
    onManageProviders: fn(),
    agentStatus: {
      ...STORY_AGENT_STATUS,
      providers: STORY_AGENT_STATUS.providers?.map((provider) =>
        provider.id === "codex" || provider.id === "claude"
          ? provider
          : { ...provider, state: "sign-in-required" as const },
      ),
    },
  },
};

export const ProviderDownloadsOpen: Story = {
  args: {
    modelOptions: STORY_MODELS.filter((model) => model.provider === "codex"),
    agentStatus: {
      ...STORY_AGENT_STATUS,
      phase: "blocked",
      providers: STORY_AGENT_STATUS.providers?.map((provider) => ({
        ...provider,
        state: "not-installed" as const,
        version: null,
        message: null,
      })),
    },
    runtimeStatuses: {
      codex: { phase: "downloading", progress: 24, message: null, version: null },
      claude: { phase: "downloading", progress: 48, message: null, version: null },
      grok: { phase: "downloading", progress: 72, message: null, version: null },
    },
    onDownloadProvider: fn(),
    onCancelProviderDownload: fn(),
    onConnectProvider: fn(),
  },
};

export const DiscoveredModels: Story = {
  args: {
    modelOptions: [
      ...STORY_MODELS,
      {
        provider: "codex",
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        description: "Codex model discovered from the local CLI.",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    ],
  },
};

export const OpenCodeCatalog: Story = {
  args: {
    provider: "opencode",
    value: "opencode/example-free/low",
    agentStatus: {
      ...STORY_AGENT_STATUS,
      providers: [{ id: "opencode", state: "available", version: "1.3.13", message: null }],
    },
    modelOptions: [
      ["cerebras/qwen", "Cerebras/Qwen"],
      ["openai/gpt", "OpenAI/GPT"],
      ["opencode/example-free", "OpenCode Zen/Example Free"],
      ["opencode/another-free", "OpenCode Zen/Another Free"],
      ["opencode/example", "OpenCode Zen/Example"],
      ["zai/glm", "Z.AI/GLM"],
    ].flatMap(([id, name]) =>
      ["", "low", "medium", "high", "xhigh"].map((effort) => ({
        provider: "opencode" as const,
        id: effort ? `${id}/${effort}` : id,
        name: effort ? `${name} (${effort})` : name,
        description: "Example model catalog",
        defaultReasoningEffort: "medium" as const,
        supportedReasoningEfforts: ["medium" as const],
      })),
    ),
  },
};

const openCodeCatalog = (entries: [string, string][]) =>
  entries.map(([id, name]) => ({
    provider: "opencode" as const,
    id,
    name,
    description: "Example model catalog",
    defaultReasoningEffort: "medium" as const,
    supportedReasoningEfforts: ["medium" as const],
  }));

export const OpenCodeLocalModels: Story = {
  args: {
    provider: "opencode",
    value: "ollama/qwen3-coder:30b",
    agentStatus: {
      ...STORY_AGENT_STATUS,
      providers: [{ id: "opencode", state: "available", version: "1.3.13", message: null }],
    },
    modelOptions: openCodeCatalog([
      ["ollama/qwen3-coder:30b", "Ollama/Qwen3 Coder 30B"],
      ["ollama/gpt-oss:120b", "Ollama/GPT-OSS 120B"],
      ["lmstudio/glm-5-air", "LM Studio/GLM-5 Air"],
      ["opencode/example-free", "OpenCode Zen/Example Free"],
      ["opencode/example", "OpenCode Zen/Example"],
      ["zai/glm", "Z.AI/GLM"],
      ["openai/gpt", "OpenAI/GPT"],
    ]),
  },
};

const openCodeStatus = {
  ...STORY_AGENT_STATUS,
  providers: [{ id: "opencode" as const, state: "available" as const, version: "1.18.27", message: null }],
};

const customProviders = [
  {
    id: "studio-local",
    name: "Studio Local",
    baseUrl: "http://127.0.0.1:11434/v1",
    hasApiKey: false,
    models: [{ id: "qwen3-coder:30b", name: "Qwen3 Coder 30B" }],
  },
  {
    id: "house-router",
    name: "House Router",
    baseUrl: "https://models.example.com/v1",
    hasApiKey: true,
    models: [{ id: "gpt-oss-120b", name: "GPT OSS 120B" }],
  },
];

/** Nothing configured: the Custom tab is the one entry point, so it must not be a dead end. */
export const CustomTabEmpty: Story = {
  args: {
    provider: "opencode",
    value: "opencode/example",
    agentStatus: openCodeStatus,
    modelOptions: openCodeCatalog([["opencode/example", "OpenCode Zen/Example"]]),
    onAddCustomProvider: fn(),
  },
};

export const CustomTabWithModels: Story = {
  args: {
    provider: "opencode",
    value: "studio-local/qwen3-coder:30b",
    agentStatus: openCodeStatus,
    customProviders,
    onAddCustomProvider: fn(),
    modelOptions: openCodeCatalog([
      ["studio-local/qwen3-coder:30b", "Studio Local/Qwen3 Coder 30B"],
      ["studio-local/gpt-oss:120b", "Studio Local/GPT-OSS 120B"],
      ["house-router/glm-5-air", "House Router/GLM-5 Air"],
      ["opencode/example-free", "OpenCode Zen/Example Free"],
      ["openai/gpt", "OpenAI/GPT"],
    ]),
  },
};

/** The same catalog on the OpenCode tab, which must not list the two custom endpoints again. */
export const OpenCodeTabExcludesCustom: Story = {
  args: {
    ...CustomTabWithModels.args,
    value: "opencode/example-free",
  },
};

/*
 * The inline section, as the new-agent dialog of a channel shows it: the choices open under the row,
 * in the box of the dialog and at its width. `scripts/agent-model-picker-e2e.ts` checks each state in
 * English and Portuguese, light and dark. These stories render fixed props, not story args: the
 * picker reads its props when it mounts, and a story opened in its own frame mounts before its args
 * arrive.
 */

type PickerProps = Parameters<typeof ProviderModelPicker>[0];

const INLINE: PickerProps = {
  variant: "field",
  inline: true,
  ariaLabel: "Agent model",
  provider: "codex",
  value: "gpt-6.1-sol",
  modelOptions: PICKER_MODELS,
  agentStatus: PICKER_READY_STATUS,
  runtimeStatuses: PICKER_RUNTIMES,
  reasoningEffort: "medium",
  onReasoningEffortChange: fn(),
  onDownloadProvider: fn(),
  onCancelProviderDownload: fn(),
  onConnectProvider: fn(),
  onChange: fn(),
};

/** The picker in the model box of the new-agent dialog, at the width of the dialog or of a narrow window. */
function InDialogBox(props: { width: number; picker?: Partial<PickerProps> }) {
  return (
    <div style={{ width: `${props.width}px`, "max-width": "100%", background: "var(--openbot-bg-surface)" }}>
      <div class="agent-settings-runtime-rows channel-member-runtime">
        <ProviderModelPicker {...INLINE} {...props.picker} />
      </div>
    </div>
  );
}

/** Closed: the row shows the provider, the model and the effort. */
export const InlineClosed: Story = {
  render: () => <InDialogBox width={408} />,
};

/** Open: the ready providers by name, the models of the chosen one, the effort and its default. */
export const InlineOpen: Story = {
  render: () => <InDialogBox width={408} picker={{ defaultOpen: true }} />,
};

/** The host still checks its providers: the agent's provider shows, the others wait under Other providers. */
export const InlineChecking: Story = {
  render: () => (
    <InDialogBox width={408} picker={{ defaultOpen: true, modelOptions: [], agentStatus: PICKER_CHECKING_STATUS }} />
  ),
};

/** The agent's provider is not downloaded: its panel says so and has the Download button. */
export const InlineProviderNotDownloaded: Story = {
  render: () => <InDialogBox width={408} picker={{ defaultOpen: true, provider: "cline", value: "cline/default" }} />,
};

/** A long catalog: the search shows, and the list scrolls in a box of a useful height. */
export const InlineManyModels: Story = {
  render: () => (
    <InDialogBox
      width={408}
      picker={{
        defaultOpen: true,
        provider: "openrouter",
        value: "openai/model-2",
        modelOptions: [...PICKER_MODELS, ...PICKER_MANY_MODELS],
        agentStatus: PICKER_OPENROUTER_READY_STATUS,
      }}
    />
  ),
};

/** The dialog in a narrow window: the providers wrap, and the effort keeps its line. */
export const InlineNarrow: Story = {
  render: () => (
    <InDialogBox
      width={300}
      picker={{ defaultOpen: true, provider: "claude", value: "claude-opus-5-5", reasoningEffort: "high" }}
    />
  ),
};

/** The popover of a field, as the agent settings show it in their settings card: the rail of marks. */
export const FieldPopover: Story = {
  render: () => (
    <div style={{ width: "296px" }}>
      <div class="settings-link-group settings-link-group-inset agent-settings-runtime-rows">
        <ProviderModelPicker {...INLINE} inline={false} defaultOpen />
      </div>
    </div>
  ),
};
