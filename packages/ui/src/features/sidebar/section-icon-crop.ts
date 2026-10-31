/**
 * The geometry of the icon crop editor: a square frame with the picked image in it, which the user
 * zooms and moves. Zoom 1 is "Fit": the whole image fits in the frame. "Fill" is the zoom at which the
 * image covers the frame. The pan is the offset of the image center from the frame center, in frame
 * pixels. Nothing here renders, so each rule has a test.
 */

export interface SectionIconCrop {
  zoom: number;
  x: number;
  y: number;
}

export interface SectionIconSize {
  width: number;
  height: number;
}

/** The largest zoom for a usual image. A long image can zoom further, until it fills the frame. */
export const SECTION_ICON_MAX_ZOOM = 4;

/** An image with no size of its own, such as an SVG without width, height or viewBox, counts as 96 x 96. */
export function sectionIconNaturalSize(width: number, height: number): SectionIconSize {
  return width > 0 && height > 0 ? { width, height } : { width: 96, height: 96 };
}

/** The zoom at which the image covers the frame. */
export function sectionIconFillZoom(image: SectionIconSize): number {
  return Math.max(image.width, image.height) / Math.min(image.width, image.height);
}

export function sectionIconMaxZoom(image: SectionIconSize): number {
  return Math.max(SECTION_ICON_MAX_ZOOM, sectionIconFillZoom(image));
}

/** The size of the image in the frame, at a zoom. */
function scaledSize(image: SectionIconSize, frame: number, zoom: number): SectionIconSize {
  const fit = frame / Math.max(image.width, image.height);
  return { width: image.width * fit * zoom, height: image.height * fit * zoom };
}

/**
 * The crop inside its limits: a zoom from Fit to the largest zoom, and a pan that keeps the image in
 * the frame. On a side where the image is larger than the frame, it covers the frame; on a side where it
 * is smaller, it stays inside the frame.
 */
export function clampSectionIconCrop(crop: SectionIconCrop, image: SectionIconSize, frame: number): SectionIconCrop {
  const zoom = Math.min(sectionIconMaxZoom(image), Math.max(1, Number.isFinite(crop.zoom) ? crop.zoom : 1));
  const size = scaledSize(image, frame, zoom);
  const limitX = Math.abs(size.width - frame) / 2;
  const limitY = Math.abs(size.height - frame) / 2;
  // "+ 0" makes -0 into 0, so a crop at the center is always { x: 0, y: 0 }.
  const clamp = (value: number, limit: number) =>
    Math.min(limit, Math.max(-limit, Number.isFinite(value) ? value : 0)) + 0;
  return { zoom, x: clamp(crop.x, limitX), y: clamp(crop.y, limitY) };
}

/** Fit: the whole image in the frame, in the center. */
export function sectionIconFitCrop(): SectionIconCrop {
  return { zoom: 1, x: 0, y: 0 };
}

/** Fill: the image covers the frame, in the center. */
export function sectionIconFillCrop(image: SectionIconSize): SectionIconCrop {
  return { zoom: sectionIconFillZoom(image), x: 0, y: 0 };
}

/** A zoom by a factor, from the frame center, with the pan kept in its limits. */
export function zoomSectionIconCrop(
  crop: SectionIconCrop,
  factor: number,
  image: SectionIconSize,
  frame: number,
): SectionIconCrop {
  const next = clampSectionIconCrop({ ...crop, zoom: crop.zoom * factor }, image, frame);
  // The point under the frame center stays under it.
  const ratio = next.zoom / crop.zoom;
  return clampSectionIconCrop({ zoom: next.zoom, x: crop.x * ratio, y: crop.y * ratio }, image, frame);
}

/** A move by a distance in frame pixels, kept in its limits. */
export function panSectionIconCrop(
  crop: SectionIconCrop,
  dx: number,
  dy: number,
  image: SectionIconSize,
  frame: number,
): SectionIconCrop {
  return clampSectionIconCrop({ ...crop, x: crop.x + dx, y: crop.y + dy }, image, frame);
}

/**
 * Where the image goes on a square canvas of `output` pixels, so that the canvas shows what the frame
 * shows. Parts outside the canvas are cut; parts of the canvas the image does not cover stay as the
 * background.
 */
export function sectionIconDrawRect(
  crop: SectionIconCrop,
  image: SectionIconSize,
  frame: number,
  output: number,
): { x: number; y: number; width: number; height: number } {
  const size = scaledSize(image, frame, crop.zoom);
  const ratio = output / frame;
  return {
    x: (frame / 2 + crop.x - size.width / 2) * ratio,
    y: (frame / 2 + crop.y - size.height / 2) * ratio,
    width: size.width * ratio,
    height: size.height * ratio,
  };
}
