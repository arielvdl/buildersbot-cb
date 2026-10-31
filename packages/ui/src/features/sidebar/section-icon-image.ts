/**
 * A picked, dropped or pasted file made into a section icon image. The file is only a source: the
 * editor draws it on a canvas of at most 96 px, and the icon is that canvas as WebP, or as PNG where
 * the browser has no WebP encoder. The layout keeps only PNG or WebP, which the contract checks.
 *
 * The app's Content Security Policy allows `data:` images and refuses `blob:` images, so no step here
 * puts an object URL in an `<img>`:
 * - A PNG, JPEG, GIF or WebP file is decoded with `createImageBitmap`, which the policy does not
 *   control. The editor shows a smaller copy of it as a `data:` URL. Without `createImageBitmap`, the
 *   file is read as a `data:` URL.
 * - An SVG file is read as text, checked, and loaded as a `data:image/svg+xml` URL in an `<img>`. An
 *   SVG image runs no script and loads no other file, and it never stays an SVG.
 *
 * This module has no text: each failure is a `SectionIconImageError` with a reason, which the editor
 * turns into a message in the interface language.
 */

import { AVATAR_IMAGE_LIMITS } from "@openbot/contracts/input-limits";
import {
  isSidebarSectionImage,
  SIDEBAR_SECTION_ICON_LIMITS,
  SIDEBAR_SECTION_IMAGE_TYPES,
} from "@openbot/contracts/ipc";
import { isOneOf } from "@openbot/contracts/runtime-values";
import {
  type SectionIconCrop,
  type SectionIconSize,
  sectionIconDrawRect,
  sectionIconNaturalSize,
} from "./section-icon-crop";

/** The files a person can pick, drop or paste. A GIF keeps its first frame; an SVG becomes a raster image. */
export const SIDEBAR_SECTION_ICON_SOURCE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
] as const;

/** The largest SVG source. A raster source can have the avatar limit. */
export const SIDEBAR_SECTION_SVG_SOURCE_BYTES = 512 * 1024;

/** The longest side of the copy that the editor shows. The crop zooms to 4x of a 200 px frame. */
const PREVIEW_SIDE = 1024;

/** The sides that the editor tries, largest first, when an image is still too large at the lowest quality. */
const OUTPUT_SIDES = [SIDEBAR_SECTION_ICON_LIMITS.imagePixels, 80, 64, 48] as const;
const QUALITIES = [0.9, 0.8, 0.65, 0.5] as const;

/** The color behind the parts of the square that the image does not cover. */
export type SectionIconBackground = "transparent" | "light" | "dark";

/**
 * The fills that go into the saved image. They are part of a generated image, not of the theme, so they
 * are fixed colors: the icon looks the same in the light and the dark theme.
 */
const SECTION_ICON_FILLS = { light: "#f4f4f5", dark: "#18181b" } as const;

/**
 * Why an image is refused or cannot be made:
 * - `type`: not a PNG, JPEG, GIF, WebP or SVG file. `size`: empty, or larger than the avatar limit.
 * - `svgSize`, `svgInvalid`, `svgScript`, `svgLink`: an SVG file that is too large, is not an SVG
 *   document, has a script or a foreign object, or links to a web address.
 * - `corrupt`: the browser cannot decode the file.
 * - `unavailable`: this browser has no canvas. `tooLarge`: even 48 px is over the byte limit.
 */
export type SectionIconImageProblem =
  | "type"
  | "size"
  | "svgSize"
  | "svgInvalid"
  | "svgScript"
  | "svgLink"
  | "corrupt"
  | "unavailable"
  | "tooLarge";

export class SectionIconImageError extends Error {
  readonly reason: SectionIconImageProblem;
  /** The name and the message of the browser error, when there is one, for a diagnosis. */
  readonly detail: string | null;

  constructor(reason: SectionIconImageProblem, cause?: unknown) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : null;
    super(detail ? `Section icon image: ${reason} (${detail})` : `Section icon image: ${reason}`, { cause });
    this.name = "SectionIconImageError";
    this.reason = reason;
    this.detail = detail;
  }
}

/** Why a file is refused before it is read, or null when it can be read. */
export function sidebarSectionIconSourceProblem(file: {
  type: string;
  size: number;
}): "type" | "size" | "svgSize" | null {
  if (!isOneOf(SIDEBAR_SECTION_ICON_SOURCE_TYPES, file.type)) return "type";
  if (file.size <= 0) return "size";
  if (file.type === "image/svg+xml") return file.size > SIDEBAR_SECTION_SVG_SOURCE_BYTES ? "svgSize" : null;
  return file.size > AVATAR_IMAGE_LIMITS.sourceBytes ? "size" : null;
}

/**
 * Why an SVG text is refused, or null. It must be an SVG document: optional XML declaration, comments
 * and doctype, then the `<svg` element. A script, a foreign object or a `javascript:` address is
 * `script`; a link to a web address is `link`. An `<img>` would not run or load them, and the check
 * refuses them anyway.
 */
