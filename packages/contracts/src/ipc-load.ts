/**
 * The load of this computer, and the one-channel-at-a-time mode that keeps it low. The window reads
 * a snapshot of both and changes the mode; the main process owns the preference and the sampling.
 */

import { isIdentifier } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isNumber } from "./runtime-values";

/** The most channels the user's order holds. A longer list is cut, not refused. */
export const LOAD_LANE_ORDER_LIMIT = 500;

/** The mode as it is stored and as it crosses IPC. The order is the channels the user chose first. */
export interface LoadLanePreference {
  enabled: boolean;
  order: string[];
}

export const DEFAULT_LOAD_LANE_PREFERENCE: LoadLanePreference = { enabled: false, order: [] };

export function isLoadLanePreference(value: unknown): value is LoadLanePreference {
  return (
    isDynamicRecord(value) &&
    isBoolean(value.enabled) &&
    Array.isArray(value.order) &&
    value.order.length <= LOAD_LANE_ORDER_LIMIT &&
    value.order.every(isIdentifier)
  );
}

/** The channels the lane shows: the ones that work, and the ones that wait, in start order. */
export interface LoadLaneState extends LoadLanePreference {
  running: string[];
  queued: string[];
}

export interface LoadSnapshot {
  /** When memory was last sampled, or null before the first sample. */
  sampledAt: string | null;
  /** Memory in MB: all of Builders Bot and its agents, the agents' part of it, and the computer's. */
  memory: { usedMb: number | null; agentsMb: number | null; totalMb: number };
  /** Agents that run a turn now. */
  activeAgents: number;
  /** Processes the agents' providers run. */
  providerProcesses: number;
  lane: LoadLaneState;
}

function isIdentifierList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= LOAD_LANE_ORDER_LIMIT && value.every(isIdentifier);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

export function isLoadSnapshot(value: unknown): value is LoadSnapshot {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.memory) || !isDynamicRecord(value.lane)) return false;
  return (
    (value.sampledAt === null || typeof value.sampledAt === "string") &&
    isNullableNumber(value.memory.usedMb) &&
    isNullableNumber(value.memory.agentsMb) &&
    isNumber(value.memory.totalMb) &&
    isNumber(value.activeAgents) &&
    isNumber(value.providerProcesses) &&
    isBoolean(value.lane.enabled) &&
    isIdentifierList(value.lane.order) &&
    isIdentifierList(value.lane.running) &&
    isIdentifierList(value.lane.queued)
  );
}

export interface RunChannelNowInput {
  channelId: string;
}

export function isRunChannelNowInput(value: unknown): value is RunChannelNowInput {
  return isDynamicRecord(value) && isIdentifier(value.channelId);
}
