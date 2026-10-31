import { Button } from "@openbot/ui";
import { AgentActivityIndicator } from "@openbot/ui/features/conversation/AgentActivity";
import { type AgentStep, AgentStepsDisclosure } from "@openbot/ui/features/conversation/AgentSteps";
import { createSignal, onSettled, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_AGENTS } from "./fixtures";

/*
 * The steps of an agent's turn (#2537, #2884): its thoughts, the host's progress lines and the
 * memory changes it committed. While the turn runs, a chevron on the activity line opens them;
 * after it, a closed row above the answer holds them. "Show agent steps" opens them only while the
 * turn runs.
 */

const STEPS: AgentStep[] = [
  {
    id: "t1",
    kind: "thinking",
    text: "The user wants this week planned. I check what I already know about their routine first.",
  },
  { id: "p1", kind: "progress", text: "Searching its memories…" },
  { id: "p2", kind: "progress", text: "Searched its memories: 3 found" },
  { id: "p3", kind: "progress", text: "Using the skill todoist-cli…" },
  { id: "p4", kind: "progress", text: "Gathering the relevant information…" },
  { id: "p5", kind: "progress", text: "Reviewing the information I gathered…" },
  {
    id: "t2",
    kind: "thinking",
    text: "Two tasks are overdue. Friday has no meetings, so the deep-work block fits there.",
  },
  { id: "p6", kind: "progress", text: "Updating its memories…" },
];

const MEMORY: AgentStep[] = [
  {
    id: "m1",
    kind: "memory",
    change: { memoryId: "m1", action: "saved", text: "Keeps mornings (8–11) for writing. No meetings before 11." },
  },
  {
    id: "m2",
    kind: "memory",
    change: {
      memoryId: "m2",
      action: "updated",
      text: "Uses the Todoist project “Work 2026” for all work tasks.",
      previousText: "Uses the Todoist project “Work” for all work tasks.",
    },
  },
  {
    id: "m3",
    kind: "memory",
    change: { memoryId: "m3", action: "forgotten", text: "Prefers plans as one long bulleted list." },
  },
  {
    id: "m4",
    kind: "memory",
    change: { memoryId: "m4", action: "notChanged", text: "Sends the weekly report on Friday at 16:00." },
  },
];

const meta = {
  title: "Conversation/AgentSteps",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** A running turn with its steps open. One more step arrives each second. */
export const Running: Story = {
  render: () => {
    const [shown, setShown] = createSignal(1);
    onSettled(() => {
      const timer = window.setInterval(() => setShown((count) => (count >= STEPS.length ? 1 : count + 1)), 1_000);
      return () => window.clearInterval(timer);
    });
    return (
      <div style={{ width: "640px" }}>
        <AgentActivityIndicator
          agent={STORY_AGENTS[0]}
          label="Working on it…"
          detail="Gathering the relevant information…"
          steps={STEPS.slice(0, shown())}
          stepsOpenByDefault
        />
      </div>
    );
  },
};

/** A running turn with the steps closed, as the setting leaves them. */
export const RunningClosed: Story = {
  render: () => (
    <div style={{ width: "640px" }}>
      <AgentActivityIndicator
        agent={STORY_AGENTS[0]}
        label="Working on it…"
        detail="Gathering the relevant information…"
        steps={STEPS}
      />
    </div>
  ),
};

/** A finished turn: the closed row above its answer, with the time of the turn and its failed steps. */
export const Finished: Story = {
  render: () => (
    <div style={{ width: "640px" }}>
      <AgentStepsDisclosure
        steps={[...STEPS, ...MEMORY]}
        defaultOpen={false}
        facts={{ durationMs: 74_000, failed: 1 }}
      />
    </div>
  ),
};

/** A finished turn that the person opened. */
export const FinishedOpen: Story = {
  render: () => (
    <div style={{ width: "640px" }}>
      <AgentStepsDisclosure steps={[...STEPS, ...MEMORY]} defaultOpen={false} choice />
    </div>
  ),
};

/** Turns from the history with "Show agent steps" on: a finished turn starts closed. */
export const FromHistory: Story = {
  render: () => (
    <div style={{ width: "640px", display: "grid", gap: "12px" }}>
      <AgentStepsDisclosure steps={STEPS} defaultOpen facts={{ durationMs: 1_930_000, failed: 1 }} />
      <p style={{ margin: 0 }}>The plan for the week is ready. Friday morning is free for the deep-work block.</p>
      <AgentStepsDisclosure steps={[...STEPS, ...MEMORY]} defaultOpen facts={{ durationMs: 74_000, failed: 0 }} />
      <p style={{ margin: 0 }}>I saved your writing hours and moved the work tasks to the new project.</p>
    </div>
  ),
};

/**
 * "Show agent steps" is on. The list is open while the turn runs and steps arrive. When the turn
 * ends, the list closes by itself with a short transition, and the answer under it shows. Click the
 * row while the turn runs: a list that you open stays open after the end.
 */
export const TurnEnds: Story = {
  render: () => {
    const [shown, setShown] = createSignal(1);
    const [running, setRunning] = createSignal(true);
    const [round, setRound] = createSignal(0);
    onSettled(() => {
      const timer = window.setInterval(() => {
        if (!running()) return;
        if (shown() < STEPS.length) setShown((count) => count + 1);
        else setRunning(false);
      }, 700);
      return () => window.clearInterval(timer);
    });
    const restart = () => {
      setShown(1);
      setRunning(true);
      setRound((value) => value + 1);
    };
    return (
      <div style={{ width: "640px", display: "grid", gap: "12px", "justify-items": "start" }}>
        <Button variant="secondary" size="sm" onClick={restart}>
          {running() ? "The turn runs" : "Run the turn again"}
        </Button>
        <Show when={round() + 1} keyed>
          <AgentStepsDisclosure
            steps={STEPS.slice(0, shown())}
            defaultOpen
            running={running()}
            facts={{ durationMs: shown() * 700, failed: 1 }}
          />
        </Show>
        <p style={{ margin: 0 }}>
          {running()
            ? "Writing the answer…"
            : "The plan for the week is ready. Friday morning is free for the deep-work block."}
        </p>
      </div>
    );
  },
};

/** A turn from a Team API host: the host sends the memory count only. */
export const MemoryCountOnly: Story = {
  render: () => (
    <div style={{ width: "640px" }}>
      <AgentStepsDisclosure
        steps={[{ id: "s", kind: "memory-summary", text: "Memory: 2 saved, 0 updated, 1 forgotten." }]}
        defaultOpen
      />
    </div>
  ),
};
