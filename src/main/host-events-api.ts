import type {
  EventActivity,
  EventRoutine,
  EventRoutineRef,
  EventRoutineRun,
  EventStatus,
  ListEventActivityInput,
  ListEventRoutineRunsInput,
  ListEventRoutinesInput,
  SaveEventRoutineInput,
  SaveEventRoutineResult,
  WebhookSecret,
  WebhookTestResult,
} from "@openbot/contracts/ipc-events";
import { matchingSourceKeys } from "@openbot/i18n/source";
import { type Effect, Schema } from "effect";
import type { HubTurnOrigin } from "../backend/hub-connections/turn-origin";

/** The safe error boundary shared by local and Team API event management. */
export class HostEventsFailure extends Schema.TaggedError<HostEventsFailure>()("HostEventsFailure", {
  cause: Schema.Defect(),
}) {}

/**
 * The relay refuses a route ID for good: it was revoked, or another host or account owns it. The
 * routine then needs a new route ID.
 */
export class WebhookRouteConflict extends Schema.TaggedError<WebhookRouteConflict>()("WebhookRouteConflict", {}) {}

/**
 * Returns the catalog text that the user can act on, or `null` for an internal failure. The wrapped
 * cause can contain private backend details.
 */
export function hostEventsFailureMessage(failure: HostEventsFailure): string | null {
  const cause = failure.cause;
  return cause instanceof Error && matchingSourceKeys(cause.message).length > 0 ? cause.message : null;
}

/** Webhook routines and their received deliveries. Every operation except the status is scoped to one routine owner. */
export interface HostEventsApi {
  getStatus(): Effect.Effect<EventStatus, HostEventsFailure>;
  listRoutines(input: ListEventRoutinesInput): Effect.Effect<EventRoutine[], HostEventsFailure>;
  /** `by`: the Hub connection origin of who saves it (hub-connections/turn-origin.ts). */
  saveRoutine(
    input: SaveEventRoutineInput,
    by?: HubTurnOrigin,
  ): Effect.Effect<SaveEventRoutineResult, HostEventsFailure>;
  deleteRoutine(input: EventRoutineRef): Effect.Effect<void, HostEventsFailure>;
  testRoutine(input: EventRoutineRef, by?: HubTurnOrigin): Effect.Effect<void, HostEventsFailure>;
  /** `by`: the Hub connection origin of who gets the new secret; the person's own when absent. */
  rotateSecret(input: EventRoutineRef, by?: HubTurnOrigin): Effect.Effect<WebhookSecret, HostEventsFailure>;
  /** `by`: the Hub connection origin of who sends the test event; the person's own when absent. */
  sendTestEvent(input: EventRoutineRef, by?: HubTurnOrigin): Effect.Effect<WebhookTestResult, HostEventsFailure>;
  listActivity(input: ListEventActivityInput): Effect.Effect<EventActivity[], HostEventsFailure>;
  listRoutineRuns(input: ListEventRoutineRunsInput): Effect.Effect<EventRoutineRun[], HostEventsFailure>;
}
