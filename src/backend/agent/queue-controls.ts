import { agentProviderDescriptor } from "@openbot/contracts/agent-providers";
import type {
  ConversationMessageSender,
  ForceQueuedMessageInput,
  ForceQueuedMessageResult,
  QueueSnapshot,
  ReorderQueueInput,
  SteerQueuedMessageInput,
  UpdateQueuedMessageInput,
} from "@openbot/contracts/ipc";
import { QueueEditRejectedError, type QueueEditRequest } from "@openbot/contracts/team-protocol/queue-edit-v1";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Schema } from "effect";
import type { AgentStore } from "../agent-store";
import type { ChannelAssignment } from "../channel-store";
import { causeHelpers } from "../effect-boundary";
import type { MailboxStore } from "../mailbox-store";
import { decodeRecordResponse } from "../protocol";
import type { ConversationRuntime } from "./conversation-runtime";
import type { CustomEndpoints } from "./custom-endpoints";
import { agentNamesById, type DeliveryInputItem, deliveryPromptInput } from "./delivery-content";
import { type DrainScheduler, REMOVED_ENDPOINT_MESSAGE } from "./drain-scheduler";
import type { MailboxSync } from "./mailbox-sync";
import type { PromptGuardScan } from "./prompt-guard";
import type { ProviderRuntime } from "./provider-runtime";
import { type LaneTurn, QueueForce, QueueForceRefused } from "./queue-force";
import type { RoutineScheduler } from "./routine-scheduler";
import { providerForAgent } from "./thread-items";

export interface QueueControlsHooks {
  /** The channel task that owns a delivery. Read late: the channel service is built after this. */
  channelAssignment(deliveryId: string): ChannelAssignment | null;
  /**
   * The thread of the task that a delivery runs in, or null for the agent's own chat. It throws for a
   * deleted task.
   */
  taskThreadId(deliveryId: string): string | null;
  /** The prompt-injection block of a steered message, or null; see `DrainScheduler`'s hook. */
  scanPrompt(agentId: string, input: readonly DeliveryInputItem[]): Effect.Effect<PromptGuardScan | null>;
  /**
   * The Stop button's stop of a turn that holds the agent's own chat. `executionThreadId` names the
   * channel or messaging thread of the turn, and is absent for the chat itself. False when no stop
   * was sent, because the turn has ended already.
   */
  stopTurn(
    agentId: string,
    turnId: string,
    executionThreadId: string | undefined,
  ): Effect.Effect<boolean, { readonly cause: unknown }>;
}

export interface QueueControlsOptions {
  store: AgentStore;
  mailbox: MailboxStore;
  mailboxSync: MailboxSync;
  conversation: ConversationRuntime;
  providers: ProviderRuntime;
  endpoints: CustomEndpoints;
  drain: DrainScheduler;
  routines: RoutineScheduler;
  hooks: QueueControlsHooks;
}

/**
 * Owns the user's changes to messages that wait in an agent's queue: cancel, edit, update, reorder,
 * steer into the running turn, and force (stop the running turn and start the message next). Channel
 * work is refused here; the channel task controls own it.
 *
 * It never imports the agent service facade.
 */
export class QueueControls {
  readonly #store: AgentStore;
  readonly #mailbox: MailboxStore;
  readonly #mailboxSync: MailboxSync;
  readonly #conversation: ConversationRuntime;
  readonly #providers: ProviderRuntime;
  readonly #endpoints: CustomEndpoints;
  readonly #drain: DrainScheduler;
  readonly #routines: RoutineScheduler;
  readonly #hooks: QueueControlsHooks;
  readonly #force: QueueForce;

