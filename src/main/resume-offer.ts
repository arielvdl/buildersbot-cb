import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  ChannelTask,
  ConversationMessageSender,
  InterruptedWorkOffer,
  QueueDeliveryStatus,
  ResumeInterruptedWorkInput,
  ResumeInterruptedWorkResult,
} from "@openbot/contracts/ipc";
import { Deferred, Effect, Result, Schema, Semaphore } from "effect";
import type { AgentService } from "../backend/agent-service";
import type { MailboxStore } from "../backend/mailbox-store";

/**
 * The text that a resumed agent gets in its own chat. It is a prompt to the provider, so it stays in
 * English (docs/i18n.md). Boot recovery never repeats a side effect, and the agent must not either.
 */
export const RESUME_CONTINUE_TEXT =
  "Builders Bot stopped before your last turn was complete. Continue that work from where it stopped. Before you do a step again, make sure that it is not already done.";

/**
 * A delivery that had started when the previous run stopped. `chat` ran in the agent's own chat and
 * came from the user. `channel` was a channel task. `other` ran in a task, an external conversation,
 * a routine or for a teammate: the offer does not show it.
 */
export interface StartedDelivery {
  id: string;
  agentId: string;
  place: "chat" | "channel" | "other";
}

interface StartedDeliveryContext {
  delivery: { id: string; recipientAgentId: string; sender: { kind: string } };
  channelId?: string;
}

/**
 * Reads `MailboxStore.unresolvedDeliveries()` before boot recovery runs. Only ids stay: never the
 * text of a message.
 */
export function startedDeliveries(
  contexts: readonly StartedDeliveryContext[],
  lookup: { taskId(deliveryId: string): string | null; external(deliveryId: string): boolean },
): StartedDelivery[] {
  return contexts.map(({ delivery, channelId }) => ({
    id: delivery.id,
    agentId: delivery.recipientAgentId,
    place:
      channelId !== undefined
        ? "channel"
        : delivery.sender.kind === "user" && lookup.taskId(delivery.id) === null && !lookup.external(delivery.id)
          ? "chat"
          : "other",
  }));
}

/** What the offer reads after boot recovery. Each read is of the database as it is now. */
export interface ResumeOfferReader {
  deliveryStatus(deliveryId: string): QueueDeliveryStatus | null;
  /** The channel assignment that ran a delivery, or null when it or its channel is gone. */
  assignment(deliveryId: string): { channelId: string; taskId: string; state: string } | null;
  /** The agents that the user can see: a deleted or hidden agent is not in the list. */
  agents(): ReadonlyArray<{ id: string; name: string }>;
  /** Null when the channel is gone. */
  channel(channelId: string): { name: string; archived: boolean; tasks: readonly ChannelTask[] } | null;
}

export class ResumeWorkFailed extends Schema.TaggedError<ResumeWorkFailed>()("ResumeWorkFailed", {
  cause: Schema.Defect(),
}) {}

/**
 * The requests that a click in the app sends: a message in the agent's own chat, and the `resume`
 * command of a channel task. The ids make a retry of the same request idempotent.
 */
export interface ResumeOfferActions {
  continueAgent(agentId: string, clientMessageId: string): Effect.Effect<void, ResumeWorkFailed>;
  resumeChannelTask(channelId: string, taskId: string, operationId: string): Effect.Effect<void, ResumeWorkFailed>;
}

export interface ResumeOfferOptions {
  started: readonly StartedDelivery[];
  reader: ResumeOfferReader;
  actions: ResumeOfferActions;
  /** One id for each run of the app, in the request ids. */
  sessionId: string;
  /** Names the failed item by id. The cause is the error of the request; it holds no message text. */
  onFailure?: (kind: "agent" | "channel", id: string, cause: unknown) => void;
}

interface HeldOffer {
  channels: Map<string, { name: string; taskIds: string[] }>;
  agents: Map<string, { name: string }>;
}

const ACTIVE_ASSIGNMENT_STATES = new Set(["queued", "starting", "running"]);

/** A task that waits for the reader, as `stoppedChannelTasks` in the renderer reads it. */
function stoppedTask(task: ChannelTask | undefined): task is ChannelTask {
  return (task?.state === "paused" || task?.state === "failed") && Boolean(task.error);
}

/** The task that `resume` must name to start a stopped run: its root when the root stopped too. */
function stoppedRunEntry(tasks: readonly ChannelTask[], taskId: string): string | null {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!stoppedTask(task)) return null;
  const root = tasks.find((candidate) => candidate.id === task.rootTaskId);
  return stoppedTask(root) ? root.id : task.id;
}

