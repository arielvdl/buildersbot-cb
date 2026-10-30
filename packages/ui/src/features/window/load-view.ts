import type { LoadLanePreference, LoadSnapshot } from "@openbot/contracts/ipc";

export type LoadTone = "ok" | "warning" | "critical";

/** The share of the computer's memory in use, 0 to 100, or null before the first sample. */
export function loadMemoryPercent(snapshot: LoadSnapshot): number | null {
  const { usedMb, totalMb } = snapshot.memory;
  if (usedMb === null || totalMb <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((usedMb / totalMb) * 100)));
}

/** The ring turns amber at 60% and red at 80%, where a computer with many agents starts to swap. */
export function loadTone(percent: number | null): LoadTone {
  if (percent === null || percent < 60) return "ok";
  return percent < 80 ? "warning" : "critical";
}

/** Memory in GB with one decimal, or whole GB from ten up, so the label stays short. */
export function formatGigabytes(megabytes: number): string {
  const gigabytes = megabytes / 1024;
  return gigabytes >= 10 ? `${Math.round(gigabytes)} GB` : `${gigabytes.toFixed(1)} GB`;
}

export interface LoadLaneRow {
  id: string;
  status: "running" | "queued";
  /** The place in the queue, from 1. Absent for a channel that runs. */
  position?: number;
}

/** The channels that run, then the ones that wait, in the order they start. */
export function loadLaneRows(snapshot: LoadSnapshot): LoadLaneRow[] {
  const running = snapshot.lane.running.map((id): LoadLaneRow => ({ id, status: "running" }));
  const queued = snapshot.lane.queued.map((id, index): LoadLaneRow => ({ id, status: "queued", position: index + 1 }));
  return [...running, ...queued];
}

/** The preference with this channel first. The channels the user ordered before keep their order after it. */
export function withChannelFirst(snapshot: LoadSnapshot, channelId: string): LoadLanePreference {
  return {
    enabled: snapshot.lane.enabled,
    order: [channelId, ...snapshot.lane.order.filter((id) => id !== channelId)],
  };
}
