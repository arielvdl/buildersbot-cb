import { SectionIconCropImage, SidebarSectionIconCrop } from "@openbot/ui/features/sidebar/SidebarSectionIconCrop";
import type { SectionIconCrop } from "@openbot/ui/features/sidebar/section-icon-crop";
import { sectionIconFitCrop } from "@openbot/ui/features/sidebar/section-icon-crop";
import type { SectionIconBackground } from "@openbot/ui/features/sidebar/section-icon-image";
import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

/**
 * A test image drawn here, so the story loads nothing from the network: stripes, a circle at the
 * center and a mark at one end, so a move or a zoom is easy to see.
 */
function testImage(width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return "";
  const stripes = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444"];
  const long = Math.max(width, height);
  for (let index = 0; index * 40 < long; index += 1) {
    context.fillStyle = stripes[index % stripes.length] ?? "#3b82f6";
    if (width >= height) context.fillRect(index * 40, 0, 40, height);
    else context.fillRect(0, index * 40, width, 40);
  }
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.arc(width / 2, height / 2, Math.min(width, height) / 3, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#111111";
  context.fillRect(8, 8, 24, 24);
  return canvas.toDataURL("image/png");
}

/** One crop editor with the live preview tile beside it, as in the icon dialog. */
function CropEditor(props: { width: number; height: number }) {
  const url = testImage(props.width, props.height);
  const size = { width: props.width, height: props.height };
  const [crop, setCrop] = createSignal<SectionIconCrop>(sectionIconFitCrop());
  const [background, setBackground] = createSignal<SectionIconBackground>("transparent");
  return (
    <div class="ui-dialog-content section-icon-dialog" style="position: static; animation: none;">
      <div class="section-icon-form">
        <div class="section-icon-preview">
          <span class="section-icon-preview-tile">
            <span class="section-rail-mark-tile" data-kind="image">
              <SectionIconCropImage url={url} size={size} crop={crop()} background={background()} />
            </span>
          </span>
          <span class="section-icon-preview-name">
            {props.width} × {props.height}
          </span>
        </div>
        <div class="section-icon-image">
          <SidebarSectionIconCrop
            url={url}
            size={size}
            crop={crop()}
            background={background()}
            onCropChange={setCrop}
            onBackgroundChange={setBackground}
          />
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Navigation/Section icon crop",
  component: CropEditor,
  args: { width: 640, height: 200 },
  parameters: { layout: "centered" },
} satisfies Meta<typeof CropEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A wide image and a tall image. Drag to move, use the wheel or the slider to zoom, or focus the frame
 * and use the arrow keys, + and -, and 0. Fit shows all of the image; Fill covers the square.
 */
export const WideAndTall: Story = {
  render: () => (
    <div style="display: flex; flex-wrap: wrap; gap: 24px; padding: 24px;">
      <CropEditor width={640} height={200} />
      <CropEditor width={200} height={640} />
    </div>
  ),
};