  constructor(options: QueueControlsOptions) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#mailboxSync = options.mailboxSync;
    this.#conversation = options.conversation;
    this.#providers = options.providers;
    this.#endpoints = options.endpoints;
    this.#drain = options.drain;
    this.#routines = options.routines;
    this.#hooks = options.hooks;
    this.#force = new QueueForce({
      requireForceable: (agentId, deliveryId) => this.#requireForceable(agentId, deliveryId),
      moveToHead: (agentId, deliveryId) => this.#mailbox.moveToQueueHead(agentId, deliveryId),
      restoreOrder: (agentId, previous) => this.#mailbox.restoreQueueOrder(agentId, previous),
      isQueued: (deliveryId) => this.#mailbox.getDelivery(deliveryId)?.delivery.status === "queued",
      laneTurn: (agentId) => this.#laneTurn(agentId),
      stop: (agentId, turn) =>
        this.#hooks.stopTurn(agentId, turn.turnId, turn.ownChat ? undefined : (turn.threadId ?? undefined)),
      startAlone: (deliveryId) => this.#drain.startAlone(deliveryId),
      forgetStartAlone: (deliveryId) => this.#drain.forgetStartAlone(deliveryId),
      queueChanged: (agentId) => this.#mailboxSync.emitQueue(agentId),
      scheduleDrain: (agentId) => this.#drain.scheduleDrain(agentId),
    });
  }

  /**
   * Stops the turn that holds the agent's own chat and starts this queued message next, alone. See
   * `QueueForce` for the order of the steps.
   */
  force(input: ForceQueuedMessageInput): Effect.Effect<ForceQueuedMessageResult, QueueOperationFailed> {
    return this.#force.force(input).pipe(toQueueOperationFailed);
  }

  /** Only a message of the agent's own chat that waits, and that no other editor holds, can be forced. */
  #requireForceable(agentId: string, deliveryId: string): void {
    if (this.#hooks.channelAssignment(deliveryId))
      throw new QueueForceRefused(sourceText("error.backend.useChannelTaskControls"));
    const context = this.#mailbox.getDelivery(deliveryId);
    // The queue the person reads: the agent's own chat, without channel, messaging and task work.
    const listed = this.#mailbox.listQueue(agentId).deliveries.find((delivery) => delivery.id === deliveryId);
    if (
      !context ||
      !listed ||
      context.delivery.recipientAgentId !== agentId ||
      context.delivery.status !== "queued" ||
      context.planContinuation?.queued
    )
      throw new QueueForceRefused(sourceText("error.backend.forceQueuedOnly"));
    if (listed.editing) throw new QueueForceRefused(sourceText("error.backend.forceEditing"));
  }

  /** The turn that holds the agent's own chat: of the chat itself, or of a channel or messaging thread. */
  #laneTurn(agentId: string): LaneTurn | null {
    const snapshot = this.#conversation.workingSnapshot(agentId);
    if (!snapshot?.activeTurnId) return null;
    const ownThreadId = this.#store.list().find((agent) => agent.id === agentId)?.threadId ?? null;
    return {
      turnId: snapshot.activeTurnId,
      threadId: snapshot.threadId,
      ownChat: snapshot.threadId === null || snapshot.threadId === ownThreadId,
    };
  }

  readonly cancel = Effect.fn("QueueControls.cancel")(function* (
    this: QueueControls,
    agentId: string,
    deliveryId: string,
  ): Effect.fn.Return<void, QueueOperationFailed> {
    if (this.#hooks.channelAssignment(deliveryId))
      return yield* new QueueOperationFailed({ cause: new Error(sourceText("error.backend.useChannelTaskControls")) });
    const sender = this.#mailbox.getDelivery(deliveryId)?.delivery.sender;
    yield* this.#mailbox.cancel(agentId, deliveryId).pipe(toQueueOperationFailed);
    // A forced message that the person deletes before it starts leaves no start-alone mark behind.
    this.#drain.forgetStartAlone(deliveryId);
    this.#mailboxSync.emitQueue(agentId);
    this.#drain.scheduleDrain(agentId);
    // The requester may hold the other answers until this request ends.
    if (sender?.kind === "agent") this.#drain.scheduleDrain(sender.agentId);
  }, Effect.uninterruptible);

  readonly edit = Effect.fn("QueueControls.edit")(function* (
    this: QueueControls,
    agentId: string,
    input: QueueEditRequest,
    sender?: ConversationMessageSender,
  ): Effect.fn.Return<QueueSnapshot, QueueOperationFailed> {
    const finished = yield* queueStep(() =>
      this.#mailbox.finishedQueueEditAction(agentId, input.deliveryId, input.editId),
    );
    if (finished) {
      if (input.action === "begin" || input.action === "retain-attachments")
        return yield* new QueueOperationFailed({
          cause: new QueueEditRejectedError(sourceText("error.backend.editFinished")),
        });
      // The uploads belong to an edit that is over, so they never stay behind.
      if (input.action === "save")
        yield* Effect.forEach(
          input.attachmentDraftIds,
          (id) => this.#mailbox.discardDraft(id).pipe(toQueueOperationFailed),
          {
            concurrency: "unbounded",
            discard: true,
          },
        );
      // Only a retry of the action that finished can report success. A Save that follows a
      // finished Cancel never reached the message, so the client must keep its text.
      if (input.action !== finished)
        return yield* new QueueOperationFailed({
          cause: new QueueEditRejectedError(
            finished === "cancel" ? sourceText("error.backend.editCancelled") : sourceText("error.backend.editSaved"),
          ),
        });
      if (
        input.action === "save" &&
        !this.#mailbox.matchesFinishedQueueSave(
          agentId,
          input.deliveryId,
          input.editId,
          input.text,
          input.keepAttachmentIds,
          input.attachmentDraftIds,
        )
      )
        return yield* new QueueOperationFailed({
          cause: new QueueEditRejectedError(sourceText("error.backend.editSavedDifferent")),
        });
      this.#drain.scheduleDrain(agentId);
      this.#mailboxSync.emitQueue(agentId);
      return this.#mailboxSync.queueSnapshot(agentId);
    }
    if (this.#hooks.channelAssignment(input.deliveryId))
      return yield* new QueueOperationFailed({ cause: new Error(sourceText("error.backend.useChannelTaskControls")) });
    if (input.action === "begin")
      yield* queueStep(() => this.#mailbox.beginQueueEdit(agentId, input.deliveryId, input.editId));
    else {
      if (input.action === "retain-attachments")
        yield* queueStep(() =>
          this.#mailbox.retainQueueEditAttachments(agentId, input.deliveryId, input.editId, input.attachmentDraftIds),
        );
      if (input.action === "save") {
        yield* this.#mailbox
          .updateQueuedMessage(
            agentId,
            input.deliveryId,
            input.text,
            input.keepAttachmentIds,
            input.attachmentDraftIds,
            input.editId,
            sender,
          )
          .pipe(toQueueOperationFailed);
        const snapshot = this.#conversation.snapshotToUpdate(agentId);
        if (snapshot) {
          this.#mailboxSync.syncMailboxMessages(snapshot);
          this.#conversation.emitConversation(snapshot, "queue.message-updated");
        }
      }
      if (input.action === "cancel")
        yield* queueStep(() => this.#mailbox.finishQueueEdit(agentId, input.deliveryId, input.editId));
      this.#drain.scheduleDrain(agentId);
    }
    this.#mailboxSync.emitQueue(agentId);
    return this.#mailbox.listQueue(agentId);
  }, Effect.uninterruptible);

  readonly update = Effect.fn("QueueControls.update")(function* (
    this: QueueControls,
    input: UpdateQueuedMessageInput,
    sender?: ConversationMessageSender,
  ): Effect.fn.Return<void, QueueOperationFailed> {
    if (this.#hooks.channelAssignment(input.deliveryId))
      return yield* new QueueOperationFailed({ cause: new Error(sourceText("error.backend.useChannelTaskControls")) });
    yield* this.#mailbox
      .updateQueuedMessage(
        input.agentId,
        input.deliveryId,
        input.text,
        input.keepAttachmentIds,
        input.attachmentDraftIds,
        undefined,
        sender,
      )
      .pipe(toQueueOperationFailed);
    const snapshot = this.#conversation.snapshotToUpdate(input.agentId);
    if (snapshot) this.#mailboxSync.syncMailboxMessages(snapshot);
    this.#mailboxSync.emitQueue(input.agentId);
    if (snapshot) this.#conversation.emitConversation(snapshot, "queue.message-updated");
    this.#drain.scheduleDrain(input.agentId);
  }, Effect.uninterruptible);

  readonly reorder = Effect.fn("QueueControls.reorder")(function* (
    this: QueueControls,
    input: ReorderQueueInput,
  ): Effect.fn.Return<void, QueueOperationFailed> {
    if (input.deliveryIds.some((id) => this.#hooks.channelAssignment(id)))
      return yield* new QueueOperationFailed({
        cause: new Error(sourceText("error.backend.useChannelTaskControlsWork")),
      });
    // The queue the user reads holds no channel or messaging work, so the order it sends names the
    // normal messages alone, and the mailbox reads the whole queued order. That work stays at the
    // head: it reserved the agent before these messages arrived.
    const executionDeliveryIds = this.#mailbox.queuedExecutionDeliveryIds(input.agentId);
    yield* this.#mailbox
      .reorderQueue(input.agentId, [...executionDeliveryIds, ...input.deliveryIds])
      .pipe(toQueueOperationFailed);
    this.#mailboxSync.emitQueue(input.agentId);
  }, Effect.uninterruptible);

  readonly steer = Effect.fn("QueueControls.steer")(function* (this: QueueControls, input: SteerQueuedMessageInput) {
    const agent = yield* this.#store.existing(input.agentId).pipe(toQueueOperationFailed);
    const { client, session, snapshot, context, turnId, taskThreadId } = yield* queueStep(() => {
      const client = this.#providers.requireReadyClientForAgent(agent);
      // A task message steers the task's turn, in the task's own provider session.
      const taskThreadId = this.#hooks.taskThreadId(input.deliveryId);
      const session = taskThreadId
        ? this.#store.database.activeProviderSession(taskThreadId, agent.provider)?.externalSessionId
        : this.#store.activeProviderSession(agent.id)?.externalSessionId;
      const snapshot = this.#conversation.ensureSnapshot(agent.id, taskThreadId ?? agent.threadId);
      if (!session || !snapshot.activeTurnId || snapshot.activeTurnId !== input.expectedTurnId)
        throw new Error(sourceText("error.backend.steerTurnChanged"));
      if (this.#hooks.channelAssignment(input.deliveryId))
        throw new Error(sourceText("error.backend.useChannelTaskControls"));
      const context = this.#mailbox.getDelivery(input.deliveryId);
      if (!context || context.delivery.recipientAgentId !== agent.id || context.delivery.status !== "queued")
        throw new Error(sourceText("error.backend.steerQueuedOnly"));
      const turnId = snapshot.activeTurnId;
      // Steering uses the running turn's endpoint even when the saved model has changed.
      if (!this.#endpoints.serves(this.#drain.modelForTurn(agent.id, turnId) ?? agent.model, client.provider))
        throw new Error(REMOVED_ENDPOINT_MESSAGE);
      return { client, session, snapshot, context, turnId, taskThreadId };
    });
    // A routine run in the agent's chat has its own session, which ends with the run. A message
    // steered into it would not stay in the chat's session, so it waits for the next turn.
    if (!taskThreadId && this.#conversation.routineSession(agent.id)) {
      yield* this.#mailbox.markSteerFallback(input.deliveryId, "steer-failed").pipe(toQueueOperationFailed);
      this.#mailboxSync.emitQueue(agent.id);
      return yield* new QueueOperationFailed({
        cause: new SteerUnsupportedError(sourceText("error.backend.steerRoutineRun")),
      });
    }
    if (agentProviderDescriptor(providerForAgent(agent)).steer !== "native") {
      yield* this.#mailbox.markSteerFallback(input.deliveryId, "provider-unsupported").pipe(toQueueOperationFailed);
      this.#mailboxSync.emitQueue(agent.id);
      return yield* new QueueOperationFailed({ cause: new SteerUnsupportedError() });
    }
    yield* this.#mailbox.markSteering(input.deliveryId, turnId).pipe(toQueueOperationFailed);
    this.#mailboxSync.emitQueue(agent.id);
    const prompt = deliveryPromptInput(context, {
      agentNames: agentNamesById(this.#store.list()),
      snapshot,
      routineRun: context.delivery.sender.kind === "routine" ? this.#routines.runForDelivery(input.deliveryId) : null,
      wokenWaits: context.delivery.sender.kind === "routine" ? this.#routines.wokenWaits(input.deliveryId) : [],
    });
    // The guard reads the steered message too: it joins the running turn with no drain of its own.
    const guard = (yield* this.#hooks.scanPrompt(agent.id, prompt))?.block;
    yield* client
      .request(
        "turn/steer",
        {
          threadId: session,
          expectedTurnId: turnId,
          clientUserMessageId: input.deliveryId,
          input: guard
            ? prompt.map((item, index) =>
                index === 0 && item.type === "text"
                  ? { ...item, text: `${guard}\n\n--- steered message ---\n${item.text}` }
                  : item,
              )
            : prompt,
        },
        decodeRecordResponse,
      )
      .pipe(
        toQueueOperationFailed,
        // The turn may have ended while the request was in flight, and found nothing else to start
        // with this message out of the queue, so the drain is asked again.
        Effect.tapError(() =>
          this.#mailbox.restoreUnsteered(input.deliveryId, turnId).pipe(
            toQueueOperationFailed,
            Effect.andThen(
              queueStep(() => {
                this.#mailboxSync.syncMailboxMessages(snapshot);
                this.#mailboxSync.emitQueue(agent.id);
                this.#drain.scheduleDrain(agent.id);
              }),
            ),
          ),
        ),
      );
    yield* this.#mailbox.markRunning(input.deliveryId, turnId).pipe(toQueueOperationFailed);
    yield* queueStep(() => {
      this.#mailboxSync.syncMailboxMessages(snapshot);
      this.#mailboxSync.emitQueue(agent.id);
      this.#conversation.emitConversation(snapshot, "queue.message-steered", { deliveryId: input.deliveryId });
    });
  }, Effect.uninterruptible);
}

/** The message cannot steer the running turn, so it stays queued. A refusal, not a failure. */
export class SteerUnsupportedError extends Error {
  constructor(message = sourceText("error.backend.steerUnsupported")) {
    super(message);
  }
}

export class QueueOperationFailed extends Schema.TaggedError<QueueOperationFailed>()("QueueOperationFailed", {
  cause: Schema.Defect(),
}) {}

const { sync: queueStep, rewrap: toQueueOperationFailed } = causeHelpers(QueueOperationFailed);
