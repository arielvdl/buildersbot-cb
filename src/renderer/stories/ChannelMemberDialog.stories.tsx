import { untrack } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AppAccessGate } from "../src/AppView";
import { AppProviders } from "../src/app-providers";
import { ChannelMemberDialog } from "../src/features/channels/ChannelMemberDialog";
import { BuildersBotPlayground } from "../src/preview/BuildersBotPlayground";
import { STORY_AGENTS } from "./fixtures";
import { createMockBuildersBot, type MockBuildersBotControls } from "./mock-openbot";
import {
  PICKER_CHECKING_STATUS,
  PICKER_MODELS,
  PICKER_READY_STATUS,
  PICKER_RUNTIMES,
} from "./provider-picker-fixtures";

/*
 * The agent dialog of a channel, in the real app on the preview mock: the real dialog, the real
 * providers context and the real model section. `scripts/agent-model-picker-e2e.ts` opens the model
 * section of these stories at several window sizes and interface sizes.
 */

type Scenario = "ready" | "answer-after-open";

/**
 * The mock for one story. With `answer-after-open`, the host lists no model and checks every
 * provider until the model section opens; then the check answers and the models arrive.
 */
function createStoryMock(scenario: Scenario) {
  return (options?: Parameters<typeof createMockBuildersBot>[0]) => {
    const mock = createMockBuildersBot({
      ...options,
      models: PICKER_MODELS,
      agentStatus: scenario === "ready" ? PICKER_READY_STATUS : PICKER_CHECKING_STATUS,
      providerRuntimeSnapshot: {
        revision: 1,
        providers: PICKER_RUNTIMES,
        toolRuntimes: { bun: { phase: "ready", progress: null, message: null, version: "1.3.4" } },
      },
    });
    if (scenario === "answer-after-open") answerAfterOpen(mock);
    return mock;
  };
}

function answerAfterOpen(mock: MockBuildersBotControls): void {
  const listModels = mock.api.agent.listModels;
  let answered = false;
  mock.api.agent.listModels = async (serverId) => (answered ? listModels(serverId) : []);
  const observer = new MutationObserver(() => {
    if (answered || !document.querySelector(".channel-member-dialog [aria-expanded='true']")) return;
    answered = true;
    observer.disconnect();
    mock.emitAgentEvent({ type: "status", status: structuredClone(PICKER_READY_STATUS) });
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-expanded"],
  });
}

function MemberDialogStage(props: { editing: boolean }) {
  // A story renders once for its args: a change of args renders it again.
  const agent = untrack(() => props.editing) ? STORY_AGENTS[1] : undefined;
  return (
    <AppProviders>
      <AppAccessGate />
      <ChannelMemberDialog open agent={agent} onClose={fn()} onCreated={fn()} />
    </AppProviders>
  );
}

function MemberDialogStory(props: { scenario: Scenario; editing?: boolean }) {
  const { scenario, editing } = untrack(() => ({ scenario: props.scenario, editing: props.editing === true }));
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

/** The host checks its providers until the model section opens, and the models arrive after. */
export const ProvidersAnswerAfterOpen: Story = {
  args: { scenario: "answer-after-open" },
};

/** An agent that is already a member, with its own model. */
export const EditAgent: Story = {
  args: { editing: true },
};
