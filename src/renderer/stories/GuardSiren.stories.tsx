import { GUARD_LEVELS, type GuardLevel } from "@openbot/contracts/ipc";
import { Heading } from "@openbot/ui";
import { GuardLevelChoice, GuardSiren, GuardSirenHero } from "@openbot/ui/features/guard/GuardSiren";
import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import "./guard-siren-story.css";

const meta = {
  title: "Guard/GuardSiren",
  component: GuardSirenHero,
  args: { level: "light", status: "ready" },
  argTypes: {
    level: { control: "select", options: [...GUARD_LEVELS] },
    status: {
      control: "select",
      options: ["loading", "off", "asking", "local-only", "signed-out", "unavailable", "ready"],
    },
  },
  decorators: [
    (Story) => (
      <main class="foundation-story">
        <Story />
      </main>
    ),
  ],
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof GuardSirenHero>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The top of the Guard page, Light: the siren stays down in the box, as in the P1 mockup. */
export const Hero: Story = {};

/** The top of the Guard page with the level cards under the siren. A card sets the level. */
export const HeroWithLevels: Story = {
  render: () => {
    const [level, setLevel] = createSignal<GuardLevel>("light");
    return (
      <GuardSirenHero level={level()} status={level() === "off" ? "off" : "ready"}>
        <GuardLevelChoice value={level()} disabled={false} onChange={setLevel} />
      </GuardSirenHero>
    );
  },
};

/** Before the page reads the Guard: the box is asleep and the level has no name yet. */
export const HeroLoading: Story = { args: { level: null, status: "loading" } };

export const HeroOff: Story = { args: { level: "off", status: "off" } };

/** A question of the Guard waits for the person: the siren is red and the shield shows "!". */
export const HeroAsking: Story = { args: { level: "light", status: "asking" } };

export const HeroSignedOut: Story = { args: { level: "light", status: "signed-out" } };

export const HeroNarrow: Story = {
  decorators: [
    (Story) => (
      <div class="guard-siren-story-narrow">
        <Story />
      </div>
    ),
  ],
};

/** Every level at rest, and each level while the Guard asks. Strict, Very strict and Custom are planned. */
export const Levels: Story = {
  render: () => (
    <>
      <Heading as="h1" size="lg">
        Guard siren
      </Heading>
      <div class="guard-siren-story-grid">
        {GUARD_LEVELS.map((level) => (
          <figure class="guard-siren-story-cell">
            <GuardSiren level={level} size="hero" class="guard-siren-story-siren" />
            <figcaption>{level}</figcaption>
          </figure>
        ))}
        {GUARD_LEVELS.map((level) => (
          <figure class="guard-siren-story-cell">
            <GuardSiren level={level} asking size="hero" class="guard-siren-story-siren" />
            <figcaption>{level}, asking</figcaption>
          </figure>
        ))}
      </div>
    </>
  ),
};

/** The siren of the card of a Guard question: asking, answered, and the Guard off. */
export const Compact: Story = {
  render: () => (
    <div class="guard-siren-story-row">
      <GuardSiren level="light" asking size="compact" />
      <GuardSiren level="light" size="compact" />
      <GuardSiren level="strict" size="compact" />
      <GuardSiren level="off" size="compact" />
    </div>
  ),
};
