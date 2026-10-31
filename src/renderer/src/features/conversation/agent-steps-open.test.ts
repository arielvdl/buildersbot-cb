import {
  rememberStepChoice,
  STEP_CHOICE_LIMIT,
  shouldAutoCollapse,
  stepsOpenAtStart,
  stepsOpenedBy,
} from "@openbot/ui/features/conversation/agent-steps-open";
import { describe, expect, it } from "vitest";

describe("the steps when they first show", () => {
  it("open with the setting only for a turn that runs", () => {
    expect(stepsOpenAtStart("running", true)).toBe(true);
    expect(stepsOpenAtStart("running", false)).toBe(false);
  });

  it("start closed for a finished turn, such as one from the history, also with the setting", () => {
    expect(stepsOpenAtStart("finished", true)).toBe(false);
    expect(stepsOpenAtStart("finished", false)).toBe(false);
  });
});

describe("what keeps the steps open", () => {
  it("is the person when they chose to open them, over the setting", () => {
    expect(stepsOpenedBy(true, false)).toBe("person");
    expect(stepsOpenedBy(true, true)).toBe("person");
  });

  it("is nothing when the person closed them, also with the setting", () => {
    expect(stepsOpenedBy(false, true)).toBeNull();
  });

  it("is the setting when the person did not choose", () => {
    expect(stepsOpenedBy(undefined, true)).toBe("setting");
    expect(stepsOpenedBy(undefined, false)).toBeNull();
  });
});

describe("the close at the end of a turn", () => {
  it("closes the steps that the setting opened when the turn ends", () => {
    expect(shouldAutoCollapse("running", "finished", "setting")).toBe(true);
  });

  it("keeps the steps that the person opened, also while the turn ran", () => {
    expect(shouldAutoCollapse("running", "finished", "person")).toBe(false);
  });

  it("does nothing to closed steps", () => {
    expect(shouldAutoCollapse("running", "finished", null)).toBe(false);
  });

  it("closes nothing when the turn did not end: it still runs, or it ended before", () => {
    expect(shouldAutoCollapse("running", "running", "setting")).toBe(false);
    expect(shouldAutoCollapse("finished", "finished", "setting")).toBe(false);
    expect(shouldAutoCollapse("finished", "running", "setting")).toBe(false);
  });
});

describe("the choices that a chat keeps", () => {
  it("keeps the last choice for each turn", () => {
    const opened = rememberStepChoice(new Map(), ["t1", "t2"], true);
    expect([...opened]).toEqual([
      ["t1", true],
      ["t2", true],
    ]);
    expect([...rememberStepChoice(opened, ["t1"], false)]).toEqual([
      ["t2", true],
      ["t1", false],
    ]);
  });

  it("returns the same choices when no turn is named", () => {
    const choices = new Map([["t1", true]]);
    expect(rememberStepChoice(choices, [], false)).toBe(choices);
  });

  it("drops the oldest choices past the limit", () => {
    let choices: ReadonlyMap<string, boolean> = new Map();
    for (let index = 0; index < STEP_CHOICE_LIMIT + 5; index += 1)
      choices = rememberStepChoice(choices, [`t${index}`], true);
    expect(choices.size).toBe(STEP_CHOICE_LIMIT);
    expect(choices.has("t0")).toBe(false);
    expect(choices.has(`t${STEP_CHOICE_LIMIT + 4}`)).toBe(true);
  });
});
