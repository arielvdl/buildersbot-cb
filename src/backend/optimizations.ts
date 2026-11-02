import type { OptimizationId } from "@openbot/contracts/ipc";

/**
 * The one port through which the code that runs agents reads the advanced optimizations (beta,
 * `ipc-optimizations.ts`). The read is synchronous and cheap, so a check can read it each time it
 * decides. A switch that is off keeps the behavior that the app had before the switches existed.
 * `onOptimizationChange` tells a reader that keeps state for a switch, such as a timer, when it changes.
 */
export interface OptimizationPort {
  optimizationEnabled(id: OptimizationId): boolean;
  onOptimizationChange(listener: (id: OptimizationId, enabled: boolean) => void): () => void;
}

/** Every switch off, for a host or a test that has no file of switches. */
export const OPTIMIZATIONS_OFF: OptimizationPort = {
  optimizationEnabled: () => false,
  onOptimizationChange: () => () => {},
};
