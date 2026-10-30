import { isDynamicRecord, isOneOf, isString } from "./runtime-values";

/**
 * The mark of a section in the section rail: one or two characters, a glyph of a fixed set, or a
 * small image. A section with no icon shows the first letter of its name.
 *
 * Only the local layout stores it. No released Team API protocol carries it, and each frozen codec
 * drops it from the section, so a remote peer shows the letter.
 */
export type SidebarSectionIcon =
  | { kind: "letter"; text: string }
  | { kind: "glyph"; glyph: SidebarSectionGlyph }
  | { kind: "image"; dataUrl: string };

/** The glyph names. Each one maps to an icon that `@openbot/ui` already exports. */
export const SIDEBAR_SECTION_GLYPHS = [
  "bot",
  "sparkles",
  "shield",
  "code",
  "brain",
  "zap",
  "globe",
  "film",
  "camera",
  "megaphone",
  "message",
  "mail",
  "users",
  "crown",
  "gift",
  "palette",
  "book",
  "folder",
  "cloud",
  "cpu",
  "lock",
  "store",
  "chart",
  "workflow",
] as const;

export type SidebarSectionGlyph = (typeof SIDEBAR_SECTION_GLYPHS)[number];

/** The image types that the layout stores. The app encodes each picked image to one of them. */
export const SIDEBAR_SECTION_IMAGE_TYPES = ["image/png", "image/webp"] as const;

export const SIDEBAR_SECTION_ICON_LIMITS = {
  /** Code points, so that one emoji counts as one character. */
  letterCodePoints: 2,
  /** The largest side of a stored image, in pixels. */
  imagePixels: 96,
  /** The largest stored image, in bytes. */
  imageBytes: 40 * 1024,
} as const;

const DATA_URL_PREFIX = /^data:(image\/(?:png|webp));base64,/;
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// One or two code points, with no control, format, separator or space character.
const LETTER = /^[^\p{C}\p{Z}]{1,2}$/u;
const MAX_DATA_URL_LENGTH =
  "data:image/webp;base64,".length + Math.ceil(SIDEBAR_SECTION_ICON_LIMITS.imageBytes / 3) * 4;

/** True for a letter icon text: one or two characters, with no space. */
export function isSidebarSectionLetter(value: unknown): value is string {
  return isString(value) && LETTER.test(value);
}

/**
 * True for an image that the layout can store: a PNG or WebP `data:` URL of at most
 * `imageBytes`, whose header names the same type and a size of at most `imagePixels` on each side.
 * No other URL is an icon, so the app never fetches an icon from the network, and SVG is refused.
 */
export function isSidebarSectionImage(value: unknown): value is string {
  if (!isString(value) || value.length > MAX_DATA_URL_LENGTH) return false;
  const prefix = DATA_URL_PREFIX.exec(value);
  if (!prefix) return false;
  const body = value.slice(prefix[0].length);
  if (body.length === 0 || body.length % 4 !== 0 || !BASE64_BODY.test(body)) return false;
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  if ((body.length / 4) * 3 - padding > SIDEBAR_SECTION_ICON_LIMITS.imageBytes) return false;
  const size = prefix[1] === "image/png" ? pngSize(base64Head(body, 24)) : webpSize(base64Head(body, 30));
  return (
    size !== null &&
    size.width >= 1 &&
    size.height >= 1 &&
    size.width <= SIDEBAR_SECTION_ICON_LIMITS.imagePixels &&
    size.height <= SIDEBAR_SECTION_ICON_LIMITS.imagePixels
  );
}

export function isSidebarSectionIcon(value: unknown): value is SidebarSectionIcon {
  if (!isDynamicRecord(value)) return false;
  switch (value.kind) {
    case "letter":
      return Object.keys(value).length === 2 && isSidebarSectionLetter(value.text);
    case "glyph":
      return Object.keys(value).length === 2 && isString(value.glyph) && isOneOf(SIDEBAR_SECTION_GLYPHS, value.glyph);
    case "image":
      return Object.keys(value).length === 2 && isSidebarSectionImage(value.dataUrl);
    default:
      return false;
  }
}

/**
 * The icon in its stored form: a letter without the spaces around it. Null for every value that is
 * not an icon.
 */
