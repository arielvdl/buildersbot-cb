import type { AgentEvent } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { FailureSignal } from "../backend/agent/failure-signal";
import type { ToolUsageSignal } from "../backend/agent/thread-items";
import type { BrowserSiteVisit } from "../backend/browser-host";
import type { WorkflowRunEnd } from "../backend/workflows/workflows";
import type { AnalyticsOperationFailure } from "./analytics-effects";
import type { ResourceProperties } from "./resource-summary";

/** The resource summary of the last closed local day, which the resource monitor keeps. */
export interface AnalyticsResourceSource {
  /** `null` when no closed day waits to be sent. */
  previousDay(): { day: string; properties: ResourceProperties } | null;
  /** Removes that day and saves the file. */
  clearPreviousDay(day: string): Effect.Effect<void, AnalyticsOperationFailure>;
}

/**
 * The product analytics and the failure reports of the desktop host. They are off in every build.
 *
 * The upstream OpenBot app sent them, with the account ID and email, to an analytics service of the
 * upstream project. Builders Bot does not control that service, so phase 0 of
 * `.openbot-build/bug-reports/DESIGN.md` removed the client and the transport. Builders Bot has no
 * diagnostics service of its own yet. Each method keeps its signature, so the callers do not change,
 * and does nothing: no event, report or identity leaves the computer or goes to a file.
 * `scripts/telemetry-destination-guard.ts` stops a merge that brings the upstream client back.
 */
export class HostAnalytics {
  handleAgentEvent(_event: AgentEvent): void {
    // No sink: see the class comment.
  }

  handleFailure(_failure: FailureSignal): void {
    // No sink: see the class comment.
  }

  handleToolUsage(_usage: ToolUsageSignal): void {
    // No sink: see the class comment.
  }

  handleWorkflowRun(_end: WorkflowRunEnd): void {
    // No sink: see the class comment.
  }

  handleSiteVisit(_visit: BrowserSiteVisit): void {
    // No sink: see the class comment.
  }

  /** The resource monitor calls it when a closed day waits. The day stays in the local summary only. */
  checkResources(): void {
    // No sink: see the class comment.
  }

  flushPending(): void {
    // No sink: see the class comment.
  }

  clear(): void {
    // No sink: see the class comment.
  }

  /** The saved preference still follows the account, but no value starts a send. */
  setTrackingEnabled(_enabled: boolean): void {
    // No sink: see the class comment.
  }

  /** Nothing runs, so there is nothing to finish. */
  close(): Effect.Effect<void> {
    return Effect.void;
  }
}
