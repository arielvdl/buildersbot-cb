// @vitest-environment node
// The order of the steps of a force, against a fake agent runtime: a queue, the turn that holds the
// agent's chat, and a Stop that can succeed, find the turn ended, fail, or wait. The real queue order
// is in `queue-force-order.test.ts`.
import { sourceText } from "@openbot/i18n/source";
import { Cause, Deferred, Effect, Exit, Result } from "effect";
import { describe, expect, it } from "vitest";
import { type LaneTurn, QueueForce, type QueueForcePort, QueueForceRefused } from "./queue-force";

const AGENT = "agent-1";

interface FakeRuntime {
  port: QueueForcePort;
  /** The person's queued messages, in queue order. */
  queue: string[];
  /** The deliveries that have started a turn. */
  started: string[];
  turn: LaneTurn | null;
  stops: LaneTurn[];
  alone: Set<string>;
  drains: number;
  queueEvents: number;
  /** What the next Stop does. */
  stopWith: (turn: LaneTurn) => Effect.Effect<boolean, { readonly cause: unknown }>;
}

function runtime(queue: string[], turn: LaneTurn | null): FakeRuntime {
  const fake: FakeRuntime = {
    queue: [...queue],
    started: [],
    turn,
    stops: [],
    alone: new Set(),
    drains: 0,
    queueEvents: 0,
    stopWith: () => Effect.succeed(true),
    port: {
      requireForceable: (_agentId, deliveryId) => {
        if (!fake.queue.includes(deliveryId)) throw new QueueForceRefused(sourceText("error.backend.forceQueuedOnly"));
      },
      moveToHead: (_agentId, deliveryId) =>
        Effect.sync(() => {
          const previous = new Map(fake.queue.map((id, index) => [id, index]));
          fake.queue = [deliveryId, ...fake.queue.filter((id) => id !== deliveryId)];
          return previous;
        }),
      restoreOrder: (_agentId, previous) =>
        Effect.sync(() => {
          fake.queue = [...fake.queue].sort(
            (left, right) =>
              (previous.get(left) ?? Number.MAX_SAFE_INTEGER) - (previous.get(right) ?? Number.MAX_SAFE_INTEGER),
          );
        }),
      isQueued: (deliveryId) => fake.queue.includes(deliveryId),
      laneTurn: () => fake.turn,
      stop: (_agentId, stopped) => {
        fake.stops.push(stopped);
        return fake.stopWith(stopped);
      },
      startAlone: (deliveryId) => fake.alone.add(deliveryId),
      forgetStartAlone: (deliveryId) => fake.alone.delete(deliveryId),
      queueChanged: () => {
        fake.queueEvents += 1;
      },
      scheduleDrain: () => {
        fake.drains += 1;
      },
    },
  };
  return fake;
}

/** What the drain does when the lane is free: the head of the queue starts, alone when forced. */
function drainHead(fake: FakeRuntime): void {
  const [head, ...rest] = fake.queue;
  if (!head) return;
  fake.started.push(head);
  fake.queue = fake.alone.has(head) ? rest : [];
}

const chatTurn = (turnId: string): LaneTurn => ({ turnId, threadId: "thread-chat", ownChat: true });
const force = (forcer: QueueForce, deliveryId: string, expectedTurnId: string | null) =>
  Effect.runPromise(forcer.force({ agentId: AGENT, deliveryId, expectedTurnId }));

