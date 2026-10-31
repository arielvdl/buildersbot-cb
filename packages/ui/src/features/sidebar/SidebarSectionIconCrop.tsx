/**
 * The crop editor of a section icon image: the image in a square frame, which the user moves and
 * zooms. Drag moves; the wheel, a pinch and the slider zoom; the arrow keys move, + and - zoom, and 0
 * goes back to Fit. The geometry is in `section-icon-crop.ts`.
 */

import type { AppTextKey } from "@openbot/i18n";
import { Button, SliderField } from "@openbot/ui";
import { For } from "solid-js";
import { useText } from "../../text";
import {
  clampSectionIconCrop,
  panSectionIconCrop,
  type SectionIconCrop,
  type SectionIconSize,
  sectionIconDrawRect,
  sectionIconFillCrop,
  sectionIconFitCrop,
  sectionIconMaxZoom,
  zoomSectionIconCrop,
} from "./section-icon-crop";
import { SECTION_ICON_FILLS, type SectionIconBackground } from "./section-icon-image";

/** The side of the editor frame, in pixels. The crop is in these pixels. */
export const SECTION_ICON_CROP_FRAME = 200;

const BACKGROUNDS = ["transparent", "light", "dark"] as const satisfies readonly SectionIconBackground[];

const BACKGROUND_LABELS = {
  transparent: "sidebar.sectionIcon.background.transparent",
  light: "sidebar.sectionIcon.background.light",
  dark: "sidebar.sectionIcon.background.dark",
} as const satisfies Record<SectionIconBackground, AppTextKey>;

/**
 * The image of a crop, as the saved icon will show it. It fills its box: the frame of the editor or the
 * tile of the preview. The place of the image is in percent of the box, so one drawing fits both.
 */
export function SectionIconCropImage(props: {
  url: string;
  size: SectionIconSize;
  crop: SectionIconCrop;
  background: SectionIconBackground;
}) {
  const rect = () => sectionIconDrawRect(props.crop, props.size, SECTION_ICON_CROP_FRAME, 100);
  return (
    <span
      class="section-icon-crop-canvas"
      data-background={props.background}
      // A fill of the saved image is a fixed color, so the preview takes it from the same table.
      style={props.background === "transparent" ? undefined : { background: SECTION_ICON_FILLS[props.background] }}
      aria-hidden="true"
    >
      <img
        class="section-icon-crop-image"
        src={props.url}
        alt=""
        draggable={false}
        style={`left: ${rect().x}%; top: ${rect().y}%; width: ${rect().width}%; height: ${rect().height}%;`}
      />
    </span>
  );
}

export function SidebarSectionIconCrop(props: {
  url: string;
  size: SectionIconSize;
  crop: SectionIconCrop;
  background: SectionIconBackground;
  onCropChange: (crop: SectionIconCrop) => void;
  onBackgroundChange: (background: SectionIconBackground) => void;
}) {
  const { t, format } = useText();
  const frame = SECTION_ICON_CROP_FRAME;
  let drag: { pointerId: number; x: number; y: number } | null = null;
  const change = (crop: SectionIconCrop) => props.onCropChange(clampSectionIconCrop(crop, props.size, frame));
  const pan = (dx: number, dy: number) => props.onCropChange(panSectionIconCrop(props.crop, dx, dy, props.size, frame));
  const zoom = (factor: number) => props.onCropChange(zoomSectionIconCrop(props.crop, factor, props.size, frame));

  function keyDown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 16 : 4;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move) pan(move[0], move[1]);
    else if (event.key === "+" || event.key === "=") zoom(1.1);
    else if (event.key === "-" || event.key === "_") zoom(1 / 1.1);
    else if (event.key === "0") props.onCropChange(sectionIconFitCrop());
    else return;
    event.preventDefault();
  }

  return (
    <div class="section-icon-crop">
      {/* The frame is one control: drag, wheel and keys change the crop. Its name says how. */}
      <div
        class="section-icon-crop-frame"
        role="application"
        tabindex="0"
        aria-label={t("sidebar.sectionIcon.cropLabel")}
        aria-roledescription={t("sidebar.sectionIcon.cropRole")}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + - 0"
        style={`width: ${frame}px; height: ${frame}px;`}
        onKeyDown={keyDown}
        onWheel={(event) => {
          event.preventDefault();
          // A pinch on a trackpad comes as a wheel with Ctrl, with smaller steps.
          zoom(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag?.pointerId !== event.pointerId) return;
          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          drag = { ...drag, x: event.clientX, y: event.clientY };
          pan(dx, dy);
        }}
        onPointerUp={() => {
          drag = null;
        }}
        onPointerCancel={() => {
          drag = null;
        }}
      >
        <SectionIconCropImage url={props.url} size={props.size} crop={props.crop} background={props.background} />
      </div>
      <SliderField
        class="section-icon-crop-zoom"
        label={t("sidebar.sectionIcon.zoom")}
        value={props.crop.zoom}
        minValue={1}
        maxValue={sectionIconMaxZoom(props.size)}
        step={0.01}
        formatValue={(value) => format.percent(value)}
        onChange={(value) => change({ ...props.crop, zoom: value })}
      />
      <div class="section-icon-crop-actions">
        <Button type="button" size="xs" variant="outline" onClick={() => props.onCropChange(sectionIconFitCrop())}>
          {t("sidebar.sectionIcon.fit")}
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={() => change(sectionIconFillCrop(props.size))}>
          {t("sidebar.sectionIcon.fill")}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => change({ ...props.crop, x: 0, y: 0 })}>
          {t("sidebar.sectionIcon.center")}
        </Button>
      </div>
      <fieldset class="section-icon-crop-backgrounds">
        <legend class="section-icon-crop-legend">{t("sidebar.sectionIcon.background")}</legend>
        <div class="section-icon-crop-actions">
          <For each={BACKGROUNDS}>
            {(background) => (
              <Button
                type="button"
                size="xs"
                variant={props.background === background ? "secondary" : "ghost"}
                aria-pressed={props.background === background ? "true" : "false"}
                onClick={() => props.onBackgroundChange(background)}
              >
                {t(BACKGROUND_LABELS[background])}
              </Button>
            )}
          </For>
        </div>
      </fieldset>
    </div>
  );
}
