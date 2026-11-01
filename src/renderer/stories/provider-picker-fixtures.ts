import type {
  AgentProviderStatus,
  AgentStatus,
  ClientAgentModelOption,
  ProviderRuntimeStatus,
} from "@openbot/contracts/ipc";
import { STORY_AGENT_STATUS } from "./fixtures";

/*
 * A computer as a person who makes agents has it: ChatGPT, Claude, Cursor, Builders and Cultura
 * Builder ready, Grok and the API providers waiting for a sign-in, and the CLIs it never downloaded.
 * The model picker stories and the agent dialog stories share it.
 */

const model = (
  provider: ClientAgentModelOption["provider"],
  id: string,
  name: string,
  efforts: ClientAgentModelOption["supportedReasoningEfforts"] = ["low", "medium", "high", "xhigh"],
  defaultReasoningEffort: ClientAgentModelOption["defaultReasoningEffort"] = "medium",
): ClientAgentModelOption => ({
  provider,
  id,
  name,
  description: "",
  defaultReasoningEffort,
  supportedReasoningEfforts: efforts,
});

export const PICKER_MODELS: ClientAgentModelOption[] = [
  model("codex", "gpt-6.1-sol", "GPT-6.1-Sol", ["low", "medium", "high", "xhigh"], "medium"),
  model("codex", "gpt-6-luna", "GPT-6 Luna", ["low", "medium", "high"]),
  model("codex", "gpt-6-terra", "GPT-6 Terra", ["medium", "high"]),
  model("codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium", "high", "xhigh"], "high"),
  model("claude", "claude-opus-5-5", "Claude Opus 5.5", ["low", "medium", "high", "xhigh", "max"], "high"),
  model("claude", "claude-sonnet-5-5", "Claude Sonnet 5.5", ["low", "medium", "high"], "high"),
  model("claude", "claude-haiku-5-5", "Claude Haiku 5.5", ["medium"]),
  model("claude", "claude-fable-5", "Claude Fable 5", ["low", "medium", "high"], "high"),
  model("cursor", "cursor/auto", "Auto", ["medium"]),
  model("cursor", "cursor/composer-2", "Composer 2", ["medium"]),
  model("opencode", "opencode/builders-free", "OpenCode Zen/Builders Free", ["medium"]),
  model("opencode", "zai/glm-5", "Z.AI/GLM-5", ["medium"]),
  model("cultura-builder", "cultura-builder/builder-auto", "Cultura Builder", ["medium"]),
  model("cultura-builder", "cultura-builder/builder-code", "Builder Code", ["medium"]),
  model("cultura-builder", "cultura-builder/builder-fast", "Builder Fast", ["medium"]),
];

/** OpenRouter's catalog: many labs, many models each, as the search and the long list need. */
export const PICKER_MANY_MODELS: ClientAgentModelOption[] = [
  "Anthropic",
  "Google",
  "Meta",
  "Mistral",
  "OpenAI",
  "Qwen",
].flatMap((lab) =>
  Array.from({ length: 7 }, (_, index) =>
    model(
      "openrouter",
      `${lab.toLowerCase()}/model-${index + 1}${index === 0 ? ":free" : ""}`,
      `${lab}: Model ${index + 1}`,
      ["medium"],
    ),
  ),
);

const row = (
  id: AgentProviderStatus["id"],
  state: AgentProviderStatus["state"],
  version: string | null = null,
): AgentProviderStatus => ({ id, state, version, message: null });

export const PICKER_READY_STATUS: AgentStatus = {
  ...STORY_AGENT_STATUS,
  phase: "ready",
  providers: [
    row("cultura-builder", "available"),
    { ...row("codex", "available", "0.166.0"), email: "person@example.com" },
    { ...row("claude", "available", "2.1.231"), email: "person@example.com" },
    row("grok", "sign-in-required", "0.1.0"),
    row("opencode", "available", "1.18.27"),
    row("antigravity", "not-installed"),
    row("cursor", "available", "2026.10.28"),
    row("cline", "not-installed"),
    row("pi", "not-installed"),
    row("muse", "not-installed"),
    row("inception", "sign-in-required"),
    row("deepseek", "sign-in-required"),
    row("openrouter", "sign-in-required"),
  ],
};

/** Before the first provider check answers: every provider is checked, and the host lists no model. */
export const PICKER_CHECKING_STATUS: AgentStatus = {
  ...PICKER_READY_STATUS,
  phase: "starting",
  providers: PICKER_READY_STATUS.providers?.map((provider) => ({
    ...provider,
    state: "checking" as const,
    version: null,
  })),
};

const notDownloaded: ProviderRuntimeStatus = {
  phase: "not-downloaded",
  progress: null,
  message: null,
  version: null,
  availableVersion: null,
};

const ready = (version: string): ProviderRuntimeStatus => ({
  phase: "ready",
  progress: null,
  message: null,
  version,
  availableVersion: null,
});

/** The CLIs that Builders Bot downloads: the ready providers have one, the others do not. */
export const PICKER_RUNTIMES = {
  codex: ready("0.166.0"),
  claude: ready("2.1.231"),
  grok: ready("0.1.0"),
  opencode: ready("1.18.27"),
  antigravity: notDownloaded,
  cursor: ready("2026.10.28"),
  cline: notDownloaded,
  pi: notDownloaded,
  muse: notDownloaded,
};
