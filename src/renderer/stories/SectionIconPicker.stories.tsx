import type { SidebarSectionGlyph } from "@openbot/contracts/ipc";
import { SectionEmojiPicker, SectionGlyphPicker } from "@openbot/ui/features/sidebar/SidebarSectionIconPicker";
import { SidebarSectionMark } from "@openbot/ui/features/sidebar/SidebarSectionMark";
import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

/** Both pickers of the icon editor, each with the tile that its choice makes. */
function Pickers() {
  const [glyph, setGlyph] = createSignal<SidebarSectionGlyph | null>("rocket");
  const [emoji, setEmoji] = createSignal<string | null>("👩🏽‍💻");
  return (
    <div style="display: flex; flex-wrap: wrap; gap: 24px; padding: 24px; align-items: flex-start;">
      <div class="ui-dialog-content section-icon-dialog" style="position: static; animation: none;">
        <div class="section-icon-form">
          <div class="section-icon-preview">
            <span class="section-icon-preview-tile">
              <SidebarSectionMark
                icon={glyph() ? { kind: "glyph", glyph: glyph() ?? "bot" } : { kind: "letter", text: "?" }}
              />
            </span>
          </div>
          <SectionGlyphPicker selected={glyph()} onSelect={setGlyph} />
        </div>
      </div>
      <div class="ui-dialog-content section-icon-dialog" style="position: static; animation: none;">
        <div class="section-icon-form">
          <div class="section-icon-preview">
            <span class="section-icon-preview-tile">
              <SidebarSectionMark
                icon={emoji() ? { kind: "emoji", emoji: emoji() ?? "🚀" } : { kind: "letter", text: "?" }}
              />
            </span>
          </div>
          <SectionEmojiPicker selected={emoji()} onSelect={setEmoji} />
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Navigation/Section icon picker",
  component: Pickers,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Pickers>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Type in a search field ("segurança", "foguete", "coração"), use a category, or use the arrow keys in a
 * grid. The skin tone button changes the people and the hands. The tile above shows the choice.
 */
export const IconAndEmoji: Story = {};
