import { COLOR_BY_ID, type ColorId, EXPRESSIONS, type ExpressionId, type ShapeId } from "@norbert_bodziony/bloub";
import type { AvatarHue } from "@openbot/contracts/ipc";

export type SupportedAvatarSilhouetteId = Exclude<ShapeId, "goutte">;

export interface BloubAvatarProfile {
  shape: SupportedAvatarSilhouetteId;
  color: string;
  expression: ExpressionId;
}

/** The app mark every generated agent wears: the box, its fill and its eyes (see `tokens.css`). */
export const AVATAR_MARK_SHAPE = "squircle" satisfies SupportedAvatarSilhouetteId;
// Bloub's colour table is a closed union, and the brand fill is registered into it at runtime.
// biome-ignore lint/nursery/noUnsafeTypeAssertion: the id exists only once it is registered below.
export const AVATAR_MARK_COLOR = "marca" as ColorId;
export const AVATAR_MARK_EYE = "#040007";

// Bloub resolves a colour id through its own table, so the brand fill has to be registered there
// before any avatar asks for it.
COLOR_BY_ID.set(AVATAR_MARK_COLOR, { id: AVATAR_MARK_COLOR, hex: "#98f94f" });

const AUTOMATIC_COLORS = ["rouge", "orange", "ambre", "vert", "turquoise", "bleu", "violet", "rose"] as const;

const HUE_COLORS: Readonly<Record<AvatarHue, ColorId>> = {
  0: "rouge",
  30: "orange",
  55: "ambre",
  100: "vert",
  150: "vert",
  185: "turquoise",
  215: "bleu",
  245: "violet",
  280: "violet",
  320: "rose",
};

export const AVATAR_HUE_OPTIONS: ReadonlyArray<{
  hue: AvatarHue;
  label: string;
}> = [
  { hue: 0, label: "Red" },
  { hue: 30, label: "Orange" },
  { hue: 55, label: "Yellow" },
  { hue: 100, label: "Lime" },
  { hue: 150, label: "Green" },
  { hue: 185, label: "Cyan" },
  { hue: 215, label: "Blue" },
  { hue: 245, label: "Indigo" },
  { hue: 280, label: "Violet" },
  { hue: 320, label: "Magenta" },
];

// Hues 100 and 280 stay valid for stored agents, but draw the same color as 150 and 245.
export const AVATAR_HUE_CHOICES = AVATAR_HUE_OPTIONS.filter((option) => option.hue !== 100 && option.hue !== 280);

export function bloubAvatarProfile(seed: string, hue: AvatarHue | null): BloubAvatarProfile {
  const expression = requiredItem(EXPRESSIONS, stableIndex(`${seed}:expression`, EXPRESSIONS.length)).id;

  return {
    // The silhouette is the app mark, so every agent is recognised by the same box. What stays
    // personal is the face, and the fill only when the person picked a hue.
    shape: AVATAR_MARK_SHAPE,
    expression,
    color: hue === null ? AVATAR_MARK_COLOR : HUE_COLORS[hue],
  };
}

export function avatarHueSwatch(hue: AvatarHue): string {
  return colorHex(HUE_COLORS[hue]);
}

export function avatarHeadColor(seed: string, hue: AvatarHue | null): string {
  // The name tint keeps the seeded palette, so two agents stay told apart in a chat even though
  // every avatar is now the same brand box.
  const color =
    hue === null
      ? requiredItem(AUTOMATIC_COLORS, stableIndex(`${seed}:color`, AUTOMATIC_COLORS.length))
      : HUE_COLORS[hue];
  return colorHex(color);
}

export function avatarCandidateSeeds(agentId: string, currentSeed: string, batch: number): string[] {
  const candidates = [currentSeed];
  const firstProfile = bloubAvatarProfile(currentSeed, null);
  const usedExpressions = new Set<ExpressionId>([firstProfile.expression]);
  let index = 1;

  // The silhouette no longer varies, so a candidate is worth offering when its face is new.
  while (usedExpressions.size < EXPRESSIONS.length) {
    const candidate = `${agentId}:avatar:${batch}:${index}`;
    index += 1;
    if (candidates.includes(candidate)) continue;
    const profile = bloubAvatarProfile(candidate, null);
    if (usedExpressions.has(profile.expression)) continue;
    candidates.push(candidate);
    usedExpressions.add(profile.expression);
  }

  while (candidates.length < 12) {
    const candidate = `${agentId}:avatar:${batch}:${index}`;
    index += 1;
    if (candidates.includes(candidate)) continue;
    candidates.push(candidate);
  }

  return candidates;
}

function stableIndex(value: string, length: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % length;
}

function colorHex(color: ColorId): string {
  const value = COLOR_BY_ID.get(color)?.hex;
  if (!value) throw new Error(`Bloub did not return a color for ${color}.`);
  return value;
}

function requiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error("Bloub avatar options are empty.");
  return item;
}
