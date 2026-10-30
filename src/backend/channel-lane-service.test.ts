// @vitest-environment node
// The one-channel-at-a-time lane in the service: with the mode on, only one channel starts work,
// the others wait, and the next one starts when the working one ends, in the user's order. Work that
// already runs is never stopped.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelService } from "./channel-service";
import { MailboxStore } from "./mailbox-store";
import { BuildersBotDatabase } from "./openbot-database";

const roots: string[] = [];
const databases: BuildersBotDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const actor = { id: "local", name: "You" };

function agent(id: string): AgentSummary {
  return {
    id,
    name: id,
    title: id,
    description: "Works in a channel.",
    notifications: true,
    provider: "codex",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    threadId: null,
    workspacePath: "/tmp",
    preview: "",
    updatedAt: null,
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
}

/** Three channels, each with its own writer, so the agent rule never holds one back. */
async function harness(lane: { enabled: boolean; order: string[] }, limited: ReadonlySet<string> = new Set()) {
  const root = await mkdtemp(join(tmpdir(), "channel-lane-"));
  roots.push(root);
  const database = new BuildersBotDatabase(root);
  databases.push(database);
  await Effect.runPromise(database.initialize());
  const mailbox = new MailboxStore(root, root, database);
  await Effect.runPromise(mailbox.initialize());
  const channels = ["one", "two", "three"];
  const members = channels.map((name) => agent(`writer-${name}`));
  const service = new ChannelService(database, mailbox, {
    agents: () => members,
    generate: () => Effect.succeed("{}"),
    schedule: () => {},
    interrupt: () => Effect.void,
    busy: () => false,
    usageLimited: (agentId) => limited.has(agentId),
    awaitDrain: () => Effect.void,
    changed: () => {},
    lane: () => lane,
    error: () => {},
  });
  for (const name of channels)
    await Effect.runPromise(
      service.command(
        {
          type: "save",
          operationId: `save:${name}`,
          channelId: `channel-${name}`,
          update: false,
          draft: { name, title: "", instructions: "", members: [{ agentId: `writer-${name}` }], leadAgentId: null },
        },
        actor,
      ),
    );
  const send = (name: string) =>
    Effect.runPromise(
      service.command(
        {
          type: "send",
          operationId: `send:${name}`,
          channelId: `channel-${name}`,
          text: "Do it",
          recipientAgentId: null,
          replyToMessageId: null,
          attachmentDraftIds: [],
        },
        actor,
      ),
    );
  const delivered = (name: string) => mailbox.queuedDeliveryIds(`writer-${name}`).length > 0;
  /** The work of a channel ends: its assignment and its task complete. */
  const finish = async (name: string) => {
    const channelId = `channel-${name}`;
    const assignments = service.store.assignments(channelId);
    service.store.update(service.store.get(channelId), {
      assignments: assignments.map((entry) => ({ ...entry, state: "completed" as const })),
      tasks: service.store.tasks(channelId).map((task) => ({ ...task, state: "completed" as const })),
    });
    await Effect.runPromise(service.wake(channelId));
  };
  return { service, send, delivered, finish, lane };
}

/** Lets the pumps run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("the channel lane", () => {
  it("starts every channel at once while the mode is off", async () => {
    const { send, delivered } = await harness({ enabled: false, order: [] });
    await send("one");
    await send("two");
    await settle();
    expect(delivered("one")).toBe(true);
    expect(delivered("two")).toBe(true);
  });

  it("starts one channel and holds the others while the mode is on", async () => {
    const { send, delivered, service } = await harness({ enabled: true, order: [] });
    await send("one");
    await send("two");
    await send("three");
    await settle();
    expect(delivered("one")).toBe(true);
    expect(delivered("two")).toBe(false);
    expect(delivered("three")).toBe(false);
    expect(service.laneSnapshot()).toMatchObject({
      running: ["channel-one"],
      queued: ["channel-two", "channel-three"],
    });
  });

  it("starts the next channel when the working one ends, in the order the user chose", async () => {
    const { send, delivered, finish } = await harness({ enabled: true, order: ["channel-three", "channel-two"] });
    await send("one");
    await send("two");
    await send("three");
    await settle();

    await finish("one");
    await settle();
    expect(delivered("three")).toBe(true);
    expect(delivered("two")).toBe(false);

    await finish("three");
    await settle();
    expect(delivered("two")).toBe(true);
  });

  it("keeps the work that already runs when the mode is switched on", async () => {
    const lane: { enabled: boolean; order: string[] } = { enabled: false, order: [] };
    const { send, delivered, service } = await harness(lane);
    await send("one");
    await send("two");
    await settle();
    lane.enabled = true;
    await Effect.runPromise(service.laneChanged());
    await send("three");
    await settle();
    expect(delivered("one")).toBe(true);
    expect(delivered("two")).toBe(true);
    expect(delivered("three")).toBe(false);
  });

  it("starts the waiting channels when the mode is switched off", async () => {
    const lane: { enabled: boolean; order: string[] } = { enabled: true, order: [] };
    const { send, delivered, service } = await harness(lane);
    await send("one");
    await send("two");
    await settle();
    expect(delivered("two")).toBe(false);

    lane.enabled = false;
    await Effect.runPromise(service.laneChanged());
    await settle();
    expect(delivered("two")).toBe(true);
  });

  it("runs a chosen channel beside the one that works", async () => {
    const { send, delivered, service } = await harness({ enabled: true, order: [] });
    await send("one");
    await send("two");
    await settle();
    expect(delivered("two")).toBe(false);

    await Effect.runPromise(service.runChannelNow("channel-two"));
    await settle();
    expect(delivered("two")).toBe(true);
  });

  it("does not hold the lane for a channel that cannot start", async () => {
    // The owner of channel two has spent the plan, so its task cannot start and must not block three.
    const { send, delivered, finish } = await harness(
      { enabled: true, order: ["channel-two"] },
      new Set(["writer-two"]),
    );
    await send("one");
    await send("two");
    await send("three");
    await settle();
    await finish("one");
    await settle();
    expect(delivered("two")).toBe(false);
    expect(delivered("three")).toBe(true);
  });
});
