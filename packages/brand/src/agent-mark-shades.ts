/**
 * The colours of an agent's mark, from the one colour of the agent.
 *
 * The box is tinted on all faces. The lid is the colour itself, and the two sides are the same hue
 * with less light, as if the light comes from above. The steps are in OKLCH, so each hue loses the
 * same amount of light. A shade that is out of the sRGB gamut loses chroma until it fits.
 */

export interface AgentMarkShades {
  /** The lid: the colour itself. */
  top: string;
  /** The right face, in some shadow. */
  right: string;
  /** The left face, in more shadow. */
  left: string;
  /** The outline. */
  ink: string;
  /** Almost white, with a trace of the hue: the inner edges, the role symbol and the lit lid. */
  lite: string;
  /** The lid symbol: white, or a dark ink when white does not show on the colour, as on lime or yellow. */
  glyph: string;
}

/** `--openbot-danger`. A failed agent's mark is red. */
export const AGENT_MARK_DANGER = "#fd2f3b";

/** Above this OKLab lightness, a white symbol does not show on the lid. */
const LIGHT_LID = 0.78;
const WHITE = "#ffffff";

/** The shades of each colour, computed one time. There are a few avatar colours, so this stays small. */
const SHADES = new Map<string, AgentMarkShades>();

export function agentMarkShades(accent: string): AgentMarkShades {
  const known = SHADES.get(accent);
  if (known) return known;
  const shades = computeShades(accent);
  SHADES.set(accent, shades);
  return shades;
}

function computeShades(accent: string): AgentMarkShades {
  const color = hexToOklch(accent);
  if (!color) return mixedShades(accent);
  const [lightness, chroma, hue] = color;
  return {
    top: accent,
    right: oklchToHex(lightness * 0.74, chroma * 0.92, hue),
    left: oklchToHex(lightness * 0.56, chroma * 0.8, hue),
    ink: oklchToHex(lightness * 0.34, chroma * 0.6, hue),
    lite: oklchToHex(Math.max(0.965, lightness), Math.min(chroma * 0.22, 0.035), hue),
    glyph: lightness > LIGHT_LID ? oklchToHex(0.3, chroma * 0.5, hue) : WHITE,
  };
}

/**
 * A colour that is not a hex code, such as a CSS variable. The browser mixes the shades. The lid
 * symbol is white, or a dark ink of the hue when the lightness is above `LIGHT_LID`: the clamps give
 * one value or the other.
 */
function mixedShades(accent: string): AgentMarkShades {
  const mix = (percent: number, base: string) => `color-mix(in oklab, ${accent} ${percent}%, ${base})`;
  const light = `clamp(0, (l - ${LIGHT_LID}) * 1000, 1)`;
  return {
    top: accent,
    right: mix(74, "black"),
    left: mix(56, "black"),
    ink: mix(34, "black"),
    lite: mix(6, "white"),
    glyph: `oklch(from ${accent} clamp(0.3, (${LIGHT_LID} - l) * 1000, 1) calc(c * 0.5 * ${light}) h)`,
  };
}

/** Lightness, chroma and hue (in radians) of a `#rgb` or `#rrggbb` colour, or `null` for any other text. */
function hexToOklch(hex: string): readonly [number, number, number] | null {
  const digits = /^#([\da-f]{3}|[\da-f]{6})$/iu.exec(hex.trim())?.[1];
  if (!digits) return null;
  const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits;
  const value = Number.parseInt(full, 16);
  const red = toLinear((value >> 16) & 255);
  const green = toLinear((value >> 8) & 255);
  const blue = toLinear(value & 255);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, Math.hypot(a, b), Math.atan2(b, a)];
}

function oklchToHex(lightness: number, chroma: number, hue: number): string {
  let kept = chroma;
  let rgb = oklchToLinearRgb(lightness, kept, hue);
  while (kept > 0 && !rgb.every((channel) => channel > -1e-4 && channel < 1 + 1e-4)) {
    kept = Math.max(0, kept - 0.004);
    rgb = oklchToLinearRgb(lightness, kept, hue);
  }
  const byte = (channel: number) =>
    Math.round(toGamma(Math.min(1, Math.max(0, channel))) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${rgb.map(byte).join("")}`;
}

function oklchToLinearRgb(lightness: number, chroma: number, hue: number): readonly [number, number, number] {
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function toLinear(byte: number): number {
  const channel = byte / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function toGamma(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}
