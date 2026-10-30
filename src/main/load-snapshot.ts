import type { LoadSnapshot } from "@openbot/contracts/ipc";
import type { ChannelLaneSnapshot } from "../backend/channel-service";

/** The reading of the resource monitor, as `ResourceMonitor.loadReading` gives it. */
export interface LoadReading {
  sampledAt: string | null;
  usedMb: number | null;
  agentsMb: number | null;
  totalMb: number;
  activeAgents: number;
  providerProcesses: number;
}

/** The snapshot the window shows. Channels that were deleted since the user chose an order drop out of it. */
export function buildLoadSnapshot(reading: LoadReading, lane: ChannelLaneSnapshot, channelIds: ReadonlySet<string>) {
  const known = (ids: readonly string[]) => ids.filter((id) => channelIds.has(id));
  const snapshot: LoadSnapshot = {
    sampledAt: reading.sampledAt,
    memory: { usedMb: reading.usedMb, agentsMb: reading.agentsMb, totalMb: reading.totalMb },
    activeAgents: reading.activeAgents,
    providerProcesses: reading.providerProcesses,
    lane: {
      enabled: lane.enabled,
      order: known(lane.order),
      running: known(lane.running),
      queued: known(lane.queued),
    },
  };
  return snapshot;
}
