import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { SettingsSoundsSection } from "../src/features/settings/SettingsSoundsSection";
import { resetSoundCenterForStory, startSoundCenter } from "../src/sound-center";
import { createMockBuildersBot } from "./mock-openbot";

/**
 * The Sounds section of Settings › Notifications with the real sound center and an in-memory main.
 * Nothing is saved yet, so the section moves the choices of an older version in from this browser,
 * as the desktop app does on its first start after an update. `scripts/sound-center-e2e.ts` drives it.
 */
function SoundsStory() {
  return (
    <main class="foundation-story">
      <SettingsSoundsSection onOpenSystemSettings={() => undefined} />
    </main>
  );
}

const meta = {
  title: "Settings/Sounds",
  component: SoundsStory,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
  // Before the render and outside it: Solid does not let a component body write the sound center's signal.
  beforeEach: () => {
    const previousApi = window.openbot;
    window.openbot = createMockBuildersBot({ sounds: { saved: false } }).api;
    resetSoundCenterForStory();
    void startSoundCenter();
    return () => {
      resetSoundCenterForStory();
      window.openbot = previousApi;
    };
  },
} satisfies Meta<typeof SoundsStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