describe("a force of a queued message", () => {
  it("starts the message at once on an idle agent, with no Stop", async () => {
    const fake = runtime(["m1", "m2"], null);
    const result = await force(new QueueForce(fake.port), "m2", null);
    expect(result).toEqual({ outcome: "started" });
    expect(fake.stops).toEqual([]);
    expect(fake.queue).toEqual(["m2", "m1"]);
    expect(fake.alone.has("m2")).toBe(true);
    expect(fake.drains).toBeGreaterThan(0);
    expect(fake.queueEvents).toBeGreaterThan(0);
  });

  it("stops the running turn the person saw once, and the message starts next, before the others", async () => {
    const fake = runtime(["m1", "m2", "m3"], chatTurn("turn-1"));
    const result = await force(new QueueForce(fake.port), "m3", "turn-1");
    expect(result).toEqual({ outcome: "interrupted" });
    expect(fake.stops).toEqual([chatTurn("turn-1")]);
    // The stopped turn ends, and its drain starts the head of the queue.
    fake.turn = null;
    drainHead(fake);
    expect(fake.started).toEqual(["m3"]);
    expect(fake.queue).toEqual(["m1", "m2"]);
    drainHead(fake);
    expect(fake.started).toEqual(["m3", "m1"]);
  });

  it("just sends the message when the turn ended between the click and the Stop", async () => {
    const fake = runtime(["m1", "m2"], chatTurn("turn-1"));
    // The provider answers that no turn ran: the Stop was not sent.
    fake.stopWith = () => Effect.succeed(false);
    const result = await force(new QueueForce(fake.port), "m2", "turn-1");
    expect(result).toEqual({ outcome: "started" });
    expect(fake.stops).toHaveLength(1);
    fake.turn = null;
    drainHead(fake);
    expect(fake.started).toEqual(["m2"]);
    expect(fake.queue).toEqual(["m1"]);
  });

  it("does not stop a chat turn that started after the person looked: the message waits at the head", async () => {
    const fake = runtime(["m1", "m2"], chatTurn("turn-2"));
    const result = await force(new QueueForce(fake.port), "m2", "turn-1");
    expect(result).toEqual({ outcome: "next" });
    expect(fake.stops).toEqual([]);
    expect(fake.queue).toEqual(["m2", "m1"]);
  });

  it("stops the channel turn that holds the agent's chat, which the chat shows with no turn id", async () => {
    const channelTurn: LaneTurn = { turnId: "channel-turn", threadId: "thread-channel", ownChat: false };
    const fake = runtime(["m1"], channelTurn);
    const result = await force(new QueueForce(fake.port), "m1", null);
    expect(result).toEqual({ outcome: "interrupted" });
    expect(fake.stops).toEqual([channelTurn]);
  });

  it("keeps the message in the queue, in its place, and says so when the Stop fails", async () => {
    const fake = runtime(["m1", "m2", "m3"], chatTurn("turn-1"));
    fake.stopWith = () => Effect.fail({ cause: new Error("The provider did not answer.") });
    const exit = await Effect.runPromiseExit(
      new QueueForce(fake.port).force({ agentId: AGENT, deliveryId: "m3", expectedTurnId: "turn-1" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findError(exit.cause);
      const cause = Result.isSuccess(failure) ? failure.success.cause : undefined;
      expect(cause).toBeInstanceOf(QueueForceRefused);
      expect(cause instanceof Error ? cause.message : "").toBe(sourceText("error.backend.forceStopFailed"));
    }
    expect(fake.queue).toEqual(["m1", "m2", "m3"]);
    expect(fake.alone.has("m3")).toBe(false);
  });

  it("answers started when the Stop fails because the turn ended and the message already started", async () => {
    const fake = runtime(["m1", "m2"], chatTurn("turn-1"));
    fake.stopWith = () =>
      Effect.suspend(() => {
        // The turn ended by itself while the Stop was in flight, and its drain took the head.
        fake.turn = null;
        drainHead(fake);
        return Effect.fail({ cause: new Error("No turn is running.") });
      });
    const result = await force(new QueueForce(fake.port), "m2", "turn-1");
    expect(result).toEqual({ outcome: "started" });
    expect(fake.started).toEqual(["m2"]);
    expect(fake.queue).toEqual(["m1"]);
  });

  it("sends one Stop for a double click: the second force waits for the first and gets its answer", async () => {
    const fake = runtime(["m1", "m2"], chatTurn("turn-1"));
    const release = Deferred.makeUnsafe<boolean>();
    fake.stopWith = () => Deferred.await(release);
    const forcer = new QueueForce(fake.port);
    const first = force(forcer, "m2", "turn-1");
    const second = force(forcer, "m2", "turn-1");
    await Effect.runPromise(Deferred.succeed(release, true));
    expect(await first).toEqual({ outcome: "interrupted" });
    expect(await second).toEqual({ outcome: "interrupted" });
    expect(fake.stops).toHaveLength(1);
    expect(fake.queue).toEqual(["m2", "m1"]);
  });

  it("sends no second Stop for a later click while the stopped turn still ends", async () => {
    const fake = runtime(["m1", "m2"], chatTurn("turn-1"));
    const forcer = new QueueForce(fake.port);
    expect(await force(forcer, "m2", "turn-1")).toEqual({ outcome: "interrupted" });
    expect(await force(forcer, "m2", "turn-1")).toEqual({ outcome: "interrupted" });
    expect(fake.stops).toHaveLength(1);
  });

  it("changes nothing for a message that left the queue", async () => {
    const fake = runtime(["m1"], chatTurn("turn-1"));
    const exit = await Effect.runPromiseExit(
      new QueueForce(fake.port).force({ agentId: AGENT, deliveryId: "gone", expectedTurnId: "turn-1" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.stops).toEqual([]);
    expect(fake.queue).toEqual(["m1"]);
    expect(fake.queueEvents).toBe(0);
  });
});
