import { emptyAnalyticsTotals, type HostAnalytics } from "@openbot/contracts/ipc";
import { onCleanup, untrack } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AgentUsagePanel } from "../src/features/usage/AgentUsagePanel";
import { mockHostAnalytics } from "../src/preview/mock-agent-analytics";
import { storyHubConnectionUsage } from "../src/preview/mock-hub-connections";
import { createMockBuildersBot } from "./mock-openbot";

function UsageStory(props: {
  state: "ready" | "empty" | "partial" | "loading" | "error" | "unsupported" | "large" | "small" | "long";
  narrow?: boolean;
  agentId?: string;
  /** Usage › Connections: the Hub's charges, or a Hub that did not answer. Absent: the Hub has them off. */
  connections?: "ready" | "unavailable";
}) {
  const previous = window.openbot;
  const mock = createMockBuildersBot();
  window.openbot = mock.api;
  const connections = untrack(() => props.connections);
  if (connections === "ready") mock.api.hubConnections.getUsage = async () => storyHubConnectionUsage("warning");
  if (connections === "unavailable")
    mock.api.hubConnections.getUsage = async () => ({ status: "unavailable", orgs: [] });
  mock.api.agent.getHostAnalytics = async (input) => {
    if (props.state === "error") throw new Error("Host is offline.");
    if (props.state === "unsupported") return null;
    if (props.state === "loading") return new Promise<HostAnalytics>(() => {});
    const data = mockHostAnalytics(input, [
      { id: "chief", provider: "codex", model: "gpt-6-astra" },
      { id: "research", provider: "claude", model: "claude-sonnet-5" },
      { id: "sales-outbound", provider: "grok", model: "grok-4.6" },
    ]);
    const factor = props.state === "large" ? 100_000 : props.state === "small" ? 0.0001 : 1;
    data.totals.estimatedCostUsd = (data.totals.estimatedCostUsd ?? 0) * factor;
    data.daily = data.daily.map((day) => ({
      ...day,
      estimatedCostUsd: day.estimatedCostUsd === null ? null : day.estimatedCostUsd * factor,
    }));
    data.models = data.models.map((model) => ({
      ...model,
      model: props.state === "long" ? `${model.model}-long-context-experimental-model-name` : model.model,
      estimatedCostUsd: model.estimatedCostUsd === null ? null : model.estimatedCostUsd * factor,
    }));
    data.agents = data.agents.map((agent) => ({
      ...agent,
      estimatedCostUsd: agent.estimatedCostUsd === null ? null : agent.estimatedCostUsd * factor,
    }));
    data.providerDaily = data.providerDaily.map((cell) => ({
      ...cell,
      estimatedCostUsd: cell.estimatedCostUsd === null ? null : cell.estimatedCostUsd * factor,
    }));
    if (props.state === "empty")
      return { ...data, totals: emptyAnalyticsTotals(), models: [], daily: [], agents: [], providerDaily: [] };
    if (props.state === "partial")
      return { ...data, totals: { ...data.totals, missingUsageTurns: 3, unpricedRecords: 2 } };
    return data;
  };
  onCleanup(() => {
    mock.dispose();
    // A story that renders again sets its own mock first; only the mock of this render goes back.
    if (window.openbot === mock.api) window.openbot = previous;
  });
  return (
    <main
      style={{
        width: props.narrow ? "390px" : "100%",
        height: "900px",
        overflow: "hidden",
        background: "var(--openbot-bg-canvas)",
      }}
    >
      <AgentUsagePanel hostName="Local host" serverId="local" agentId={props.agentId} onBack={fn()} port={mock.api} />
    </main>
  );
}
const meta = {
  title: "Agents/Usage",
  component: UsageStory,
  args: { state: "ready" },
} satisfies Meta<typeof UsageStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Usage: Story = {};
export const Empty: Story = { args: { state: "empty" } };
export const Partial: Story = { args: { state: "partial" } };
export const Loading: Story = { args: { state: "loading" } };
export const ErrorState: Story = { args: { state: "error" } };
export const Unsupported: Story = { args: { state: "unsupported" } };

export const Narrow: Story = { args: { narrow: true } };
export const LargeNumbers: Story = { args: { state: "large" } };
export const SmallCosts: Story = { args: { state: "small" } };
export const LongModelNames: Story = { args: { state: "long", narrow: true } };

export const SingleAgent: Story = { args: { agentId: "chief" } };

/** The charges of the Hub connections, apart from the model estimate, with a breakdown by platform. */
export const Connections: Story = { args: { connections: "ready" } };

export const ConnectionsNarrow: Story = { args: { connections: "ready", narrow: true } };

/** The Hub has connection usage on, but did not answer. */
export const ConnectionsUnavailable: Story = { args: { connections: "unavailable" } };