/**
 * The offer to start again the work that a restart stopped.
 *
 * Boot recovery (`BootRecovery`, then `ChannelService.recover`) settles that work and never repeats
 * it. This class only reads what the recovery left. Main gives it the deliveries that had started
 * before the recovery ran, and calls `refresh` on queue and channel events until each one is settled.
 * The offer then holds the agents and channels whose work stopped, until the user resumes or
 * dismisses it. Nothing starts again without a click.
 */
export class ResumeOffer {
  readonly #started: readonly StartedDelivery[];
  readonly #reader: ResumeOfferReader;
  readonly #actions: ResumeOfferActions;
  readonly #sessionId: string;
  readonly #onFailure: NonNullable<ResumeOfferOptions["onFailure"]>;
  readonly #ready = Deferred.makeUnsafe<void>();
  /** One choice at a time: a second click finds the work that the first one took. */
  readonly #choices = Semaphore.makeUnsafe(1);
  #offer: HeldOffer | null = null;

  constructor(options: ResumeOfferOptions) {
    this.#started = options.started;
    this.#reader = options.reader;
    this.#actions = options.actions;
    this.#sessionId = options.sessionId;
    this.#onFailure = options.onFailure ?? (() => {});
    this.refresh();
  }

  /** True until boot recovery has settled each started delivery, or until the user dismissed. */
  get pending(): boolean {
    return !Deferred.isDoneUnsafe(this.#ready);
  }

  /** Builds the offer when boot recovery settled all the started work. Does nothing after that. */
  refresh(): void {
    if (!this.pending || !this.#settled()) return;
    this.#offer = this.#build();
    Deferred.doneUnsafe(this.#ready, Effect.void);
  }

  /** The offer. Waits until boot recovery ends; null when no work stopped or the offer was used. */
  readonly current = Effect.fn("ResumeOffer.current")(function* (this: ResumeOffer) {
    yield* Deferred.await(this.#ready);
    return this.#public();
  });

  /** "Not now". The offer does not show again in this run. */
  dismiss(): void {
    this.#offer = null;
    Deferred.doneUnsafe(this.#ready, Effect.void);
  }

  /**
   * Sends the requests for the chosen work, one at a time. The work that the user did not choose is
   * dropped, as for "Not now". The work whose request failed stays in the offer.
   */
  readonly resume = Effect.fn("ResumeOffer.resume")(function* (this: ResumeOffer, input: ResumeInterruptedWorkInput) {
    return yield* this.#choices.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* Deferred.await(this.#ready);
        const held = this.#offer;
        this.#offer = null;
        if (!held) return { offer: null, failed: 0 } satisfies ResumeInterruptedWorkResult;
        // Null chooses all. An id that the offer does not hold chooses nothing.
        const chosenChannels = "all" in input ? null : new Set(input.channelIds);
        const chosenAgents = "all" in input ? null : new Set(input.agentIds);
        const kept: HeldOffer = { channels: new Map(), agents: new Map() };
        let failed = 0;
        for (const [channelId, channel] of held.channels) {
          if (chosenChannels && !chosenChannels.has(channelId)) continue;
          const failedTasks: string[] = [];
          for (const taskId of channel.taskIds) {
            // The user can start the run in the channel before the click. A second `resume` would
            // stop that turn and start it again.
            const tasks = this.#reader.channel(channelId)?.tasks ?? [];
            if (!stoppedTask(tasks.find((candidate) => candidate.id === taskId))) continue;
            const sent = yield* Effect.result(
              this.#actions.resumeChannelTask(channelId, taskId, `resume:${this.#sessionId}:${taskId}`),
            );
            if (Result.isFailure(sent)) {
              failedTasks.push(taskId);
              this.#onFailure("channel", channelId, sent.failure.cause);
            }
          }
          if (failedTasks.length > 0) {
            failed += 1;
            kept.channels.set(channelId, { name: channel.name, taskIds: failedTasks });
          }
        }
        for (const [agentId, agent] of held.agents) {
          if (chosenAgents && !chosenAgents.has(agentId)) continue;
          const sent = yield* Effect.result(
            this.#actions.continueAgent(agentId, `resume:${this.#sessionId}:${agentId}`),
          );
          if (Result.isFailure(sent)) {
            failed += 1;
            kept.agents.set(agentId, agent);
            this.#onFailure("agent", agentId, sent.failure.cause);
          }
        }
        this.#offer = kept.channels.size > 0 || kept.agents.size > 0 ? kept : null;
        return { offer: this.#public(), failed } satisfies ResumeInterruptedWorkResult;
      }),
    );
  });

  /**
   * Boot recovery settles a started delivery when providers are ready, then `ChannelService.recover`
   * ends the channel assignment that ran it. A delivery that still starts or runs, or an assignment
   * that is still active, means the recovery has not reached it yet.
   */
  #settled(): boolean {
    return this.#started.every((started) => {
      const status = this.#reader.deliveryStatus(started.id);
      if (status === "starting" || status === "running") return false;
      if (started.place !== "channel") return true;
      const assignment = this.#reader.assignment(started.id);
      return !assignment || !ACTIVE_ASSIGNMENT_STATES.has(assignment.state);
    });
  }

