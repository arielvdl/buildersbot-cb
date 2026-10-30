import type { AutoRecoveryState, LoadSnapshot, RunningWork, StoppedWork } from "@openbot/contracts/ipc";
import type { ChannelLaneSnapshot } from "../backend/channel-service";

/** The reading of the resource monitor, as `ResourceMonitor.loadReading` gives it. */
export interface LoadReading {
  sampledAt: string | null;
  usedMb: number | null;
  agentsMb: number | null;
  totalMb: number;
  activeAgents: number;
  providerProcesses: number;
  /** How much of the memory macOS says is free, and whether agents are held for it. Null where nothing reads it. */
  pressure: { level: "ok" | "low" | "critical"; freePercent: number; swapUsedMb: number } | null;
}

/** The snapshot the window shows. Channels that were deleted since the user chose an order drop out of it. */
export interface LoadWork {
  running: RunningWork[];
  stopped: StoppedWork[];
  recovery: AutoRecoveryState;
}

export function buildLoadSnapshot(
  reading: LoadReading,
  lane: ChannelLaneSnapshot,
  channelIds: ReadonlySet<string>,
  work: LoadWork,
) {
  const known = (ids: readonly string[]) => ids.filter((id) => channelIds.has(id));
  const snapshot: LoadSnapshot = {
    sampledAt: reading.sampledAt,
    memory: {
      usedMb: reading.usedMb,
      agentsMb: reading.agentsMb,
      totalMb: reading.totalMb,
      ...(reading.pressure ? { pressure: reading.pressure } : {}),
    },
    activeAgents: reading.activeAgents,
    providerProcesses: reading.providerProcesses,
    lane: {
      enabled: lane.enabled,
      order: known(lane.order),
      running: known(lane.running),
      queued: known(lane.queued),
    },
    running: work.running,
    stopped: work.stopped,
    recovery: work.recovery,
  };
  return snapshot;
}
