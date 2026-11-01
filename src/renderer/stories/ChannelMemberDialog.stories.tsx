import type { AgentStatus } from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import { createSignal, untrack } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AppAccessGate } from "../src/AppView";
import { AppProviders } from "../src/app-providers";
import { ChannelMemberDialog } from "../src/features/channels/ChannelMemberDialog";
import { BuildersBotPlayground } from "../src/preview/BuildersBotPlayground";
import { requireFixture, STORY_AGENTS } from "./fixtures";
import { createMockBuildersBot, type MockBuildersBotControls } from "./mock-openbot";
import {
  PICKER_CHECKING_STATUS,
  PICKER_MANY_MODELS,
  PICKER_MODELS,
  PICKER_OPENROUTER_READY_STATUS,
  PICKER_READY_STATUS,
  PICKER_RUNTIMES,
} from "./provider-picker-fixtures";

/*
 * The agent dialog of a channel, in the real app on the preview mock: the real dialog, the real
 * providers context and the real model section. `scripts/agent-model-picker-e2e.ts` opens the model
 * section of these stories at several window sizes and interface sizes.
 */

type Scenario = "ready" | "answer-after-open" | "many-models";

/** The agent that the dialog edits: none for a new agent. */
type Editing = "none" | "listed" | "not-listed";

/**
 * The event that makes the provider check answer in the `answer-after-open` story. The E2E script
 * sends it when it is ready to see the section grow: `window.dispatchEvent(new Event(...))`.
 */
const ANSWER_EVENT = "openbot-story:answer-providers";

const SCENARIO_STATUS: Record<Scenario, AgentStatus> = {
  ready: PICKER_READY_STATUS,
  "answer-after-open": PICKER_CHECKING_STATUS,
  "many-models": PICKER_OPENROUTER_READY_STATUS,
};

/**
 * The mock for one story. With `answer-after-open`, the host lists no model and checks every
 * provider until the story gets the answer event; then the check answers and the models arrive.
 */
function createStoryMock(scenario: Scenario) {
  return (options?: Parameters<typeof createMockBuildersBot>[0]) => {
    const mock = createMockBuildersBot({
      ...options,
      models: scenario === "many-models" ? [...PICKER_MODELS, ...PICKER_MANY_MODELS] : PICKER_MODELS,
      agentStatus: SCENARIO_STATUS[scenario],
      providerRuntimeSnapshot: {
        revision: 1,
        providers: PICKER_RUNTIMES,
        toolRuntimes: { bun: { phase: "ready", progress: null, message: null, version: "1.3.4" } },
      },
    });
    signInConnects(mock, scenario === "many-models" ? PICKER_OPENROUTER_READY_STATUS : PICKER_READY_STATUS);
    if (scenario === "answer-after-open") answerOnEvent(mock);
    return mock;
  };
}

function answerOnEvent(mock: MockBuildersBotControls): void {
  const listModels = mock.api.agent.listModels;
  let answered = false;
  mock.api.agent.listModels = async (serverId) => (answered ? listModels(serverId) : []);
  window.addEventListener(
    ANSWER_EVENT,
    () => {
      answered = true;
      mock.emitAgentEvent({ type: "status", status: structuredClone(PICKER_READY_STATUS) });
    },
    { once: true },
  );
}

/** Connect signs in at once, as a browser sign-in that worked: the provider can run. */
function signInConnects(mock: MockBuildersBotControls, start: AgentStatus): void {
  let status = structuredClone(start);
  mock.api.connectProvider = async (provider) => {
    status = {
      ...status,
      providers: status.providers?.map((row) => (row.id === provider ? { ...row, state: "available" as const } : row)),
    };
    return structuredClone(status);
  };
}

const RESEARCH = requireFixture(STORY_AGENTS[1], "Research agent");
const AGENT: Record<Editing, AgentProfile | undefined> = {
  none: undefined,
  listed: RESEARCH,
  // A model that its provider no longer lists.
  "not-listed": { ...RESEARCH, model: "claude-sonnet-4-5" },
};

function MemberDialogStage(props: { editing: Editing }) {
  // A story renders once for its args: a change of args renders it again.
  const agent = AGENT[untrack(() => props.editing)];
  // Closing closes the dialog, so a test sees a key that reaches the dialog and closes it.
  const [open, setOpen] = createSignal(true);
  return (
    <AppProviders>
      <AppAccessGate />
      <ChannelMemberDialog open={open()} agent={agent} onClose={() => setOpen(false)} onCreated={fn()} />
    </AppProviders>
  );
}

function MemberDialogStory(props: { scenario: Scenario; editing?: Editing }) {
  const { scenario, editing } = untrack(() => ({ scenario: props.scenario, editing: props.editing ?? "none" }));
  return (
    <BuildersBotPlayground
      dependencies={{
        createMock: createStoryMock(scenario),
        renderApp: () => <MemberDialogStage editing={editing} />,
      }}
    />
  );
}

const meta = {
  title: "Channels/Member dialog",
  component: MemberDialogStory,
  args: { scenario: "ready" },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MemberDialogStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A new agent for the channel. The model section is closed. */
export const NewAgent: Story = {};

/** The host checks its providers until the story gets the answer event, and the models arrive after. */
export const ProvidersAnswerAfterOpen: Story = {
  args: { scenario: "answer-after-open" },
};

/** OpenRouter can run, with its long catalog: the section shows the search of the models. */
export const ManyModels: Story = {
  args: { scenario: "many-models" },
};

/** An agent that is already a member, with its own model. */
export const EditAgent: Story = {
  args: { editing: "listed" },
};

/** An agent whose model its provider no longer lists: the section keeps it chosen, with a note. */
export const EditAgentModelNotListed: Story = {
  args: { editing: "not-listed" },
};
