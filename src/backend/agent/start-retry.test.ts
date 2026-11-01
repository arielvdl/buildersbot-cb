import { DEFAULT_START_RETRY_SETTINGS, type StartRetrySettings } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { describe, expect, it } from "vitest";
import {
  classifyStartFailure,
  failsOnLeadModel,
  fallbackHoldRuns,
  isStartRetryMarker,
  nextStartStep,
  PIN_HOLD_MS,
  START_FALLBACK_HOLD_MS,
  StartBreakers,
} from "./start-retry";

const settings: StartRetrySettings = { ...DEFAULT_START_RETRY_SETTINGS, breakerMinutes: [5, 15, 30, 60] };
const opus = { provider: "claude" as const, model: "claude-opus" };
const backup = { provider: "codex" as const, model: "gpt-backup" };
const NOW = Date.parse("2026-11-01T14:00:00.000Z");
const OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

describe("StartBreakers", () => {
  it("counts lanes that fail together as one failure", () => {
    const breakers = new StartBreakers(null, NOW);
    breakers.open("lead", opus, settings, NOW, 0.5, null);
    const first = breakers.get("lead", opus);
    expect(first?.opens).toBe(1);
    // Two more lanes of the same agent fail in the wait: the count and the wait stay.
    breakers.open("lead", opus, settings, NOW + 1_000, 0.5, null);
    breakers.open("lead", opus, settings, NOW + 2_000, 0.5, null);
    const after = breakers.get("lead", opus);
    expect(after?.opens).toBe(1);
    expect(Date.parse(after?.until ?? "")).toBeGreaterThanOrEqual(Date.parse(first?.until ?? ""));
    expect(Date.parse(after?.until ?? "") - NOW).toBeLessThan(6 * 60_000);
  });

  it("makes the wait longer only for a probe after the wait", () => {
    const breakers = new StartBreakers(null, NOW);
    breakers.open("lead", opus, settings, NOW, 0.5, null);
    const until = Date.parse(breakers.get("lead", opus)?.until ?? "");
    breakers.probing("lead", opus);
    breakers.open("lead", opus, settings, until + 1_000, 0.5, null);
    expect(breakers.get("lead", opus)?.opens).toBe(2);
    // A failure after the wait with no probe, such as after a restart, counts too.
    const second = Date.parse(breakers.get("lead", opus)?.until ?? "");
    breakers.open("lead", opus, settings, second + 1_000, 0.5, null);
    expect(breakers.get("lead", opus)?.opens).toBe(3);
  });

  it("is of one agent and model", () => {
    const breakers = new StartBreakers(null, NOW);
    breakers.open("lead", opus, settings, NOW, 0.5, null);
    expect(breakers.waits("lead", opus, NOW + 1_000)).toBe(true);
    expect(breakers.waits("front", opus, NOW + 1_000)).toBe(false);
    expect(breakers.waits("lead", backup, NOW + 1_000)).toBe(false);
    expect(breakers.waitingElsewhere("lead", backup, NOW + 1_000)?.model).toBe(opus.model);
    expect(breakers.waitingElsewhere("lead", opus, NOW + 1_000)).toBeUndefined();
    expect(breakers.waits("lead", opus, NOW + 61 * 60_000)).toBe(false);
  });

  it("gives up a pin some time after the wait", () => {
    const breakers = new StartBreakers(null, NOW);
    breakers.open("lead", opus, settings, NOW, 0.5, null);
    breakers.pin("lead", "channel\u0000task");
    const until = Date.parse(breakers.get("lead", opus)?.until ?? "");
    expect(breakers.pinned("lead", until + 60_000)).toEqual(["channel\u0000task"]);
    expect(breakers.pinned("lead", until + PIN_HOLD_MS + 1)).toEqual([]);
  });
});

describe("classifyStartFailure", () => {
  it("names the failures of a model call of the channel lead", () => {
    const timedOut = classifyStartFailure(
      new Error(sourceText("error.agent.profileTimedOut")),
      sourceText("error.agent.profileTimedOut"),
      settings,
    );
    expect(timedOut.class).toBe("retry");
    expect(failsOnLeadModel(timedOut)).toBe(true);
    const leadModel = sourceText("error.backend.channelLeadModelUnavailable");
    expect(failsOnLeadModel(classifyStartFailure(new Error(leadModel), leadModel, settings))).toBe(true);
    expect(failsOnLeadModel(classifyStartFailure(new Error(OVERLOADED), OVERLOADED, settings))).toBe(false);
  });
});

describe("nextStartStep", () => {
  it("dates the move to the backup, and the queue waits for it for a limited time", () => {
    const failure = classifyStartFailure(new Error(OVERLOADED), OVERLOADED, settings, NOW);
    const step = nextStartStep({
      failure,
      marker: undefined,
      settings: { ...settings, retries: 0 },
      primary: opus,
      fallback: backup,
      probing: false,
      now: NOW,
      random: 0.5,
    });
    expect(step.type).toBe("fallback");
    if (step.type !== "fallback") return;
    expect(step.marker.fallbackAt).toBe(new Date(NOW).toISOString());
    expect(isStartRetryMarker(step.marker)).toBe(true);
    expect(fallbackHoldRuns(step.marker, NOW + START_FALLBACK_HOLD_MS - 1)).toBe(true);
    expect(fallbackHoldRuns(step.marker, NOW + START_FALLBACK_HOLD_MS)).toBe(false);
    // A marker of the earlier version has no date of the move: its first failure counts.
    const { fallbackAt: _fallbackAt, ...earlier } = step.marker;
    expect(isStartRetryMarker(earlier)).toBe(true);
    expect(fallbackHoldRuns(earlier, NOW + START_FALLBACK_HOLD_MS)).toBe(false);
    expect(isStartRetryMarker({ ...step.marker, fallbackAt: "not a date" })).toBe(false);
  });
});
