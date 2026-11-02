// What main sends about the feed page. A snapshot or a delta of another version is refused. A card
// that is not a version 1 card, such as one with an unknown state or a text over its limit, is
// dropped and the others stay. Each value is copied field by field, so a field that the contract does
// not have never reaches the page.

import {
  FEED_ACTION_VERSION,
  type FeedActionResult,
  type FeedDelta,
  type FeedItem,
  type FeedNeed,
  type FeedSnapshot,
  type FeedStep,
  isFeedActionResult,
  isFeedDeltaEnvelope,
  isFeedItem,
  isFeedItemId,
  isFeedSnapshotEnvelope,
} from "@openbot/contracts/ipc";

function copyStep(step: FeedStep): FeedStep {
  return { at: step.at, kind: step.kind, text: step.text };
}

function copyNeed(need: FeedNeed): FeedNeed {
  return {
    kind: need.kind,
    requestId: need.requestId,
    ...(need.approvalKind === undefined ? {} : { approvalKind: need.approvalKind }),
    label: need.label,
    ...(need.guard === undefined ? {} : { guard: need.guard }),
    ...(need.questionCount === undefined ? {} : { questionCount: need.questionCount }),
    since: need.since,
    ...(need.risk === undefined ? {} : { risk: need.risk }),
    ...(need.reason === undefined ? {} : { reason: need.reason }),
    ...(need.access === undefined
      ? {}
      : {
          access: {
            ...(need.access.network === undefined ? {} : { network: need.access.network }),
            ...(need.access.read === undefined ? {} : { read: need.access.read }),
            ...(need.access.write === undefined ? {} : { write: need.access.write }),
          },
        }),
    ...(need.form === undefined ? {} : { form: { choices: [...need.form.choices], text: need.form.text } }),
  };
}

function copyItem(item: FeedItem): FeedItem {
  return {
    v: item.v,
    id: item.id,
    serverId: item.serverId,
    agentId: item.agentId,
    agentName: item.agentName,
    projectId: item.projectId,
    projectName: item.projectName,
    threadId: item.threadId,
    channelId: item.channelId,
    taskId: item.taskId,
    title: item.title,
    state: item.state,
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    endedAt: item.endedAt,
    lastStep: item.lastStep ? copyStep(item.lastStep) : null,
    steps: item.steps.map(copyStep),
    stepCount: item.stepCount,
    need: item.need ? copyNeed(item.need) : null,
    stop: item.stop
      ? {
          reason: item.stop.reason,
          source: item.stop.source,
          ...(item.stop.resetsAt === undefined ? {} : { resetsAt: item.stop.resetsAt }),
        }
      : null,
    ...(item.quiet === undefined ? {} : { quiet: { state: item.quiet.state, minutes: item.quiet.minutes } }),
    ...(item.subtasks === undefined ? {} : { subtasks: { done: item.subtasks.done, total: item.subtasks.total } }),
    ...(item.queued === undefined ? {} : { queued: item.queued }),
    ...(item.reassignTo === undefined
      ? {}
      : { reassignTo: item.reassignTo.map((candidate) => ({ agentId: candidate.agentId, name: candidate.name })) }),
    actions: [...item.actions],
    revision: item.revision,
  };
}

function decodeItems(values: readonly unknown[]): FeedItem[] {
  return values.filter(isFeedItem).map(copyItem);
}

export function decodeFeedSnapshot(value: unknown): FeedSnapshot {
  if (!isFeedSnapshotEnvelope(value)) throw new Error("Invalid feed snapshot.");
  return { v: value.v, cursor: value.cursor, items: decodeItems(value.items), truncated: value.truncated };
}

export function decodeFeedDelta(value: unknown): FeedDelta {
  if (!isFeedDeltaEnvelope(value)) throw new Error("Invalid feed delta.");
  return {
    v: value.v,
    cursor: value.cursor,
    upserts: decodeItems(value.upserts),
    removes: value.removes.filter(isFeedItemId),
  };
}

/**
 * The delta event: an invalid delta is dropped, not thrown into the listener. The next delta then
 * shows a gap in the cursor, and the page reads the snapshot again.
 */
export function decodeFeedDeltaOrNull(value: unknown): FeedDelta | null {
  return isFeedDeltaEnvelope(value) ? decodeFeedDelta(value) : null;
}

/** The answer to an action: which cards were done, and why the others were not. */
export function decodeFeedActionResult(value: unknown): FeedActionResult {
  if (!isFeedActionResult(value)) throw new Error("Invalid feed action result.");
  return {
    v: FEED_ACTION_VERSION,
    done: value.done,
    failed: value.failed.map((entry) => ({ itemId: entry.itemId, reason: entry.reason })),
  };
}
