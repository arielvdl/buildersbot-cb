/**
 * A picked, dropped or pasted file made into a section icon image. The file is only a source: the
 * editor draws it on a canvas of at most 96 px, and the icon is that canvas as WebP, or as PNG where
 * the browser has no WebP encoder. An SVG file is read as an image (an `<img>` runs no script and loads
 * no other file) and never stays an SVG: the layout keeps only PNG or WebP, which the contract checks.
 */

import { AVATAR_IMAGE_LIMITS } from "@openbot/contracts/input-limits";
import {
  isSidebarSectionImage,
  SIDEBAR_SECTION_ICON_LIMITS,
  SIDEBAR_SECTION_IMAGE_TYPES,
} from "@openbot/contracts/ipc";
import { isOneOf } from "@openbot/contracts/runtime-values";
import { avatarImageDataUrl } from "../../avatar-image";
import { currentText } from "../../text";
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
 * and doctype, then the `<svg` element. A script, a foreign object, a `javascript:` address or a link to
 * a web address is refused: an `<img>` would not run or load them, and the check refuses them anyway.
 */
export function sidebarSectionSvgProblem(text: string): "invalid" | "unsafe" | null {
  const start = text.replace(/^﻿/, "").replace(/^(\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, "");
  if (!/^<svg[\s>]/i.test(start)) return "invalid";
  if (/<script|<foreignObject|javascript:/i.test(text)) return "unsafe";
  if (/href\s*=\s*["']?\s*https?:/i.test(text)) return "unsafe";
  return null;
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

/** An image loaded for the editor, from an object URL that `release` revokes. */
export interface SectionIconSource {
  url: string;
  image: HTMLImageElement;
  size: SectionIconSize;
  release: () => void;
}

/** Reads a file into an image for the editor. It fails with a message the editor shows. */
export async function loadSectionIconSource(file: File): Promise<SectionIconSource> {
  const { t } = currentText();
  const problem = sidebarSectionIconSourceProblem(file);
  if (problem === "type") throw new Error(t("sidebar.sectionIcon.type"));
  if (problem === "size") throw new Error(t("app.avatar.size"));
  if (problem === "svgSize") throw new Error(t("sidebar.sectionIcon.svgSize"));
  let blob: Blob = file;
  if (file.type === "image/svg+xml") {
    const text = await file.text();
    const svg = sidebarSectionSvgProblem(text);
    if (svg === "invalid") throw new Error(t("sidebar.sectionIcon.svgInvalid"));
    if (svg === "unsafe") throw new Error(t("sidebar.sectionIcon.svgUnsafe"));
    // A new blob with the SVG type, so the image reads it as SVG and nothing else.
    blob = new Blob([text], { type: "image/svg+xml" });
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(t("app.avatar.processFailed"));
  }
  return {
    url,
    image,
    size: sectionIconNaturalSize(image.naturalWidth, image.naturalHeight),
    release: () => URL.revokeObjectURL(url),
  };
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
  const { t } = currentText();
  for (const [index, side] of OUTPUT_SIDES.entries()) {
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("app.avatar.processingUnavailable"));
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
  throw new Error(t("app.avatar.tooLarge"));
}

/** The canvas as a `data:` URL of `type`, or null when the browser encodes another type instead. */
async function canvasDataUrl(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<string | null> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob || blob.type !== type || !isOneOf(SIDEBAR_SECTION_IMAGE_TYPES, blob.type)) return null;
  return avatarImageDataUrl({ mimeType: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) });
}
