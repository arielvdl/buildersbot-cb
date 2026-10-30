import type { InterruptedWorkOffer } from "@openbot/contracts/ipc";
import { createStore } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ResumeOfferModal } from "../src/features/resume/ResumeOfferModal";
import { SettledArgs } from "./settled-args";

interface DemoProps {
  offer: InterruptedWorkOffer;
  pending: boolean;
  error: string | null;
  onResumeAll: () => void;
  onResumeSelected: () => void;
  onDismiss: () => void;
}

/** Owns the selection as the controller does, so the checkboxes and Resume selected respond. */
function ResumeOfferDemo(props: DemoProps) {
  const [selection, setSelection] = createStore<{ channelIds: string[]; agentIds: string[] }>({
    channelIds: [],
    agentIds: [],
  });
  const toggle = (ids: string[], id: string, checked: boolean) => [
    ...ids.filter((item) => item !== id),
    ...(checked ? [id] : []),
  ];
  return (
    <main class="foundation-story">
      <ResumeOfferModal
        offer={props.offer}
        selectedChannelIds={selection.channelIds}
        selectedAgentIds={selection.agentIds}
        pending={props.pending}
        error={props.error}
        canResumeSelected={!props.pending && selection.channelIds.length + selection.agentIds.length > 0}
        onToggleChannel={(id, checked) =>
          setSelection((state) => {
            state.channelIds = toggle(state.channelIds, id, checked);
          })
        }
        onToggleAgent={(id, checked) =>
          setSelection((state) => {
            state.agentIds = toggle(state.agentIds, id, checked);
          })
        }
        onResumeAll={props.onResumeAll}
        onResumeSelected={props.onResumeSelected}
        onDismiss={props.onDismiss}
      />
    </main>
  );
}

const meta = {
  title: "Startup/ResumeOfferModal",
  component: ResumeOfferDemo,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
  // The modal reads `offer.channels`, so it waits for the args (see `settled-args.tsx`).
  render: (args) => <SettledArgs>{() => <ResumeOfferDemo {...args} />}</SettledArgs>,
  args: {
    offer: {
      channels: [
        { id: "launch", name: "Launch plan", stoppedTasks: 2 },
        { id: "support", name: "Customer support", stoppedTasks: 1 },
      ],
      agents: [
        { id: "nova", name: "Nova" },
        { id: "atlas", name: "Atlas" },
      ],
    },
    pending: false,
    error: null,
    onResumeAll: fn(),
    onResumeSelected: fn(),
    onDismiss: fn(),
  },
} satisfies Meta<typeof ResumeOfferDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ChannelsAndAgents: Story = {};

export const AgentsOnly: Story = {
  args: { offer: { channels: [], agents: [{ id: "nova", name: "Nova" }] } },
};

export const Resuming: Story = {
  args: { pending: true },
};

export const SomeWorkFailed: Story = {
  args: {
    offer: { channels: [{ id: "launch", name: "Launch plan", stoppedTasks: 1 }], agents: [] },
    error: "",
  },
};
