import { providerDisplayName } from "@openbot/contracts/agent-providers";
import {
  type AgentPickerEntry,
  agentPickerModels,
  agentPickerProviders,
  EMPTY_AGENT_PICKER_FILTER,
  filterAgentPicker,
} from "@openbot/ui/features/agents/agent-picker-filter";
import { describe, expect, it } from "vitest";

const AGENTS: AgentPickerEntry[] = [
  { id: "gran", name: "Gran Mestre", title: "Lead", provider: "claude", model: "claude-opus-5-5" },
  { id: "ferreiro", name: "ferreiro", provider: "codex", model: "gpt-6.1-terra" },
  { id: "oraculo", name: "Oráculo", provider: "codex", model: "gpt-6.1-sol" },
  { id: "terra", name: "GPT 6.1 Terra", provider: "codex", model: "gpt-6.1-terra" },
  { id: "pest", name: "Pest Código", title: "Tests", provider: "opencode", model: "glm-5" },
  { id: "member", name: "Member without a provider" },
];

const names = (agents: readonly AgentPickerEntry[]) => agents.map((agent) => agent.name);

describe("filterAgentPicker", () => {
  it("shows every agent in its order with no search and no filter", () => {
    expect(names(filterAgentPicker(AGENTS, EMPTY_AGENT_PICKER_FILTER))).toEqual(names(AGENTS));
  });

  it("finds a name without its case or accents", () => {
    expect(names(filterAgentPicker(AGENTS, { ...EMPTY_AGENT_PICKER_FILTER, search: "ORACULO" }))).toEqual(["Oráculo"]);
    expect(names(filterAgentPicker(AGENTS, { ...EMPTY_AGENT_PICKER_FILTER, search: "codigo" }))).toEqual([
      "Pest Código",
    ]);
  });

  it("puts a name that starts with the search before a name that only holds it", () => {
    expect(names(filterAgentPicker(AGENTS, { ...EMPTY_AGENT_PICKER_FILTER, search: "terra" }))).toEqual([
      "GPT 6.1 Terra",
    ]);
    const agents = [
      { id: "a", name: "Mestre de obras" },
      { id: "b", name: "Gran Mestre" },
      { id: "c", name: "Mestre" },
    ];
    expect(names(filterAgentPicker(agents, { ...EMPTY_AGENT_PICKER_FILTER, search: "mestre" }))).toEqual([
      "Mestre",
      "Mestre de obras",
      "Gran Mestre",
    ]);
  });

  it("finds the title after the name", () => {
    expect(names(filterAgentPicker(AGENTS, { ...EMPTY_AGENT_PICKER_FILTER, search: "tests" }))).toEqual([
      "Pest Código",
    ]);
  });

  it("shows nothing for a search with no match", () => {
    expect(filterAgentPicker(AGENTS, { ...EMPTY_AGENT_PICKER_FILTER, search: "zzz" })).toEqual([]);
  });

  it("keeps the agents of one provider, then of one model", () => {
    const codex = { ...EMPTY_AGENT_PICKER_FILTER, provider: "codex" as const };
    expect(names(filterAgentPicker(AGENTS, codex))).toEqual(["ferreiro", "Oráculo", "GPT 6.1 Terra"]);
    expect(names(filterAgentPicker(AGENTS, { ...codex, model: "gpt-6.1-terra" }))).toEqual([
      "ferreiro",
      "GPT 6.1 Terra",
    ]);
    expect(names(filterAgentPicker(AGENTS, { ...codex, model: "gpt-6.1-terra", search: "ferr" }))).toEqual([
      "ferreiro",
    ]);
  });

  it("does not apply a model without a provider", () => {
    expect(filterAgentPicker(AGENTS, { ...EMPTY_AGENT_PICKER_FILTER, model: "glm-5" })).toHaveLength(AGENTS.length);
  });
});

describe("agentPickerProviders", () => {
  it("gives one chip per provider, most agents first, with the provider name", () => {
    expect(agentPickerProviders(AGENTS)).toEqual([
      { value: "codex", label: providerDisplayName("codex"), count: 3 },
      { value: "claude", label: providerDisplayName("claude"), count: 1 },
      { value: "opencode", label: providerDisplayName("opencode"), count: 1 },
    ]);
  });

  it("gives no chips when there is one provider or none", () => {
    expect(agentPickerProviders(AGENTS.filter((agent) => agent.provider === "codex"))).toEqual([]);
    expect(agentPickerProviders([{ id: "a", name: "A" }])).toEqual([]);
  });
});

describe("agentPickerModels", () => {
  it("gives the models of the chosen provider, most agents first", () => {
    expect(agentPickerModels(AGENTS, "codex")).toEqual([
      { value: "gpt-6.1-terra", label: "gpt-6.1-terra", count: 2 },
      { value: "gpt-6.1-sol", label: "gpt-6.1-sol", count: 1 },
    ]);
  });

  it("gives no chips without a provider or with one model", () => {
    expect(agentPickerModels(AGENTS, null)).toEqual([]);
    expect(agentPickerModels(AGENTS, "claude")).toEqual([]);
  });
});
