import type { AvatarHue } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { avatarHueSwatch } from "./bloub-avatar";
import type { AvatarMood } from "./bloub-avatar-motion";

/**
 * The agent avatar: the app mark itself, the box seen from its corner, wearing the mark's scribbled
 * face. Agents are recognised by the mark, so the box and its expression are the identity; a mood
 * only changes what the light does.
 *
 * The light is a laser: a bright dot that runs the silhouette, and the eye lit from behind. Nothing
 * is drawn around the box - the mark sits on its own, with no aura.
 */

/** The mark is a square of this side, in its own units, like the app logo. */
const MARK_SIZE = 240;
const CENTER = MARK_SIZE / 2;
const RADIUS = 78;
const OUTER_CORNER = 10;

const LIME = "#98f94f";

export type AgentMarkExpression = "wink" | "squiggle" | "dots" | "flat";

const EXPRESSIONS: readonly AgentMarkExpression[] = ["wink", "squiggle", "dots", "flat"];

/** The resting face an agent keeps: the seed picks one of the mark's scribbles. */
export function avatarMarkExpression(seed: string): AgentMarkExpression {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return EXPRESSIONS[(hash >>> 0) % EXPRESSIONS.length] ?? "wink";
}

/** The accent of an agent's mark: the brand lime, or the hue the person picked. */
export function avatarMarkAccent(hue: AvatarHue | null): string {
  return hue === null ? LIME : avatarHueSwatch(hue);
}

/**
 * The six corners of the box, clockwise from the top, and the three edges that meet in the middle.
 * The faces are the three quads those edges cut the silhouette into.
 */
const CORNERS: readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
] = [
  [CENTER, CENTER - RADIUS],
  [CENTER + RADIUS * Math.cos(Math.PI / 6), CENTER - RADIUS * Math.sin(Math.PI / 6)],
  [CENTER + RADIUS * Math.cos(Math.PI / 6), CENTER + RADIUS * Math.sin(Math.PI / 6)],
  [CENTER, CENTER + RADIUS],
  [CENTER - RADIUS * Math.cos(Math.PI / 6), CENTER + RADIUS * Math.sin(Math.PI / 6)],
  [CENTER - RADIUS * Math.cos(Math.PI / 6), CENTER - RADIUS * Math.sin(Math.PI / 6)],
];

const [TOP, UPPER_RIGHT, LOWER_RIGHT, BOTTOM, LOWER_LEFT, UPPER_LEFT] = CORNERS;

const OUTLINE = roundedPolygon(CORNERS, OUTER_CORNER);
const INNER_EDGES = [
  `M${UPPER_LEFT[0]} ${UPPER_LEFT[1]}L${CENTER} ${CENTER}`,
  `M${UPPER_RIGHT[0]} ${UPPER_RIGHT[1]}L${CENTER} ${CENTER}`,
  `M${CENTER} ${CENTER}L${BOTTOM[0]} ${BOTTOM[1]}`,
].join(" ");
const TOP_FACE = quad(TOP, UPPER_RIGHT, [CENTER, CENTER], UPPER_LEFT);
const RIGHT_FACE = quad(UPPER_RIGHT, LOWER_RIGHT, BOTTOM, [CENTER, CENTER]);
const LEFT_FACE = quad(UPPER_LEFT, [CENTER, CENTER], BOTTOM, LOWER_LEFT);

/** The scribbles live on the left face, as they do on the mark. */
const FACES: Readonly<Record<AgentMarkExpression, { strokes: string; dots: ReadonlyArray<[number, number]> }>> = {
  wink: { strokes: "M64 146 78 132 92 158 102 146 116 170", dots: [[74, 163]] },
  squiggle: { strokes: "M66 138 82 154 96 134 112 152", dots: [[76, 162]] },
  dots: {
    strokes: "",
    dots: [
      [74, 146],
      [104, 160],
    ],
  },
  flat: { strokes: "M66 154 112 136", dots: [[80, 164]] },
};

export interface AgentMarkProps {
  mood?: AvatarMood;
  expression?: AgentMarkExpression;
  /** Any CSS colour. The brand lime by default. */
  accent?: string;
  animated?: boolean;
  class?: string;
  style?: JSX.CSSProperties | string;
}

export function AgentMark(props: AgentMarkProps) {
  const face = createMemo(() => FACES[props.expression ?? "wink"]);
  const mood = () => props.mood ?? "idle";
  return (
    <svg
      class={["agent-mark", props.class].filter(Boolean).join(" ")}
      style={{ "--agent-mark-accent": props.accent ?? LIME, ...(typeof props.style === "object" ? props.style : {}) }}
      viewBox={`0 0 ${MARK_SIZE} ${MARK_SIZE}`}
      data-mood={mood()}
      data-animated={props.animated === false ? "false" : "true"}
      aria-hidden="true"
    >
      <path class="agent-mark-top" d={TOP_FACE} />
      <path class="agent-mark-right" d={RIGHT_FACE} />
      <path class="agent-mark-left" d={LEFT_FACE} />
      <path class="agent-mark-edge" d={OUTLINE} />
      <path class="agent-mark-edge-inner" d={INNER_EDGES} />
      <path class="agent-mark-laser" d={OUTLINE} pathLength="100" />
      <path class="agent-mark-eye" d={face().strokes} />
      {face().dots.map(([x, y]) => (
        <circle class="agent-mark-eye" cx={x} cy={y} r={5.4} />
      ))}
    </svg>
  );
}

function quad(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number],
): string {
  return `M${a}L${b}L${c}L${d}Z`;
}

/** A polygon whose corners are rounded by `radius`, as one closed path. */
function roundedPolygon(points: ReadonlyArray<readonly [number, number]>, radius: number): string {
  const count = points.length;
  const at = (index: number): readonly [number, number] => points[index] ?? points[0] ?? [CENTER, CENTER];
  const corner = (index: number): string => `${at(index)[0]} ${at(index)[1]}`;
  const into = (index: number) => towards(at(index), at((index - 1 + count) % count), radius);
  const out = (index: number) => towards(at(index), at((index + 1) % count), radius);
  let path = `M${out(0)}`;
  for (let index = 1; index < count; index += 1) {
    path += `L${into(index)}Q${corner(index)} ${out(index)}`;
  }
  return `${path}L${into(0)}Q${corner(0)} ${out(0)}Z`;
}

function towards(from: readonly [number, number], to: readonly [number, number], distance: number): string {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  return `${round(from[0] + (dx / length) * distance)} ${round(from[1] + (dy / length) * distance)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
