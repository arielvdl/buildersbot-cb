import type { ChannelSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { channelExclusiveAgentIds } from "../../../../../packages/ui/src/features/sidebar/channel-exclusive-agents";

function channel(id: string, agentIds: string[]): Pick<ChannelSummary, "id" | "members"> {
  return { id, members: agentIds.map((agentId) => ({ agentId })) };
}

describe("channelExclusiveAgentIds", () => {
  it("returns the members that no other channel has", () => {
    const channels = [channel("a", ["x", "y", "z"]), channel("b", ["y"]), channel("c", ["z", "w"])];
    expect(channelExclusiveAgentIds("a", channels, ["x", "y", "z", "w"])).toEqual(["x"]);
  });

  it("returns every member when the channel is the only one", () => {
    expect(channelExclusiveAgentIds("a", [channel("a", ["x", "y"])], ["x", "y"])).toEqual(["x", "y"]);
  });

  it("returns nothing when every member is in another channel", () => {
    const channels = [channel("a", ["x"]), channel("b", ["x"])];
    expect(channelExclusiveAgentIds("a", channels, ["x"])).toEqual([]);
  });

  it("skips members that are no longer in the agent list", () => {
    expect(channelExclusiveAgentIds("a", [channel("a", ["x", "gone"])], ["x"])).toEqual(["x"]);
  });

  it("counts a member once even if the channel lists it twice", () => {
    expect(channelExclusiveAgentIds("a", [channel("a", ["x", "x"])], ["x"])).toEqual(["x"]);
  });

  it("returns nothing for an unknown channel", () => {
    expect(channelExclusiveAgentIds("missing", [channel("a", ["x"])], ["x"])).toEqual([]);
  });
});