export function sidebarSectionSvgProblem(text: string): "invalid" | "script" | "link" | null {
  const start = text.replace(/^﻿/, "").replace(/^(\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, "");
  if (!/^<svg[\s>]/i.test(start)) return "invalid";
  if (/<script|<foreignObject|javascript:/i.test(text)) return "script";
  if (/href\s*=\s*["']?\s*https?:/i.test(text)) return "link";
  return null;
}

/** The SVG text as a `data:` URL, which the policy allows for an `<img>`. */
export function sectionIconSvgDataUrl(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}

/**
 * The file to use from a drop or a paste: the first one of a type the editor takes. `ignored` counts
 * the other files, so the editor can say that it used only one.
 */
export function sidebarSectionIconPick<T extends { type: string }>(
  files: readonly T[],
): { file: T | null; ignored: number } {
  const file = files.find((candidate) => isOneOf(SIDEBAR_SECTION_ICON_SOURCE_TYPES, candidate.type)) ?? null;
  return { file, ignored: files.length - (file ? 1 : 0) };
}

/** An image loaded for the editor. `url` is a `data:` URL to show; `image` is what the canvas draws. */
export interface SectionIconSource {
  url: string;
  image: CanvasImageSource;
  size: SectionIconSize;
  release: () => void;
}

/** Reads a file into an image for the editor. It fails with a `SectionIconImageError`. */
export async function loadSectionIconSource(file: File): Promise<SectionIconSource> {
  const problem = sidebarSectionIconSourceProblem(file);
  if (problem) throw new SectionIconImageError(problem);
  return file.type === "image/svg+xml" ? loadSvg(file) : loadRaster(file);
}

async function loadSvg(file: File): Promise<SectionIconSource> {
  const text = await file.text();
  const problem = sidebarSectionSvgProblem(text);
  if (problem === "invalid") throw new SectionIconImageError("svgInvalid");
  if (problem === "script") throw new SectionIconImageError("svgScript");
  if (problem === "link") throw new SectionIconImageError("svgLink");
  const url = sectionIconSvgDataUrl(text);
  const image = await decodeImage(url);
  return { url, image, size: sectionIconNaturalSize(image.naturalWidth, image.naturalHeight), release: () => {} };
}

async function loadRaster(file: File): Promise<SectionIconSource> {
  let bitmap: ImageBitmap | null = null;
  if (typeof createImageBitmap === "function") {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      // A browser that cannot decode the type here may still decode it in an <img>.
      bitmap = null;
    }
  }
  if (bitmap) {
    const image = bitmap;
    const size = sectionIconNaturalSize(image.width, image.height);
    try {
      return { url: previewDataUrl(image, size), image, size, release: () => image.close() };
    } catch (cause) {
      image.close();
      throw cause;
    }
  }
  const url = await readDataUrl(file);
  const image = await decodeImage(url);
  return { url, image, size: sectionIconNaturalSize(image.naturalWidth, image.naturalHeight), release: () => {} };
}

/** A copy of at most `PREVIEW_SIDE` pixels as a `data:` URL, for the editor and the header preview. */
function previewDataUrl(image: ImageBitmap, size: SectionIconSize): string {
  const scale = Math.min(1, PREVIEW_SIDE / Math.max(size.width, size.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.width * scale));
  canvas.height = Math.max(1, Math.round(size.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new SectionIconImageError("unavailable");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  // WebP keeps the transparency and is small; a browser without the encoder gives PNG.
  return canvas.toDataURL("image/webp", 0.92);
}

/** An `<img>` of a `data:` URL, decoded. A file that the browser cannot decode is `corrupt`. */
async function decodeImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
  } catch (cause) {
    throw new SectionIconImageError("corrupt", cause);
  }
  return image;
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new SectionIconImageError("corrupt"));
    };
    reader.onerror = () => reject(new SectionIconImageError("corrupt", reader.error));
    reader.readAsDataURL(blob);
  });
}

/**
 * The icon image of the editor: the frame drawn on a canvas, as a WebP or PNG `data:` URL that the
 * contract accepts. When the image is too large at 96 px, a smaller side is tried; `reduced` says so.
 */
export async function renderSectionIconImage(
  source: Pick<SectionIconSource, "image" | "size">,
  crop: SectionIconCrop,
  frame: number,
  background: SectionIconBackground,
): Promise<{ dataUrl: string; reduced: boolean }> {
  for (const [index, side] of OUTPUT_SIDES.entries()) {
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext("2d");
    if (!context) throw new SectionIconImageError("unavailable");
    if (background !== "transparent") {
      context.fillStyle = SECTION_ICON_FILLS[background];
      context.fillRect(0, 0, side, side);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const rect = sectionIconDrawRect(crop, source.size, frame, side);
    context.drawImage(source.image, rect.x, rect.y, rect.width, rect.height);
    for (const quality of QUALITIES) {
      const url = await canvasDataUrl(canvas, "image/webp", quality);
      if (url === null) break;
      if (isSidebarSectionImage(url)) return { dataUrl: url, reduced: index > 0 };
    }
    const png = await canvasDataUrl(canvas, "image/png");
    if (png !== null && isSidebarSectionImage(png)) return { dataUrl: png, reduced: index > 0 };
  }
  throw new SectionIconImageError("tooLarge");
}

/** The canvas as a `data:` URL of `type`, or null when the browser encodes another type instead. */
async function canvasDataUrl(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<string | null> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob || blob.type !== type || !isOneOf(SIDEBAR_SECTION_IMAGE_TYPES, blob.type)) return null;
  return readDataUrl(blob);
}
