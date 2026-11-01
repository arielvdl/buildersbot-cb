/**
 * The time of each step from the moment the drain takes a message to the first output of its turn.
 * Each one is a name, a whole number of milliseconds and a status word: never a text, an id or a path,
 * so the local trace (`trace.ndjson`) can keep them under the same promise as its other spans.
 *
 * - `client`: the provider client of the agent is ready; it can start the provider process.
 * - `prepare`: the channel packet or the external conversation of the message is ready.
 * - `thread`: the provider session is found or resumed (`ThreadLifecycle.ensureThread`).
 * - `review`: the security review of the person's messages (`PromptInjectionGuard.review`).
 * - `scan`: the prompt guard scan of the turn (`AgentService.scanPrompt`).
 * - `turn-start`: the provider answers `turn/start`. It opens a session that was closed for being idle
 *   (`IdleThreadPool.wake`): the status says `open`, `woke` or `unknown` for a client that cannot tell.
 * - `accepted`: the whole start, from the drain taking the message to the answer of `turn/start`.
 * - `first-output`: from `turn/started` to the first text, thinking or tool step of the provider.
 * - `message-to-output`: from the moment the message was sent to that first output, the wait that the
 *   person sees, with the queue.
 */
export type StartStage =
  | "client"
  | "prepare"
  | "thread"
  | "review"
  | "scan"
  | "turn-start"
  | "accepted"
  | "first-output"
  | "message-to-output";

export interface StartTiming {
  stage: StartStage;
  durationMs: number;
  /** A fixed status word, such as `none`, `annotated`, `open` or `woke`. */
  outcome: string;
}

/** Calls `report` with each timing. A report that throws is dropped: a timing must not fail a turn. */
export function startTimingReporter(report: ((timing: StartTiming) => void) | undefined) {
  return (stage: StartStage, startedAt: number, outcome: string): void => {
    if (!report) return;
    try {
      report({ stage, durationMs: Math.max(0, Math.round(performance.now() - startedAt)), outcome });
    } catch {
      // A timing is never worth a failed start.
    }
  };
}
