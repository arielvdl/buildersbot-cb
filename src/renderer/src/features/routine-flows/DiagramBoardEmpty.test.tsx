/**
 * The Routines canvas before its first routine, through `DiagramView` as the app shows it: its text
 * comes from the catalog, its actions call their handlers, and its link opens the chat over the
 * canvas with a request to make a routine.
 */
import { DiagramView, type DiagramViewProps } from "@openbot/ui/features/diagrams/DiagramView";
import type { Diagram } from "@openbot/ui/features/diagrams/diagram-model";
import { TextProvider } from "@openbot/ui/text";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { requireFixture, STORY_AGENTS } from "../../preview/fixtures";

const owner = requireFixture(STORY_AGENTS[0], "the first story agent");

/** A canvas with no routine: only the card of its own agent. */
const emptyDiagram: Diagram = {
  id: "diagram-empty",
  name: owner.name,
  nodes: [{ kind: "agent", id: `node-${owner.id}`, position: { x: 0, y: 0 }, agentId: owner.id, task: "" }],
  edges: [],
  lastRuns: [],
  updatedAt: "2026-10-31T09:00:00.000Z",
};

/** The text of the empty canvas before this design, in English and in Portuguese. */
const OLD_TEXT = [
  /Draw it once/,
  /Watch it/,
  /A routine starts the work/,
  /hands its answer to the next/,
  /Desenhe-a uma vez/,
  /Depois veja-a/,
  /Uma rotina inicia o trabalho/,
  /passa sua resposta para o próximo/,
];

const assistant = () => ({ agent: owner, messages: [], working: false, onSend: vi.fn<(text: string) => void>() });

function EmptyCanvas(props: Partial<DiagramViewProps>) {
  return (
    <DiagramView
      diagram={emptyDiagram}
      agents={STORY_AGENTS}
      owner={owner}
      onMoveNode={vi.fn()}
      onConnect={() => true}
      onRemoveEdge={vi.fn()}
      onRemoveNode={vi.fn()}
      {...props}
    />
  );
}

describe("the Routines canvas before the first routine", () => {
  it("shows the title, the text and the sample routines, and no text of the old canvas", () => {
    render(() => <EmptyCanvas onCreateRoutine={vi.fn()} assistant={assistant()} />);

    expect(screen.getByRole("heading", { name: "Leave the routine to the agents." })).toBeInTheDocument();
    expect(screen.getByText("Ready for the first routine")).toBeInTheDocument();
    expect(
      screen.getByText(/^Say what needs to happen and when\. The builders create the routine/),
    ).toBeInTheDocument();
    expect(screen.getByText("For example:")).toBeInTheDocument();
    expect(
      screen.getByText(/morning brief at 7 AM · sales report every Monday · email triage at 6 PM/),
    ).toBeInTheDocument();
    for (const text of OLD_TEXT) expect(screen.queryByText(text)).toBeNull();
  });

  it("shows its text in the language of the interface", () => {
    render(() => (
      <TextProvider locale="pt">
        <EmptyCanvas onCreateRoutine={vi.fn()} assistant={assistant()} />
      </TextProvider>
    ));

    expect(screen.getByRole("heading", { name: "Deixe a rotina com os agentes." })).toBeInTheDocument();
    expect(screen.getByText("Prontos para a primeira rotina")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Diga o que precisa acontecer e quando. Os builders geram a rotina e cuidam dela todos os dias, sem você precisar lembrar.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar rotina" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pedir a um agente para criar" })).toBeInTheDocument();
    expect(screen.getByText("Por exemplo:")).toBeInTheDocument();
    expect(
      screen.getByText(/resumo da manhã às 7h · relatório de vendas toda segunda · triagem de e-mails às 18h/),
    ).toBeInTheDocument();
    for (const text of OLD_TEXT) expect(screen.queryByText(text)).toBeNull();
  });

  it("opens the settings of a new routine from its main action", () => {
    const onCreateRoutine = vi.fn();
    render(() => <EmptyCanvas onCreateRoutine={onCreateRoutine} assistant={assistant()} />);

    fireEvent.click(screen.getByRole("button", { name: "Create Routine" }));

    expect(onCreateRoutine).toHaveBeenCalledTimes(1);
  });

  it("opens the chat over the canvas with a request to make a routine, and sends nothing", async () => {
    const chat = assistant();
    const onCreateRoutine = vi.fn();
    render(() => <EmptyCanvas onCreateRoutine={onCreateRoutine} assistant={chat} />);

    fireEvent.click(screen.getByRole("button", { name: "Ask an agent to create it" }));

    const editor = screen.getByRole("textbox", { name: "Describe a routine change" });
    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor).toHaveTextContent("Create a routine for me:");
    expect(chat.onSend).not.toHaveBeenCalled();
    expect(onCreateRoutine).not.toHaveBeenCalled();
  });

  it("keeps a draft that the user started in the chat", async () => {
    render(() => <EmptyCanvas onCreateRoutine={vi.fn()} assistant={assistant()} />);
    const editor = screen.getByRole("textbox", { name: "Describe a routine change" });
    editor.textContent = "A sales report every Monday";
    fireEvent.input(editor);

    fireEvent.click(screen.getByRole("button", { name: "Ask an agent to create it" }));

    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor).toHaveTextContent("A sales report every Monday");
    expect(editor).not.toHaveTextContent("Create a routine for me:");
  });

  it("shows no action without its handler, and no link without the chat", () => {
    render(() => <EmptyCanvas />);

    expect(screen.getByRole("heading", { name: "Leave the routine to the agents." })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Routine" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask an agent to create it" })).toBeNull();
  });
});
