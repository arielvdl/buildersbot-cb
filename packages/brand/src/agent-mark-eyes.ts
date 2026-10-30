import type { AvatarMood } from "./bloub-avatar-motion";

/**
 * How far the eyelids of an agent's mark come down, for each mood: 0 is wide open, 1 covers the eye.
 * A working agent is awake, an agent in the open chat is wide awake, and an agent at rest is half
 * asleep. A failed or sleeping agent closes its eyes.
 */
const EYELIDS: Readonly<Record<AvatarMood, number>> = {
  idle: 0.4,
  responded: 0.4,
  working: 0.1,
  live: 0,
  waiting: 0.25,
  connecting: 0.25,
  failed: 0.95,
  asleep: 0.95,
};

export function agentMarkEyelid(mood: AvatarMood): number {
  return EYELIDS[mood];
}
