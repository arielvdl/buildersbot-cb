import type { AvatarHue } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, Show } from "solid-js";
import { agentMarkEyelid } from "./agent-mark-eyes";
import type { AgentMarkRole } from "./agent-mark-role";
import { AGENT_MARK_DANGER, type AgentMarkShades, agentMarkShades } from "./agent-mark-shades";
import { avatarHueSwatch } from "./bloub-avatar";
import type { AvatarMood } from "./bloub-avatar-motion";

export { type AgentMarkRole, avatarMarkRole } from "./agent-mark-role";

/**
 * The agent avatar: the app mark itself, the box seen from its corner, tinted in the agent's colour.
 * The left face has two eyes, and the right face has the emblem of the agent's role. Agents are
 * recognised by the box, its colour and the emblem.
 *
 * A mood puts a symbol on the lid, sets the eyelids and decides the motion: a laser on the edge,
 * sparks, a halo and points of light in orbit while the agent works. Nothing is drawn behind the box:
 * no frame and no background.
 */

/** The mark is a square of this side, in its own units, like the app logo. */
const MARK_SIZE = 240;
const CENTER = MARK_SIZE / 2;
const RADIUS = 78;
const OUTER_CORNER = 10;

const LIME = "#98f94f";

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
const MIDDLE: readonly [number, number] = [CENTER, CENTER];

const OUTLINE = roundedPolygon(CORNERS, OUTER_CORNER);
const INNER_EDGES = [
  `M${UPPER_LEFT[0]} ${UPPER_LEFT[1]}L${CENTER} ${CENTER}`,
  `M${UPPER_RIGHT[0]} ${UPPER_RIGHT[1]}L${CENTER} ${CENTER}`,
  `M${CENTER} ${CENTER}L${BOTTOM[0]} ${BOTTOM[1]}`,
].join(" ");
const TOP_FACE = quad(TOP, UPPER_RIGHT, MIDDLE, UPPER_LEFT);
const RIGHT_FACE = quad(UPPER_RIGHT, LOWER_RIGHT, BOTTOM, MIDDLE);
const LEFT_FACE = quad(UPPER_LEFT, MIDDLE, BOTTOM, LOWER_LEFT);

/**
 * The lid symbols are drawn in a 100 x 100 square. This matrix lays the square on the top face:
 * its corners go to the top, right, middle and left corners of the lid.
 */
const LID_PLANE = "matrix(.676 .39 -.676 .39 120 42)";
/** The eyes are drawn in a 68 x 78 box. This matrix lays the box on the left face. */
const LEFT_PLANE = "matrix(1 .5774 0 1 52.4 81)";
/** The same box on the right face, for the emblem of the role. */
const RIGHT_PLANE = "matrix(1 -.5774 0 1 120 120)";
/** The role symbol is drawn in the 68 x 78 box too. This makes it smaller round the middle of the box. */
const EMBLEM_SCALE = "translate(34 39) scale(.62) translate(-34 -39)";
/** The orbit is a circle round the middle of the box, flattened to lie in the plane of the lid. */
const ORBIT_PLANE = `translate(${CENTER} ${CENTER}) scale(1 .5774)`;

/** The eyes, in the box of the left face: the middle of each eye, and its half width and half height. */
const EYES = { y: 24, centers: [22, 46], radiusX: 9.5, radiusY: 10 } as const;
/** An eyelid at 1 comes down this far, in the units of the box: the height of the eye. */
const EYELID_TRAVEL = 20;

/** A four-point star, drawn round its own middle. */
const SPARK = "M0-14Q2.4-2.4 14 0Q2.4 2.4 0 14Q-2.4 2.4-14 0Q-2.4-2.4 0-14Z";
/** Where the sparks flash: the corners of the lid first. Only `live` shows the last four. */
const SPARK_POINTS = [
  TOP,
  UPPER_RIGHT,
  UPPER_LEFT,
  MIDDLE,
  halfway(TOP, UPPER_RIGHT),
  halfway(TOP, UPPER_LEFT),
  halfway(UPPER_RIGHT, LOWER_RIGHT),
  halfway(UPPER_LEFT, LOWER_LEFT),
].map(([x, y]) => `translate(${round(x)} ${round(y)})`);

const ORBITS = {
  working: { radius: 112, dots: 2 },
  live: { radius: 116, dots: 3 },
} as const;

