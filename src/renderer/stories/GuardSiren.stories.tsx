import { GUARD_LEVELS } from "@openbot/contracts/ipc";
import { Heading } from "@openbot/ui";
import { GuardSiren, GuardSirenHero } from "@openbot/ui/features/guard/GuardSiren";
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

/** The top of the Guard page. The level list of the page sets the level. */
export const Hero: Story = {};

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
