// @vitest-environment node
// The queue order of a force, on the real mailbox store: the forced message goes first, also before a
// message that another editor holds; task and channel work keep the head; a force that does not go
// through puts the order back. `queue-force.test.ts` has the order of the steps.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { MailboxStore } from "../mailbox-store";
import { BuildersBotDatabase } from "../openbot-database";

const AGENT = "agent-1";
const roots: string[] = [];
const databases: BuildersBotDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function mailbox(): Promise<MailboxStore> {
  const root = await mkdtemp(join(tmpdir(), "queue-force-order-"));
  roots.push(root);
  const database = new BuildersBotDatabase(root);
  databases.push(database);
  await Effect.runPromise(database.initialize());
  const store = new MailboxStore(root, root, database);
  await Effect.runPromise(store.initialize());
  return store;
}

/** Queues one message of the person for the agent, in its own chat or in a task. */
async function send(store: MailboxStore, text: string, taskId?: string): Promise<string> {
  const receipt = await Effect.runPromise(
    store.enqueue({ sender: { kind: "user" }, recipientAgentIds: [AGENT], text, ...(taskId ? { taskId } : {}) }),
  );
  const [delivery] = receipt.deliveries;
  if (!delivery) throw new Error("The message has no delivery.");
  return delivery.id;
}

/** The texts of the queue that the person reads, in queue order. */
function visibleOrder(store: MailboxStore): string[] {
  return store
    .listQueue(AGENT)
    .deliveries.filter((delivery) => delivery.status === "queued")
    .map((delivery) => delivery.text);
}

describe("the queue order of a forced message", () => {
  it("goes first, and the other messages keep their order behind it", async () => {
    const store = await mailbox();
    await send(store, "first");
    await send(store, "second");
    const third = await send(store, "third");
    await Effect.runPromise(store.moveToQueueHead(AGENT, third));
    expect(visibleOrder(store)).toEqual(["third", "first", "second"]);
    expect(store.nextQueued(AGENT)?.delivery.id).toBe(third);
    // Without the drain's start-alone mark, the person's later messages would join its turn.
    expect(store.userMessagesToStartWith(third).map(({ delivery }) => delivery.text)).toEqual(["first", "second"]);
  });

  it("goes before a message that another editor holds, so the held edit does not hold the force", async () => {
    const store = await mailbox();
    const held = await send(store, "held");
    const forced = await send(store, "forced");
    store.beginQueueEdit(AGENT, held, "edit-1");
    await Effect.runPromise(store.moveToQueueHead(AGENT, forced));
    expect(visibleOrder(store)).toEqual(["forced", "held"]);
    expect(store.nextQueued(AGENT)?.delivery.id).toBe(forced);
  });

  it("refuses a message that another editor holds, and task work, and changes no order", async () => {
    const store = await mailbox();
    const task = await send(store, "task work", "task-1");
    const held = await send(store, "held");
    await send(store, "other");
    store.beginQueueEdit(AGENT, held, "edit-1");
    const before = store.queuedDeliveryIds(AGENT);
    expect(Exit.isFailure(await Effect.runPromiseExit(store.moveToQueueHead(AGENT, held)))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(store.moveToQueueHead(AGENT, task)))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(store.moveToQueueHead("agent-2", held)))).toBe(true);
    expect(store.queuedDeliveryIds(AGENT)).toEqual(before);
  });

  it("leaves task work at the head of the agent's queue", async () => {
    const store = await mailbox();
    const task = await send(store, "task work", "task-1");
    const first = await send(store, "first");
    const second = await send(store, "second");
    await Effect.runPromise(store.moveToQueueHead(AGENT, second));
    expect(store.queuedDeliveryIds(AGENT)).toEqual([task, second, first]);
  });

  it("puts the order back after a force that did not go through; a message queued since stays last", async () => {
    const store = await mailbox();
    await send(store, "first");
    await send(store, "second");
    const third = await send(store, "third");
    const previous = await Effect.runPromise(store.moveToQueueHead(AGENT, third));
    await send(store, "fourth");
    await Effect.runPromise(store.restoreQueueOrder(AGENT, previous));
    expect(visibleOrder(store)).toEqual(["first", "second", "third", "fourth"]);
  });
});
