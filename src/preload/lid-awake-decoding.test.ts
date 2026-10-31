// @vitest-environment node

import type { LidAwakeStatus } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { decodeLidAwakeStatus } from "./lid-awake-decoding";

const STATUS: LidAwakeStatus = {
  supported: true,
  preference: { mode: "battery", batteryFloor: 30, timeLimitHours: 8 },
  state: "active-battery",
  onPowerAdapter: false,
  batteryPercent: 64,
  lidClosed: true,
  helper: "installed",
  sleepDisabledWithoutGrant: false,
  test: {
    verdict: "stayed-awake",
    startedAt: "2026-10-31T14:00:00.000Z",
    endedAt: "2026-10-31T14:05:00.000Z",
    closedSeconds: 180,
    sleptSeconds: 0,
    longestGapSeconds: 6,
  },
};

describe("decodeLidAwakeStatus", () => {
  it("keeps a valid status and drops fields that the contract does not have", () => {
    const decoded = decodeLidAwakeStatus({
      ...STATUS,
      extra: "dropped",
      preference: { ...STATUS.preference, extra: 1 },
    });
    expect(decoded).toEqual(STATUS);
    expect(decoded).not.toHaveProperty("extra");
    expect(decoded.preference).not.toHaveProperty("extra");
  });

  it("accepts no test and an unknown battery level", () => {
    expect(decodeLidAwakeStatus({ ...STATUS, test: null, batteryPercent: null })).toMatchObject({
      test: null,
      batteryPercent: null,
    });
  });

  it.each([
    ["a value that is not a record", "status"],
    ["an unknown mode", { ...STATUS, preference: { ...STATUS.preference, mode: "always" } }],
    ["a battery floor that is not offered", { ...STATUS, preference: { ...STATUS.preference, batteryFloor: 5 } }],
    ["a time limit that is not offered", { ...STATUS, preference: { ...STATUS.preference, timeLimitHours: 2 } }],
    ["an unknown state", { ...STATUS, state: "sleeping" }],
    ["an unknown service state", { ...STATUS, helper: "running" }],
    ["a battery level above 100", { ...STATUS, batteryPercent: 101 }],
    ["a battery level that is not whole", { ...STATUS, batteryPercent: 50.5 }],
    ["a missing switch", { ...STATUS, lidClosed: undefined }],
    ["an unknown test verdict", { ...STATUS, test: { ...STATUS.test, verdict: "passed" } }],
    ["negative test seconds", { ...STATUS, test: { ...STATUS.test, sleptSeconds: -1 } }],
  ])("rejects %s", (_name, value) => {
    expect(() => decodeLidAwakeStatus(value)).toThrow();
  });
});
