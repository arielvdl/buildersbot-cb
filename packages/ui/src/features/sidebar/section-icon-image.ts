/**
 * A picked file made into a section icon image: a square of at most 96 px, encoded as WebP, or as
 * PNG where the browser has no WebP encoder, and refused when it is still larger than the limit.
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

/**
 * The files a person can pick. SVG is not one: an SVG file can hold script and references to other
 * files. A GIF keeps its first frame.
 */
export const SIDEBAR_SECTION_ICON_SOURCE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const QUALITIES = [0.9, 0.8, 0.65, 0.5] as const;

/** Why a picked file is refused before it is read, or null when it can be read. */
export function sidebarSectionIconSourceProblem(file: { type: string; size: number }): "type" | "size" | null {
  if (!isOneOf(SIDEBAR_SECTION_ICON_SOURCE_TYPES, file.type)) return "type";
  if (file.size <= 0 || file.size > AVATAR_IMAGE_LIMITS.sourceBytes) return "size";
  return null;
}

/** The side of the stored square: the short side of the picture, at most `imagePixels`. */
export function sidebarSectionIconSide(width: number, height: number): number {
  return Math.max(1, Math.min(SIDEBAR_SECTION_ICON_LIMITS.imagePixels, Math.floor(Math.min(width, height))));
}

/** The `data:` URL of the icon image. It fails with a message the editor shows. */
export async function sidebarSectionIconFromFile(file: File): Promise<string> {
  const { t } = currentText();
  const problem = sidebarSectionIconSourceProblem(file);
  if (problem === "type") throw new Error(t("app.avatar.type"));
  if (problem === "size") throw new Error(t("app.avatar.size"));
  let source: ImageBitmap;
  try {
    source = await createImageBitmap(file);
  } catch {
    throw new Error(t("app.avatar.processFailed"));
  }
  try {
    const side = sidebarSectionIconSide(source.width, source.height);
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("app.avatar.processingUnavailable"));
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    // The center square of the picture fills the icon, as an avatar does.
    const crop = Math.min(source.width, source.height);
    context.drawImage(source, (source.width - crop) / 2, (source.height - crop) / 2, crop, crop, 0, 0, side, side);
    for (const quality of QUALITIES) {
      const url = await canvasDataUrl(canvas, "image/webp", quality);
      if (url === null) break;
      if (isSidebarSectionImage(url)) return url;
    }
    const png = await canvasDataUrl(canvas, "image/png");
    if (png !== null && isSidebarSectionImage(png)) return png;
    throw new Error(t("app.avatar.tooLarge"));
  } finally {
    source.close();
  }
}

/** The canvas as a `data:` URL of `type`, or null when the browser encodes another type instead. */
async function canvasDataUrl(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<string | null> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob || blob.type !== type || !isOneOf(SIDEBAR_SECTION_IMAGE_TYPES, blob.type)) return null;
  return avatarImageDataUrl({ mimeType: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) });
}