/** The symbol on the lid, for the moods that have one. */
const LID_SYMBOLS: Partial<Record<AvatarMood, () => JSX.Element>> = {
  waiting: () => (
    <>
      <circle cx="50" cy="50" r="27" />
      <circle class="agent-mark-throb" cx="50" cy="50" r="9" fill="currentColor" stroke="none" />
    </>
  ),
  failed: () => <path d="M28 28 72 72M72 28 28 72" />,
  working: () => (
    <>
      <path class="agent-mark-chevron" d="M18 30 36 50 18 70" />
      <path class="agent-mark-chevron" d="M42 30 60 50 42 70" />
      <path class="agent-mark-chevron" d="M66 30 84 50 66 70" />
    </>
  ),
  live: () => (
    <>
      {[16, 31, 46, 61, 76].map((x) => (
        <rect class="agent-mark-bar" x={x} y="22" width="11" height="56" rx="3" fill="currentColor" stroke="none" />
      ))}
    </>
  ),
};

/**
 * The symbol of each role, on the right face. The classes name the part that moves while the agent
 * works: `sweep` goes from side to side, `bob` up and down, `flicker` goes on and off, `pulse` grows
 * and shrinks, and `dash` runs along its line.
 */
const ROLE_SYMBOLS: Readonly<Record<AgentMarkRole, () => JSX.Element>> = {
  research: () => (
    <g class="agent-mark-sweep">
      <circle cx="29" cy="33" r="14" />
      <path d="M39.5 43.5 53 57" />
    </g>
  ),
  support: () => (
    <>
      <path d="M9 18h50v30H33L21 60V48H9z" />
      <circle class="agent-mark-flicker" cx="22" cy="33" r="3" fill="currentColor" stroke="none" />
      <circle class="agent-mark-flicker agent-mark-flicker-2" cx="34" cy="33" r="3" fill="currentColor" stroke="none" />
      <circle class="agent-mark-flicker agent-mark-flicker-3" cx="46" cy="33" r="3" fill="currentColor" stroke="none" />
    </>
  ),
  finance: () => (
    <>
      <circle class="agent-mark-pulse" cx="34" cy="39" r="20" />
      <path d="M34 25v28M41 32c-2-4-14-4-14 2s14 3 14 9-12 6-14 1" />
    </>
  ),
  calendar: () => (
    <>
      <rect x="9" y="19" width="50" height="43" rx="6" />
      <path d="M9 33h50M23 13v10M45 13v10" />
      <rect class="agent-mark-flicker" x="17" y="40" width="8" height="7" rx="1.5" fill="currentColor" stroke="none" />
      <rect
        class="agent-mark-flicker agent-mark-flicker-2"
        x="30"
        y="40"
        width="8"
        height="7"
        rx="1.5"
        fill="currentColor"
        stroke="none"
      />
      <rect
        class="agent-mark-flicker agent-mark-flicker-3"
        x="43"
        y="40"
        width="8"
        height="7"
        rx="1.5"
        fill="currentColor"
        stroke="none"
      />
    </>
  ),
  code: () => (
    <>
      <path d="M22 26 8 39l14 13M46 26l14 13-14 13" />
      <path class="agent-mark-flicker" d="M38 23 30 55" />
    </>
  ),
  content: () => (
    <>
      <path d="M9 22h50M9 36h38" />
      <path class="agent-mark-sweep" d="M9 50h26" />
      <rect class="agent-mark-flicker" x="40" y="44" width="5" height="13" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  deploy: () => (
    <>
      <g class="agent-mark-bob">
        <path d="M34 12v42M18 28 34 12l16 16" />
      </g>
      <path class="agent-mark-flicker" d="M25 62l9 8 9-8" />
    </>
  ),
  review: () => (
    <g class="agent-mark-sweep">
      <circle cx="29" cy="33" r="15" />
      <path d="M40.5 44.5 54 58" />
      <path class="agent-mark-flicker" d="M21 33l6 7 11-14" />
    </g>
  ),
  design: () => (
    <>
      <path class="agent-mark-sweep" d="M13 59l4-13 27-27 9 9-27 27z" />
      <path d="M44 19l9 9" />
      <circle class="agent-mark-flicker" cx="12" cy="26" r="3.4" fill="currentColor" stroke="none" />
      <circle
        class="agent-mark-flicker agent-mark-flicker-2"
        cx="22"
        cy="18"
        r="3.4"
        fill="currentColor"
        stroke="none"
      />
    </>
  ),
  social: () => <path class="agent-mark-pulse" d="M34 58C8 42 12 20 25 20c6 0 9 4 9 8 0-4 3-8 9-8 13 0 17 22-9 38z" />,
  monitor: () => <path class="agent-mark-dash" d="M5 40h14l8-21 11 42 9-21h16" />,
  personal: () => <path class="agent-mark-pulse" d="M34 9Q37 33 59 39Q37 45 34 69Q31 45 9 39Q31 33 34 9Z" />,
};

export interface AgentMarkProps {
  mood?: AvatarMood;
  /** The emblem of the agent's role on the right face. Without one, the right face is plain. */
  role?: AgentMarkRole | null | undefined;
  /** Any CSS colour. The brand lime by default. A hex colour also gives the lid symbol its ink. */
  accent?: string;
  /** Moves the start of the motion, so agents side by side do not blink or flash together. */
  seed?: string | undefined;
  animated?: boolean;
  class?: string;
  style?: JSX.CSSProperties | string;
}

export function AgentMark(props: AgentMarkProps) {
  const glossId = createUniqueId();
  const lidId = createUniqueId();
  const shapeId = createUniqueId();
  const mood = (): AvatarMood => props.mood ?? "idle";
  const shades = createMemo(() => agentMarkShades(mood() === "failed" ? AGENT_MARK_DANGER : (props.accent ?? LIME)));
  const busy = () => mood() === "working" || mood() === "live";
  const orbit = () => (mood() === "live" ? ORBITS.live : ORBITS.working);
  const phase = () => (props.seed === undefined ? 0 : (seedHash(`${props.seed}:phase`) % 1600) / 1000);
  return (
    <svg
      class={["agent-mark", props.class].filter(Boolean).join(" ")}
      style={{
        "--agent-mark-accent": shades().top,
        "--agent-mark-phase": `${-phase()}s`,
        "--agent-mark-eyelid": String(agentMarkEyelid(mood())),
        ...(typeof props.style === "object" ? props.style : {}),
      }}
      viewBox={`0 0 ${MARK_SIZE} ${MARK_SIZE}`}
      data-mood={mood()}
      data-animated={props.animated === false ? "false" : "true"}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={glossId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity="0.26" />
          <stop offset="0.75" stop-color="#fff" stop-opacity="0" />
        </linearGradient>
        <clipPath id={lidId}>
          <path d={TOP_FACE} />
        </clipPath>
        <clipPath id={shapeId}>
          <path d={OUTLINE} />
        </clipPath>
      </defs>
      <Show when={busy()}>
        <path class="agent-mark-halo" d={OUTLINE} />
        <Show when={mood() === "live"}>
          <path class="agent-mark-halo agent-mark-halo-echo" d={OUTLINE} />
        </Show>
        <g transform={ORBIT_PLANE}>
          <g class="agent-mark-orbit">
            <circle class="agent-mark-orbit-trail" r={orbit().radius} />
            {Array.from({ length: orbit().dots }, (_, index) => {
              const angle = (index * 2 * Math.PI) / orbit().dots;
              return (
                <circle
                  class="agent-mark-orbit-dot"
                  cx={round(orbit().radius * Math.cos(angle))}
                  cy={round(orbit().radius * Math.sin(angle))}
                  r={index === 0 ? 9 : 6.5}
                />
              );
            })}
          </g>
        </g>
      </Show>
      <g class="agent-mark-shell">
        <g class="agent-mark-body">
          <path class="agent-mark-top" d={TOP_FACE} fill={shades().top} />
          <path class="agent-mark-right" d={RIGHT_FACE} fill={shades().right} />
          <path class="agent-mark-left" d={LEFT_FACE} fill={shades().left} />
          <path d={TOP_FACE} fill={`url(#${glossId})`} />
          <Show when={busy() || mood() === "waiting"}>
            <path class="agent-mark-flash" d={TOP_FACE} fill={shades().lite} />
          </Show>
          <path
            class="agent-mark-edge"
            d={OUTLINE}
            fill="none"
            stroke={shades().ink}
            stroke-width="7"
            stroke-linejoin="round"
          />
          {/* The inner edges end at the corners of the silhouette. Their round caps would go past the
              rounded corners, so the silhouette clips them. */}
          <path
            class="agent-mark-edge-inner"
            d={INNER_EDGES}
            clip-path={`url(#${shapeId})`}
            fill="none"
            stroke={shades().lite}
            stroke-width="6"
            stroke-linecap="round"
            opacity="0.38"
          />
          <Show when={LID_SYMBOLS[mood()]}>
            {(symbol) => (
              <g
                class="agent-mark-lid"
                clip-path={`url(#${lidId})`}
                color={shades().glyph}
                fill="none"
                stroke="currentColor"
                stroke-width="8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <g transform={LID_PLANE}>{symbol()()}</g>
              </g>
            )}
          </Show>
          <AgentMarkSide shades={shades()} eyelid={agentMarkEyelid(mood())} />
          <Show when={props.role}>
            {(role) => (
              <g
                class="agent-mark-emblem"
                transform={RIGHT_PLANE}
                color={shades().lite}
                fill="none"
                stroke="currentColor"
                stroke-width="5.4"
                stroke-linecap="round"
                stroke-linejoin="round"
                opacity="0.96"
              >
                <g transform={EMBLEM_SCALE}>{ROLE_SYMBOLS[role()]()}</g>
              </g>
            )}
          </Show>
          {/* The laser is light that moves, so a mark that holds still does not draw it. */}
          <Show when={props.animated !== false}>
            <path class="agent-mark-laser" d={OUTLINE} pathLength="100" />
            <Show when={mood() === "live"}>
              <path class="agent-mark-counter-laser" d={OUTLINE} pathLength="100" />
            </Show>
          </Show>
          <Show when={busy()}>
            <g class="agent-mark-sparks">
              {SPARK_POINTS.map((at) => (
                <g transform={at}>
                  <path class="agent-mark-spark" d={SPARK} />
                </g>
              ))}
            </g>
          </Show>
        </g>
      </g>
    </svg>
  );
}

/**
 * The left face of the mark: two eyes. The pupils look around and the eyelids blink, and both are
 * clipped to the white of the eye. The eyelid is a band in the colour of the face that comes down
 * from above the eye; `eyelid` sets how far, from 0 (open) to 1 (closed). Its `transform` attribute
 * holds that place for a copy of the SVG with no stylesheet. In the app, the CSS moves it.
 */
function AgentMarkSide(props: { shades: AgentMarkShades; eyelid: number }) {
  const clipIds = EYES.centers.map(() => createUniqueId());
  return (
    <g class="agent-mark-side" transform={LEFT_PLANE}>
      <defs>
        {EYES.centers.map((x, index) => (
          <clipPath id={clipIds[index]}>
            <ellipse cx={x} cy={EYES.y} rx={EYES.radiusX} ry={EYES.radiusY} />
          </clipPath>
        ))}
      </defs>
      {EYES.centers.map((x, index) => (
        <g>
          <ellipse
            cx={x}
            cy={EYES.y}
            rx={EYES.radiusX}
            ry={EYES.radiusY}
            fill={props.shades.lite}
            stroke={props.shades.ink}
            stroke-width="1.8"
          />
          <g clip-path={`url(#${clipIds[index]})`}>
            <g class="agent-mark-pupil">
              <circle cx={x} cy={EYES.y} r="4.6" fill={props.shades.ink} />
              <circle cx={x + 1.8} cy={EYES.y - 2} r="1.5" fill="#fff" />
            </g>
            <g class="agent-mark-eyelid" transform={`translate(0 ${round(props.eyelid * EYELID_TRAVEL)})`}>
              <rect x={x - 11} y={EYES.y - EYES.radiusY - 22} width="22" height="22" fill={props.shades.left} />
              <path
                d={`M${x - 10} ${EYES.y - EYES.radiusY}H${x + 10}`}
                fill="none"
                stroke={props.shades.ink}
                stroke-width="2.6"
                stroke-linecap="round"
              />
            </g>
          </g>
        </g>
      ))}
    </g>
  );
}

/** FNV-1a: the same seed always gives the same start of the motion. */
function seedHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function quad(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number],
): string {
  return `M${a}L${b}L${c}L${d}Z`;
}

function halfway(a: readonly [number, number], b: readonly [number, number]): readonly [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
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
