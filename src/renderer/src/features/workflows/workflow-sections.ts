import { graphAgentIds, type WorkflowSummary } from "@openbot/contracts/ipc";
import { createEffect, createSignal } from "solid-js";
import type { WorkflowHost } from "./workflows-port";

/** The agents of one workflow, as its graph had them at `updatedAt`. */
export interface WorkflowAgents {
  updatedAt: string;
  agentIds: readonly string[];
}

/**
 * The workflows that the section rail keeps. A workflow has no owner, so it is in a section when one of
 * its agent steps runs an agent of that section. A workflow with no agent step is only in "All". A
 * workflow whose agents are not read yet does not show until they are.
 */
export function workflowsInSection(
  summaries: readonly WorkflowSummary[],
  agents: ReadonlyMap<string, WorkflowAgents>,
  inSection: ((agentId: string) => boolean) | null,
): readonly WorkflowSummary[] {
  if (!inSection) return summaries;
  return summaries.filter((summary) => agents.get(summary.id)?.agentIds.some(inSection) ?? false);
}

/** The workflows whose agents must be read again: never read, or changed since the last read. */
export function workflowsToRead(
  summaries: readonly WorkflowSummary[],
  agents: ReadonlyMap<string, WorkflowAgents>,
): readonly WorkflowSummary[] {
  return summaries.filter((summary) => agents.get(summary.id)?.updatedAt !== summary.updatedAt);
}

/**
 * The agents of each workflow of the library, for the section filter. A summary carries no agent, so
 * this reads the graph of each workflow, only while a section is selected, and again only after the
 * workflow changed. A failed read leaves that workflow out of the section.
 */
export function createWorkflowAgentIndex(
  host: WorkflowHost,
  summaries: () => readonly WorkflowSummary[],
  active: () => boolean,
) {
  const [agents, setAgents] = createSignal<ReadonlyMap<string, WorkflowAgents>>(new Map());
  const reading = new Set<string>();
  createEffect(
    () => (active() ? workflowsToRead(summaries(), agents()) : []),
    (stale) => {
      for (const summary of stale) {
        const key = `${summary.id}:${summary.updatedAt}`;
        if (reading.has(key)) continue;
        reading.add(key);
        void host.workflows
          .get(summary.id)
          .then((detail) => {
            setAgents((current) =>
              new Map(current).set(summary.id, {
                updatedAt: summary.updatedAt,
                agentIds: graphAgentIds(detail.graph),
              }),
            );
          })
          .catch(() => undefined)
          .finally(() => reading.delete(key));
      }
    },
  );
  return agents;
}
