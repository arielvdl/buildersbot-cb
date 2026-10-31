import type { WorkflowSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { type WorkflowAgents, workflowsInSection, workflowsToRead } from "./workflow-sections";

function summary(id: string, updatedAt = "2026-10-30T10:00:00.000Z"): WorkflowSummary {
  return { id, title: id, steps: 2, updatedAt, lastRun: null };
}

const library = [summary("launch"), summary("triage"), summary("notes"), summary("new")];
const agents = new Map<string, WorkflowAgents>([
  ["launch", { updatedAt: "2026-10-30T10:00:00.000Z", agentIds: ["scout", "writer"] }],
  ["triage", { updatedAt: "2026-10-30T10:00:00.000Z", agentIds: ["hacker"] }],
  ["notes", { updatedAt: "2026-10-30T10:00:00.000Z", agentIds: [] }],
]);
const naia = new Set(["scout", "writer"]);

describe("the workflows of a section", () => {
  it("are all the workflows with All", () => {
    expect(workflowsInSection(library, agents, null)).toBe(library);
  });

  it("are the workflows with an agent step of an agent in the section", () => {
    expect(workflowsInSection(library, agents, (agentId) => naia.has(agentId)).map((item) => item.id)).toEqual([
      "launch",
    ]);
  });

  it("leave out a workflow with no agent step, and one whose agents are not read yet", () => {
    const ids = workflowsInSection(library, agents, () => true).map((item) => item.id);
    expect(ids).toEqual(["launch", "triage"]);
  });

  it("read a workflow again only when it is new or changed", () => {
    const changed = [summary("launch", "2026-10-30T11:00:00.000Z"), summary("triage"), summary("new")];
    expect(workflowsToRead(changed, agents).map((item) => item.id)).toEqual(["launch", "new"]);
  });
});