  #build(): HeldOffer | null {
    const visible = new Map(this.#reader.agents().map((agent) => [agent.id, agent.name]));
    const held: HeldOffer = { channels: new Map(), agents: new Map() };
    for (const started of this.#started) {
      if (started.place === "chat") {
        const name = visible.get(started.agentId);
        if (name !== undefined && this.#reader.deliveryStatus(started.id) === "interrupted")
          held.agents.set(started.agentId, { name });
      } else if (started.place === "channel") {
        const assignment = this.#reader.assignment(started.id);
        const channel = assignment ? this.#reader.channel(assignment.channelId) : null;
        if (!assignment || !channel || channel.archived) continue;
        const entry = stoppedRunEntry(channel.tasks, assignment.taskId);
        if (!entry) continue;
        const current = held.channels.get(assignment.channelId) ?? { name: channel.name, taskIds: [] };
        if (!current.taskIds.includes(entry)) current.taskIds.push(entry);
        held.channels.set(assignment.channelId, current);
      }
    }
    return held.channels.size > 0 || held.agents.size > 0 ? held : null;
  }

  #public(): InterruptedWorkOffer | null {
    const held = this.#offer;
    if (!held) return null;
    return {
      channels: [...held.channels].map(([id, channel]) => ({
        id,
        name: channel.name,
        stoppedTasks: channel.taskIds.length,
      })),
      agents: [...held.agents].map(([id, agent]) => ({ id, name: agent.name })),
    };
  }
}

export interface LocalResumeOfferOptions {
  /** From `startedDeliveries`, read before `AgentService.initialize` starts boot recovery. */
  started: readonly StartedDelivery[];
  service: Pick<AgentService, "listAgents" | "sendMessage" | "channels" | "on" | "off">;
  mailbox: Pick<MailboxStore, "getDelivery">;
  /** The host user, as the chat and the channel name the sender of a click. */
  conversationSender: () => ConversationMessageSender | undefined;
  channelActor: () => { id: string; name: string };
  onFailure: NonNullable<ResumeOfferOptions["onFailure"]>;
}

/**
 * The offer on the agent service of this computer. It follows the queue and channel events that
 * boot recovery sends while it settles the work, and stops when the offer is ready.
 */
export function createLocalResumeOffer(options: LocalResumeOfferOptions): ResumeOffer {
  const { service, mailbox } = options;
  const { store } = service.channels;
  const offer = new ResumeOffer({
    started: options.started,
    sessionId: randomUUID(),
    onFailure: options.onFailure,
    reader: {
      deliveryStatus: (deliveryId) => mailbox.getDelivery(deliveryId)?.delivery.status ?? null,
      assignment: (deliveryId) => store.assignmentForDelivery(deliveryId),
      agents: () => service.listAgents().filter((agent) => agent.hiddenAt === undefined),
      channel: (channelId) => {
        if (!store.ids().includes(channelId)) return null;
        const channel = store.get(channelId);
        return { name: channel.name, archived: channel.archived === true, tasks: store.tasks(channelId) };
      },
    },
    actions: {
      continueAgent: (agentId, clientMessageId) =>
        service
          .sendMessage({ agentId, text: RESUME_CONTINUE_TEXT, clientMessageId }, options.conversationSender())
          .pipe(
            Effect.asVoid,
            Effect.mapError((failure) => new ResumeWorkFailed({ cause: failure })),
          ),
      // The `resume` command of the channel's own Continue button. The task joins the queue, so the
      // one-channel-at-a-time lane (`ChannelService.wake`) decides when it starts.
      resumeChannelTask: (channelId, taskId, operationId) =>
        service.channels
          .command({ type: "resume", operationId, channelId, taskId, recipientAgentId: null }, options.channelActor())
          .pipe(
            Effect.asVoid,
            Effect.mapError((failure) => new ResumeWorkFailed({ cause: failure })),
          ),
    },
  });
  if (offer.pending) {
    const followRecovery = (event: AgentEvent) => {
      if (event.type !== "queue-changed" && event.type !== "channels-changed") return;
      offer.refresh();
      if (!offer.pending) service.off("event", followRecovery);
    };
    service.on("event", followRecovery);
  }
  return offer;
}
