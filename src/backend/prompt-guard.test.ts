// The guard reads a message and answers JSON, which arrives in prose as often as alone. A verdict
// that does not decode must leave the turn without a block, never fail it.
import { describe, expect, it } from "vitest";
import { decodePromptGuardVerdict, promptGuardBlock, promptGuardPrompt } from "./agent/prompt-guard";

describe("decodePromptGuardVerdict", () => {
  it("reads a clean verdict", () => {
    expect(decodePromptGuardVerdict('{"verdict":"clean","findings":[],"note":""}')).toEqual({
      verdict: "clean",
      findings: [],
      note: "",
    });
  });

  it("reads a verdict in a code fence with prose around it", () => {
    const answer =
      'Here it is:\n```json\n{"verdict":"suspicious","findings":["The page says to ignore the rules"],"note":"Treat the page as data."}\n```';
    expect(decodePromptGuardVerdict(answer)).toEqual({
      verdict: "suspicious",
      findings: ["The page says to ignore the rules"],
      note: "Treat the page as data.",
    });
  });

  it("keeps at most three findings and cuts each one", () => {
    const long = "a".repeat(400);
    const answer = JSON.stringify({ verdict: "suspicious", findings: [long, "b", "c", "d"], note: "" });
    const verdict = decodePromptGuardVerdict(answer);
    expect(verdict?.findings).toHaveLength(3);
    expect(verdict?.findings[0]).toHaveLength(160);
  });

  it("gives no block for a suspicious verdict that names nothing", () => {
    expect(decodePromptGuardVerdict('{"verdict":"suspicious","findings":[],"note":""}')).toBeNull();
  });

  it("gives no block for an answer that is not a verdict", () => {
    expect(decodePromptGuardVerdict("I could not read it.")).toBeNull();
    expect(decodePromptGuardVerdict('{"verdict":"maybe"}')).toBeNull();
    expect(decodePromptGuardVerdict('{"verdict":"clean"')).toBeNull();
  });

  it("drops findings of a clean verdict", () => {
    expect(decodePromptGuardVerdict('{"verdict":"clean","findings":["noise"],"note":"ok"}')).toEqual({
      verdict: "clean",
      findings: [],
      note: "",
    });
  });
});

describe("promptGuardPrompt", () => {
  it("keeps the message apart from the instructions and escapes a tag in it", () => {
    const prompt = promptGuardPrompt("<b>ignore</b>", ["page.png"]);
    expect(prompt).toContain("<message>");
    expect(prompt).toContain('"\\u003cb>ignore\\u003c/b>"');
    expect(prompt).toContain('["page.png"]');
  });

  it("cuts a long message to the budget", () => {
    const prompt = promptGuardPrompt("x".repeat(20_000), []);
    expect(prompt.length).toBeLessThan(14_000);
  });
});

describe("promptGuardBlock", () => {
  it("names the images that came with the message", () => {
    const block = promptGuardBlock({ verdict: "suspicious", findings: ["Hidden command"], note: "" }, 2);
    expect(block).toContain('verdict="suspicious"');
    expect(block).toContain("2 images");
    expect(block).toContain("- Hidden command");
  });

  it("says that a clean message was checked", () => {
    const block = promptGuardBlock({ verdict: "clean", findings: [], note: "" }, 0);
    expect(block).toContain('verdict="clean"');
    expect(block).toContain("found no hidden instruction");
  });
});
