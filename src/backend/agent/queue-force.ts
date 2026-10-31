import type { ForceQueuedMessageInput, ForceQueuedMessageResult } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Deferred, Effect, Result, Schema } from "effect";
import { causeHelpers } from "../effect-boundary";

/** A typed failure of the runtime, which carries the original cause. */
type Failure = { readonly cause: unknown };

/** The running turn that holds the agent's own chat lane. */
export interface LaneTurn {
  turnId: string;
  /** The thread of the turn: the agent's own chat, or a channel or messaging thread of the same agent. */
  threadId: string | null;
  /** True for a turn of the agent's own chat. A channel or messaging turn shows there only as a hold. */
  ownChat: boolean;
  /** The deliveries that the turn runs. */
  deliveryIds: readonly string[];
}

/**
 * What a force reads and changes. `QueueControls` gives the real queue, conversation and Stop; a test
 * gives a fake runtime.
 */
export interface QueueForcePort {
  /**
   * Throws a `QueueForceRefused` when the delivery is not a message of the agent's own queue that
   * waits and that no other editor holds.
   */
  requireForceable(agentId: string, deliveryId: string): void;
  /** Puts the delivery first among the person's queued messages. Returns the order before the change. */
  moveToHead(agentId: string, deliveryId: string): Effect.Effect<ReadonlyMap<string, number>, Failure>;
  /** Gives the queue back the order that `moveToHead` returned. */
  restoreOrder(agentId: string, previous: ReadonlyMap<string, number>): Effect.Effect<void, Failure>;
  /** Whether the delivery still waits in the queue. */
  isQueued(deliveryId: string): boolean;
  /**
   * The deliveries of the agent's own chat lane that start a turn now and have no turn id yet. When
   * there are some, it waits for the drain that starts them, so that their turn can be read. Empty
   * when no start was on its way.
   */
  settleStarts(agentId: string): Effect.Effect<readonly string[]>;
  /** The turn that holds the agent's own chat lane now, or null when none runs. */
  laneTurn(agentId: string): LaneTurn | null;
  /**
   * Why the agent's own chat lane still waits for other work when `turn` has ended, or null when the
   * head of its queue starts then. `turn` is null when no turn runs.
   */
  holdAfterStop(agentId: string, turn: LaneTurn | null): string | null;
  /** The Stop of that turn. False when no stop was sent, because the turn has ended already. */
  stop(agentId: string, turn: LaneTurn): Effect.Effect<boolean, Failure>;
  startAlone(deliveryId: string): void;
  forgetStartAlone(deliveryId: string): void;
  /** Sends the new queue to every client of this host: desktop, web client and remote clients. */
  queueChanged(agentId: string): void;
  scheduleDrain(agentId: string): void;
}

/** A force that cannot go on, with a sentence for the person. A refusal, not a host failure. */
export class QueueForceRefused extends Error {}

export class QueueForceFailed extends Schema.TaggedError<QueueForceFailed>()("QueueForceFailed", {
  cause: Schema.Defect(),
}) {}

/**
 * Forces one queued message into the conversation: it stops the turn that holds the agent's own chat,
 * as the Stop button does, and starts the message next, alone, before the other queued messages.
 *
 * The order of the steps is the safety. A start that is on its way ends first, so that the turn it
 * starts can be read. The message goes to the head of the queue before the Stop is sent, so the drain
 * that the end of the stopped turn schedules starts it, whenever that end comes. A turn that ended by
 * itself before the Stop leaves the message at the head, and the drain starts it once. A Stop that
 * fails puts the queue back as it was. A second force of the same message waits for the first one and
 * gets its answer, so one click sends one Stop.
 *
 * No Stop is sent when the message cannot start after it: channel or messaging work waits first in the
 * agent's chat, or the chat is held, for example by a compaction or by a task turn on a provider that
 * runs one turn at a time. The message then waits at the head of the queue, and the answer is `next`.
 */
export class QueueForce {
  readonly #port: QueueForcePort;
  /** The forces that run now, by agent and delivery. */
  readonly #running = new Map<string, Deferred.Deferred<ForceQueuedMessageResult, QueueForceFailed>>();
  /** The turn that a force of each delivery stopped, while that delivery waits for its end. */
  readonly #stopped = new Map<string, string>();

