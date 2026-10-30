/**
 * The work that a restart stopped, and the choice of the user about what to start again. Main reads
 * it at boot and keeps it until the window reads it. Nothing starts again until the user clicks.
 * The offer holds names and counts only, never the text of a message or a task.
 */

import { isIdentifier } from "./ipc-bounded-values";
import { isDynamicRecord, isNumber, isString } from "./runtime-values";

/** The most channels or agents in one offer or one choice. A longer list is refused. */
export const RESUME_OFFER_LIST_LIMIT = 200;

/** A channel whose tasks the restart stopped. `stoppedTasks` counts the stopped runs. */
export interface InterruptedChannelWork {
  id: string;
  name: string;
  stoppedTasks: number;
}

/** An agent whose turn in its own chat the restart stopped. */
export interface InterruptedAgentWork {
  id: string;
  name: string;
}

export interface InterruptedWorkOffer {
  channels: InterruptedChannelWork[];
  agents: InterruptedAgentWork[];
}

/** All the work of the offer, or only the channels and agents that the user selected. */
export type ResumeInterruptedWorkInput = { all: true } | { channelIds: string[]; agentIds: string[] };

export interface ResumeInterruptedWorkResult {
  /** The work that did not start again because its request failed, or null when none is left. */
  offer: InterruptedWorkOffer | null;
  /** How many of the selected channels and agents did not start again. */
  failed: number;
}

function isIdentifierList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= RESUME_OFFER_LIST_LIMIT && value.every(isIdentifier);
}

function isBoundedList<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.length <= RESUME_OFFER_LIST_LIMIT && value.every(guard);
}

function isInterruptedChannelWork(value: unknown): value is InterruptedChannelWork {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isString(value.name) &&
    isNumber(value.stoppedTasks) &&
    Number.isInteger(value.stoppedTasks) &&
    value.stoppedTasks > 0
  );
}

function isInterruptedAgentWork(value: unknown): value is InterruptedAgentWork {
  return isDynamicRecord(value) && isIdentifier(value.id) && isString(value.name);
}

export function isInterruptedWorkOffer(value: unknown): value is InterruptedWorkOffer {
  return (
    isDynamicRecord(value) &&
    isBoundedList(value.channels, isInterruptedChannelWork) &&
    isBoundedList(value.agents, isInterruptedAgentWork)
  );
}

export function isResumeInterruptedWorkResult(value: unknown): value is ResumeInterruptedWorkResult {
  return (
    isDynamicRecord(value) &&
    (value.offer === null || isInterruptedWorkOffer(value.offer)) &&
    isNumber(value.failed) &&
    Number.isInteger(value.failed) &&
    value.failed >= 0
  );
}

/** `{ all: true }` names no list, and a choice of lists has no `all`. */
export function isResumeInterruptedWorkInput(value: unknown): value is ResumeInterruptedWorkInput {
  if (!isDynamicRecord(value)) return false;
  if (value.all === true) return value.channelIds === undefined && value.agentIds === undefined;
  return value.all === undefined && isIdentifierList(value.channelIds) && isIdentifierList(value.agentIds);
}
