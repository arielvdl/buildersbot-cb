import { type GuardState, isGuardState } from "@openbot/contracts/ipc";
import { guardedDecoder } from "@openbot/contracts/ipc-decoding";

/** The Guard state that main sends: the level, the reviewer model, and whether that model can run now. */
export const decodeGuardState: (value: unknown) => GuardState = guardedDecoder(isGuardState, "Guard state");