export function normalizeSidebarSectionIcon(value: unknown): SidebarSectionIcon | null {
  if (isDynamicRecord(value) && value.kind === "letter" && isString(value.text)) {
    const text = value.text.trim();
    return isSidebarSectionLetter(text) ? { kind: "letter", text } : null;
  }
  if (!isSidebarSectionIcon(value)) return null;
  switch (value.kind) {
    case "letter":
      return { kind: "letter", text: value.text };
    case "glyph":
      return { kind: "glyph", glyph: value.glyph };
    case "image":
      return { kind: "image", dataUrl: value.dataUrl };
  }
}

export function sameSidebarSectionIcon(
  left: SidebarSectionIcon | undefined,
  right: SidebarSectionIcon | null,
): boolean {
  if (!left || !right) return !left && !right;
  if (left.kind === "letter" && right.kind === "letter") return left.text === right.text;
  if (left.kind === "glyph" && right.kind === "glyph") return left.glyph === right.glyph;
  return left.kind === "image" && right.kind === "image" && left.dataUrl === right.dataUrl;
}

/** The section with `icon`, or without the field when `icon` is null, so no icon writes no key. */
export function sidebarSectionWithIcon<T extends { icon?: SidebarSectionIcon }>(
  section: T,
  icon: SidebarSectionIcon | null,
): T {
  const next = { ...section };
  delete next.icon;
  return icon === null ? next : { ...next, icon };
}

/** The first bytes of a base64 text. It stops at padding, so a short image gives fewer bytes. */
function base64Head(body: string, byteCount: number): number[] {
  const bytes: number[] = [];
  for (let offset = 0; offset + 4 <= body.length && bytes.length < byteCount; offset += 4) {
    const digits = [...body.slice(offset, offset + 4)].map((character) => BASE64_ALPHABET.indexOf(character));
    if (digits.some((digit) => digit < 0)) break;
    const [a = 0, b = 0, c = 0, d = 0] = digits;
    const group = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((group >> 16) & 0xff, (group >> 8) & 0xff, group & 0xff);
  }
  return bytes.slice(0, byteCount);
}

function hasBytes(bytes: readonly number[], expected: readonly number[], offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function byteAt(bytes: readonly number[], index: number): number {
  return bytes[index] ?? 0;
}

/** The size in the IHDR chunk, which a PNG file must have first. */
function pngSize(bytes: readonly number[]): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (!hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  if (!hasBytes(bytes, [0x49, 0x48, 0x44, 0x52], 12)) return null;
  const word = (index: number) =>
    byteAt(bytes, index) * 0x1000000 +
    (byteAt(bytes, index + 1) << 16) +
    (byteAt(bytes, index + 2) << 8) +
    byteAt(bytes, index + 3);
  return { width: word(16), height: word(20) };
}

/** The size in the first chunk of a WebP file: a lossy, a lossless or an extended image. */
function webpSize(bytes: readonly number[]): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  if (!hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) || !hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return null;
  const at = (index: number) => byteAt(bytes, index);
  if (hasBytes(bytes, [0x56, 0x50, 0x38, 0x20], 12)) {
    // "VP8 ": a frame tag, the start code, then 14 bits of width and of height.
    if (!hasBytes(bytes, [0x9d, 0x01, 0x2a], 23)) return null;
    return { width: (at(26) | (at(27) << 8)) & 0x3fff, height: (at(28) | (at(29) << 8)) & 0x3fff };
  }
  if (hasBytes(bytes, [0x56, 0x50, 0x38, 0x4c], 12)) {
    // "VP8L": a signature byte, then 14 bits of width - 1 and 14 bits of height - 1.
    if (at(20) !== 0x2f) return null;
    return {
      width: 1 + (at(21) | ((at(22) & 0x3f) << 8)),
      height: 1 + ((at(22) >> 6) | (at(23) << 2) | ((at(24) & 0x0f) << 10)),
    };
  }
  if (hasBytes(bytes, [0x56, 0x50, 0x38, 0x58], 12)) {
    // "VP8X": flags and reserved bytes, then 24 bits of canvas width - 1 and of height - 1.
    return {
      width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)),
      height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)),
    };
  }
  return null;
}
