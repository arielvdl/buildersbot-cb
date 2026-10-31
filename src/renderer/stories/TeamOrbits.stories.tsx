import { OrbitsPanel, type OrbitsPanelProps } from "@openbot/ui/features/orbits/OrbitsPanel";
import { type OrbitsViewInput, orbitsView } from "@openbot/ui/features/orbits/orbits-view";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  ORBITS_CHANNELS,
  ORBITS_INPUT,
  ORBITS_NOW,
  ORBITS_QUIET_INPUT,
  ORBITS_REMOTE_INPUT,
} from "./team-orbits-fixtures";

/**
 * The Team panel ("Equipe") over an empty window. The fixtures are the signals that the app reads,
 * and `orbitsView` makes the panel from them, as `WorkspaceOrbits` does.
 */
function TeamOrbitsStory(
  props: { input: OrbitsViewInput } & Pick<OrbitsPanelProps, "initialSelectedId" | "initialFamily">,
) {
  return (
    <OrbitsPanel
      open
      onOpenChange={fn()}
      view={orbitsView(props.input)}
      now={ORBITS_NOW}
      channelName={(channelId) => ORBITS_CHANNELS.find((channel) => channel.id === channelId)?.title ?? null}
      onOpenSystem={fn()}
      onOpenAgent={fn()}
      initialSelectedId={props.initialSelectedId}
      initialFamily={props.initialFamily}
    />
  );
}

const meta = {
  title: "Features/Team orbits",
  component: TeamOrbitsStory,
  parameters: { layout: "fullscreen" },
  args: { input: ORBITS_INPUT },
} satisfies Meta<typeof TeamOrbitsStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Busy: Story = {};

/** The card of a stopped agent. */
export const StoppedAgentCard: Story = { args: { initialSelectedId: "narrador" } };

/** The card of an agent that waits for a free place. */
export const WaitingAgentCard: Story = { args: { initialSelectedId: "front-naia" } };

/** Only the Opus agents show at full strength. */
export const OpusFilter: Story = { args: { initialFamily: "opus" } };

/** A joined server: no request titles, no times, no stopped channel tasks. */
export const JoinedServer: Story = { args: { input: ORBITS_REMOTE_INPUT } };

export const NothingRuns: Story = { args: { input: ORBITS_QUIET_INPUT } };
