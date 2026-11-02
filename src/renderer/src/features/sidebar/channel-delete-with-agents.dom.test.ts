import type { ChannelSummary } from "@openbot/contracts/ipc";
import { createRoot, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { SidebarProps } from "../../../../../packages/ui/src/features/sidebar/sidebar-types";
import { createSidebarPendingStore } from "../../../../../packages/ui/src/features/sidebar/stores/pending-store";

function channel(id: string, agentIds: string[]): ChannelSummary {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: a test double has only the members that the delete confirmation reads.
  return { id, name: id, members: agentIds.map((agentId) => ({ agentId })) } as unknown as ChannelSummary;
}

function setup(onDeleteChannel: SidebarProps["onDeleteChannel"]) {
  const draft = {
    agents: [
      { id: "x", name: "X" },
      { id: "y", name: "Y" },
      { id: "z", name: "Z" },
    ],
    channels: [channel("a", ["x", "y"]), channel("b", ["y", "z"])],
    onDeleteChannel,
  };
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: a test double has only the props that the delete confirmation reads.
  const props = draft as unknown as SidebarProps;
  return createRoot((dispose) => ({
    dispose,
    store: createSidebarPendingStore({ customSectionById: () => new Map(), props }),
  }));
}

describe("deleting a channel with its exclusive agents", () => {
  it("offers only the agents that no other channel has", () => {
    const { store, dispose } = setup(vi.fn(async () => undefined));
    store.openDelete("channel", "a");
    flush();
    expect(store.channelExclusiveAgents().map((agent) => agent.id)).toEqual(["x"]);
    dispose();
  });

  it("passes no agents when the box is left unticked", async () => {
    const onDeleteChannel = vi.fn(async () => undefined);
    const { store, dispose } = setup(onDeleteChannel);
    store.openDelete("channel", "a");
    flush();
    await store.confirmDelete();
    expect(onDeleteChannel).toHaveBeenCalledWith("a", []);
    dispose();
  });

  it("passes the exclusive agents when the box is ticked", async () => {
    const onDeleteChannel = vi.fn(async () => undefined);
    const { store, dispose } = setup(onDeleteChannel);
    store.openDelete("channel", "a");
    flush();
    store.setDeleteWithAgents(true);
    flush();
    await store.confirmDelete();
    expect(onDeleteChannel).toHaveBeenCalledWith("a", ["x"]);
    dispose();
  });

  it("starts unticked for the next channel", () => {
    const { store, dispose } = setup(vi.fn(async () => undefined));
    store.openDelete("channel", "a");
    flush();
    store.setDeleteWithAgents(true);
    flush();
    store.closeDelete();
    store.openDelete("channel", "b");
    flush();
    expect(store.pending.deletion?.withAgents).toBe(false);
    dispose();
  });

  it("keeps the dialog open with the error when the delete fails", async () => {
    const { store, dispose } = setup(vi.fn(async () => Promise.reject(new Error("boom"))));
    store.openDelete("channel", "a");
    flush();
    store.setDeleteWithAgents(true);
    flush();
    await store.confirmDelete();
    flush();
    expect(store.pending.deletion?.error).not.toBeNull();
    expect(store.pending.deletion?.deleting).toBe(false);
    dispose();
  });
});
