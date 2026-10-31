import { isForeignProviderId } from "@openbot/contracts/agent-providers";
import type { ClientAgentModelOption } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { channelMemberModel } from "./channel-member-model";

const sonnet: ClientAgentModelOption = {
  provider: "claude",
  id: "claude-sonnet-5-5",
  name: "Claude Sonnet 5.5",
  description: "",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high"],
};

describe("the model of a channel member", () => {
  it("names the model, its provider mark and its reasoning", () => {
    expect(
      channelMemberModel({ provider: "claude", model: "claude-sonnet-5-5", reasoningEffort: "high" }, [sonnet]),
    ).toEqual({ provider: "claude", model: "Claude Sonnet 5.5", reasoning: "high" });
  });

  it("shows no reasoning for a model with no reasoning setting, or one that does not take the effort", () => {
    const fixed = { ...sonnet, reasoningEffortConfigurable: false };
    expect(
      channelMemberModel({ provider: "claude", model: "claude-sonnet-5-5", reasoningEffort: "medium" }, [fixed])
        .reasoning,
    ).toBeNull();
    expect(
      channelMemberModel({ provider: "claude", model: "claude-sonnet-5-5", reasoningEffort: "max" }, [sonnet])
        .reasoning,
    ).toBeNull();
  });

  it("keeps the id and the stored effort of a model that the host does not list", () => {
    expect(channelMemberModel({ provider: "codex", model: "gpt-7", reasoningEffort: "low" }, [sonnet])).toEqual({
      provider: "codex",
      model: "gpt-7",
      reasoning: "low",
    });
  });

  it("uses the neutral mark for a provider that this build does not know", () => {
    const provider = "future-provider";
    if (!isForeignProviderId(provider)) throw new Error("The test provider must be foreign.");
    expect(channelMemberModel({ provider, model: "m1", reasoningEffort: "medium" }, []).provider).toBe("unknown");
  });
});