  constructor(port: QueueForcePort) {
    this.#port = port;
  }

  force(input: ForceQueuedMessageInput): Effect.Effect<ForceQueuedMessageResult, QueueForceFailed> {
    return Effect.suspend(() => {
      const key = `${input.agentId}\u0000${input.deliveryId}`;
      const running = this.#running.get(key);
      if (running) return Deferred.await(running);
      const done = Deferred.makeUnsafe<ForceQueuedMessageResult, QueueForceFailed>();
      this.#running.set(key, done);
      return this.#force(input).pipe(
        Effect.onExit((exit) => Deferred.done(done, exit)),
        Effect.ensuring(Effect.sync(() => this.#running.delete(key))),
      );
    });
  }

  readonly #force = Effect.fn("QueueForce.force")(function* (
    this: QueueForce,
    { agentId, deliveryId, expectedTurnId }: ForceQueuedMessageInput,
  ): Effect.fn.Return<ForceQueuedMessageResult, QueueForceFailed> {
    for (const id of [...this.#stopped.keys()]) if (!this.#port.isQueued(id)) this.#stopped.delete(id);
    yield* forceStep(() => this.#port.requireForceable(agentId, deliveryId));
    // The person saw the agent work on these deliveries, before their turn had an id.
    const starting = yield* this.#port.settleStarts(agentId);
    // The message can leave the queue, or another editor can take it, while that start ends.
    if (starting.length > 0) yield* forceStep(() => this.#port.requireForceable(agentId, deliveryId));
    const previous = yield* this.#port.moveToHead(agentId, deliveryId).pipe(toForceFailed);
    this.#port.startAlone(deliveryId);
    this.#port.queueChanged(agentId);
    const turn = this.#port.laneTurn(agentId);
    const held = this.#port.holdAfterStop(agentId, turn) !== null;
    if (!turn || held || !mayStop(turn, expectedTurnId, starting)) {
      this.#port.scheduleDrain(agentId);
      return { outcome: !turn && !held ? "started" : "next" };
    }
    // An earlier force of this message stopped this turn already, and the turn has not ended yet.
    if (this.#stopped.get(deliveryId) === turn.turnId) return { outcome: "interrupted" };
    const stopped = yield* Effect.result(this.#port.stop(agentId, turn));
    if (Result.isFailure(stopped)) {
      // The turn can end by itself while the Stop is in flight, and a provider then refuses the Stop.
      // The message is at the head, so it starts next, or the drain has started it already.
      if (!this.#port.isQueued(deliveryId) || this.#port.laneTurn(agentId)?.turnId !== turn.turnId) {
        this.#port.scheduleDrain(agentId);
        return { outcome: "started" };
      }
      this.#port.forgetStartAlone(deliveryId);
      // The order goes back on a best effort: the message stays queued either way.
      yield* this.#port.restoreOrder(agentId, previous).pipe(Effect.catch(() => Effect.void));
      this.#port.queueChanged(agentId);
      this.#port.scheduleDrain(agentId);
      return yield* new QueueForceFailed({
        cause: new QueueForceRefused(sourceText("error.backend.forceStopFailed")),
      });
    }
    // The stopped turn schedules a drain when it ends. This one starts the message when it has ended.
    this.#port.scheduleDrain(agentId);
    if (!stopped.success) return { outcome: "started" };
    this.#stopped.set(deliveryId, turn.turnId);
    return { outcome: "interrupted" };
  }, Effect.uninterruptible);
}

/**
 * Whether a force may stop this turn. The person saw it run in the agent's chat, or saw its deliveries
 * start before the turn had an id. A channel or messaging turn of the agent shows in the chat only as a
 * hold, with no turn id, so it may stop that one when the chat showed no turn. A chat turn that the
 * person did not see is never stopped: it can be the turn of the next queued message, which started in
 * between.
 */
function mayStop(turn: LaneTurn, expectedTurnId: string | null, starting: readonly string[]): boolean {
  if (turn.turnId === expectedTurnId) return true;
  if (starting.some((deliveryId) => turn.deliveryIds.includes(deliveryId))) return true;
  return !turn.ownChat && expectedTurnId === null;
}

const { sync: forceStep, rewrap: toForceFailed } = causeHelpers(QueueForceFailed);
