// What main answers and sends about the lid-closed mode.

import {
  isLidAwakePreference,
  LID_AWAKE_HELPER_STATES,
  LID_AWAKE_STATES,
  LID_AWAKE_TEST_VERDICTS,
  type LidAwakeStatus,
  type LidAwakeTestResult,
} from "@openbot/contracts/ipc";
import {
  decodeRecord,
  nullableNumber,
  nullableString,
  requiredBoolean,
  requiredString,
} from "@openbot/contracts/ipc-decoding";
import { isOneOf } from "@openbot/contracts/runtime-values";

function wholeSeconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`Invalid ${field}.`);
  return value;
}

function decodeLidAwakeTest(value: unknown): LidAwakeTestResult {
  const test = decodeRecord(value, "lid-closed test");
  if (!isOneOf(LID_AWAKE_TEST_VERDICTS, test.verdict)) throw new Error("Invalid verdict.");
  return {
    verdict: test.verdict,
    startedAt: requiredString(test, "startedAt"),
    endedAt: nullableString(test, "endedAt"),
    closedSeconds: wholeSeconds(test.closedSeconds, "closedSeconds"),
    sleptSeconds: wholeSeconds(test.sleptSeconds, "sleptSeconds"),
    longestGapSeconds: wholeSeconds(test.longestGapSeconds, "longestGapSeconds"),
  };
}

export function decodeLidAwakeStatus(value: unknown): LidAwakeStatus {
  const status = decodeRecord(value, "lid-closed status");
  const { preference, state, helper, test } = status;
  if (!isLidAwakePreference(preference)) throw new Error("Invalid preference.");
  if (!isOneOf(LID_AWAKE_STATES, state)) throw new Error("Invalid state.");
  if (!isOneOf(LID_AWAKE_HELPER_STATES, helper)) throw new Error("Invalid helper.");
  const batteryPercent = nullableNumber(status, "batteryPercent");
  if (batteryPercent !== null && (!Number.isInteger(batteryPercent) || batteryPercent < 0 || batteryPercent > 100))
    throw new Error("Invalid batteryPercent.");
  return {
    supported: requiredBoolean(status, "supported"),
    preference: {
      mode: preference.mode,
      batteryFloor: preference.batteryFloor,
      timeLimitHours: preference.timeLimitHours,
    },
    state,
    onPowerAdapter: requiredBoolean(status, "onPowerAdapter"),
    batteryPercent,
    lidClosed: requiredBoolean(status, "lidClosed"),
    helper,
    sleepDisabledWithoutGrant: requiredBoolean(status, "sleepDisabledWithoutGrant"),
    test: test === null ? null : decodeLidAwakeTest(test),
  };
}
