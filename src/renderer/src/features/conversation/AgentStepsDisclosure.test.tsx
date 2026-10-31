import { type AgentStep, AgentStepsDisclosure } from "@openbot/ui/features/conversation/AgentSteps";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";

const STEPS: AgentStep[] = [
  { id: "p1", kind: "progress", text: "Gathering the relevant information…" },
  { id: "p2", kind: "progress", text: "Working through the next tool-assisted step…" },
];

/** The steps row of a turn whose run the test ends. The "Show agent steps" setting is on. */
function mountTurn(options: { running: boolean; choice?: boolean; onChoice?: (open: boolean) => void }) {
  const [running, setRunning] = createSignal(options.running);
  render(() => (
    <AgentStepsDisclosure
      steps={STEPS}
      defaultOpen
      running={running()}
      choice={options.choice}
      onChoice={options.onChoice}
    />
  ));
  return { end: () => setRunning(false) };
}

const header = () => screen.getByRole("button", { name: /2 steps/u });
const stepList = () => screen.queryByRole("region", { name: "Agent steps" });

describe("the steps row when its turn ends", () => {
  it("is open while the turn runs, and closes by itself when the turn ends", async () => {
    const turn = mountTurn({ running: true });
    expect(header()).toHaveAttribute("aria-expanded", "true");
    expect(stepList()).not.toBeNull();

    turn.end();

    await waitFor(() => expect(header()).toHaveAttribute("aria-expanded", "false"));
    await waitFor(() => expect(stepList()).toBeNull());
  });

  it("starts closed for a finished turn, such as one from the history", () => {
    mountTurn({ running: false });
    expect(header()).toHaveAttribute("aria-expanded", "false");
    expect(stepList()).toBeNull();
  });

  it("keeps the steps open when the person opened them while the turn ran", async () => {
    const onChoice = vi.fn();
    const turn = mountTurn({ running: true, onChoice });
    fireEvent.click(header());
    await waitFor(() => expect(header()).toHaveAttribute("aria-expanded", "false"));
    fireEvent.click(header());
    await waitFor(() => expect(header()).toHaveAttribute("aria-expanded", "true"));
    expect(onChoice).toHaveBeenLastCalledWith(true);

    turn.end();

    await waitFor(() => expect(stepList()).not.toBeNull());
    expect(header()).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the choice that the chat kept for the turn when the row is drawn again", () => {
    mountTurn({ running: false, choice: true });
    expect(header()).toHaveAttribute("aria-expanded", "true");
    expect(stepList()).not.toBeNull();
  });

  it("opens again from its row after it closed", async () => {
    const turn = mountTurn({ running: true });
    turn.end();
    await waitFor(() => expect(stepList()).toBeNull());

    fireEvent.click(header());

    await waitFor(() => expect(stepList()).not.toBeNull());
  });
});
