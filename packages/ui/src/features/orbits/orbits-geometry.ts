/**
 * The shape of one system of the Team panel: the sun in the middle, the working agents on a fast
 * inner ring, the other active agents on a slow outer ring, and the done and idle agents as dots in
 * a column at the right edge. Pure, so the panel measures once and the frame loop only reads.
 */

export interface OrbitEllipse {
  rx: number;
  ry: number;
}

/** Where an agent sits in its system. */
export type OrbitSlot =
  | { kind: "sun" }
  /** On the inner ring, moving. `base` is the angle at clock 0, in radians. */
  | { kind: "orbit"; base: number }
  /** On the outer ring, moving a little to and fro. */
  | { kind: "drift"; angle: number }
  /** On the outer ring, still. */
  | { kind: "still"; angle: number }
  /** A dot at the right edge, `index` of `count` in its column. */
  | { kind: "park"; index: number; count: number };

export interface OrbitGeometryInput {
  /** The inner width of the system, in pixels. */
  width: number;
  /** The right edge of the system name. A bubble starts after it. */
  nameRight: number;
  sunId: string | null;
  /** Working agents: they orbit the inner ring. */
  movers: readonly string[];
  /** Other active agents: they stay on the outer ring. `drift` moves a waiting one a little. */
  still: readonly { id: string; drift: boolean }[];
  /** Done and idle agents. */
  parked: readonly string[];
  /** The agent with a bubble in this system, with the measured height of its bubble. A system has one at most. */
  talker: { id: string; height: number } | null;
}

export interface OrbitGeometry {
  width: number;
  height: number;
  cx: number;
  cy: number;
  inner: OrbitEllipse;
  outer: OrbitEllipse;
  /** Two rings show: working agents inside, the others outside. */
  two: boolean;
  /** The inner ring has moving agents. */
  fast: boolean;
  slots: Record<string, OrbitSlot>;
  /** The space between the middle of the system and the bottom of the bubble. 0 without a talker. */
  bubbleClear: number;
  /** The widest a bubble can be. */
  bubbleWidth: number;
}

export interface OrbitPoint {
  x: number;
  y: number;
  /** -1 at the back of the ring, 1 at the front. A sun or a dot is 0. */
  depth: number;
}

/** Seconds for one lap of a working agent: fast enough to read as busy. */
export const ORBIT_LAP_SECONDS = 3.6;
/** Seconds for one swing of a waiting agent. */
export const ORBIT_DRIFT_SECONDS = 11;
const TAU = Math.PI * 2;
const RING_FLATNESS = 0.36;
/** The outer ring's top right, under the bubbles: an agent that talks moves there. */
const TALK_ANGLE = (305 * Math.PI) / 180;
const STILL_ANGLES = [160, 20, 200, 340, 125, 55].map((degrees) => (degrees * Math.PI) / 180);
const PARK_GAP = 20;
const BUBBLE_MAX_WIDTH = 236;
/**
 * The smallest half height of the ring of working agents. At the top and the bottom of that ring, a
 * working planet passes over or under the sun, which can work too. The drawn working ring of the sun
 * is 27 px from its middle, and that of a planet 21 px at its largest scale, so the two keep 4 px apart.
 */
const INNER_MIN_RY = 27 + 21 + 4;
/** The space between the inner and the outer ring at their top and bottom. */
const RING_GAP = 8;

export function orbitGeometry(input: OrbitGeometryInput): OrbitGeometry {
  const width = Math.max(0, input.width);
  const rxMax = Math.max(96, Math.min(156, width / 2 - 42));
  const fast = input.movers.length > 0;
  const two = fast && input.still.length > 0;
  const single = { rx: rxMax * 0.7, ry: Math.max(rxMax * 0.7 * RING_FLATNESS, fast ? INNER_MIN_RY : 0) };
  const twoInner = { rx: rxMax * 0.54, ry: Math.max(INNER_MIN_RY, rxMax * 0.54 * 0.48) };
  const inner = two ? twoInner : single;
  const outer = two ? { rx: rxMax, ry: Math.max(rxMax * RING_FLATNESS, twoInner.ry + RING_GAP) } : single;
  const cx = width / 2 + 8;
  const talker = input.talker;
  // The bottom of the bubble stays above the agent that talks, so nothing passes under the bubble.
  let bubbleClear = 0;
  if (talker)
    bubbleClear = talker.id === input.sunId ? (fast ? inner.ry + 18 : 30) : -Math.sin(TALK_ANGLE) * outer.ry + 18;
  let cy = (two ? 20 : 24) + outer.ry;
  if (talker) cy = Math.max(cy, 6 + talker.height + bubbleClear);
  const parkRows = Math.max(1, Math.floor((outer.ry * 2 + PARK_GAP) / PARK_GAP));
  const parkHeight = Math.min(input.parked.length, parkRows) * PARK_GAP;
  const height = Math.round(Math.max(cy + outer.ry + 20, cy + parkHeight / 2 + 14));

  const slots: Record<string, OrbitSlot> = {};
  if (input.sunId) slots[input.sunId] = { kind: "sun" };
  input.movers.forEach((id, index) => {
    slots[id] = { kind: "orbit", base: 0.95 + (index * TAU) / input.movers.length };
  });
  let stillIndex = 0;
  for (const agent of input.still) {
    const angle =
      agent.id === talker?.id ? TALK_ANGLE : (STILL_ANGLES[stillIndex++ % STILL_ANGLES.length] ?? STILL_ANGLES[0] ?? 0);
    slots[agent.id] = agent.drift ? { kind: "drift", angle } : { kind: "still", angle };
  }
  input.parked.forEach((id, index) => {
    slots[id] = { kind: "park", index, count: input.parked.length };
  });
  return {
    width,
    height,
    cx,
    cy,
    inner,
    outer,
    two,
    fast,
    slots,
    bubbleClear,
    bubbleWidth: Math.max(120, Math.min(BUBBLE_MAX_WIDTH, width - input.nameRight)),
  };
}

function ringPoint(center: { cx: number; cy: number }, ring: OrbitEllipse, angle: number): OrbitPoint {
  return { x: center.cx + Math.cos(angle) * ring.rx, y: center.cy + Math.sin(angle) * ring.ry, depth: Math.sin(angle) };
}

/**
 * Where a slot is at `clock` seconds. `phase` moves the swing of a drifting agent, so two waiting
 * agents do not swing together.
 */
export function orbitPoint(geometry: OrbitGeometry, slot: OrbitSlot, clock: number, phase = 0): OrbitPoint {
  switch (slot.kind) {
    case "sun":
      return { x: geometry.cx, y: geometry.cy, depth: 0 };
    case "orbit":
      return ringPoint(geometry, geometry.inner, orbitAngle(slot, clock));
    case "drift":
      return ringPoint(
        geometry,
        geometry.outer,
        slot.angle + 0.32 * Math.sin(((clock + phase) * TAU) / ORBIT_DRIFT_SECONDS),
      );
    case "still":
      return ringPoint(geometry, geometry.outer, slot.angle);
    case "park": {
      const rows = Math.max(1, Math.floor((geometry.outer.ry * 2 + PARK_GAP) / PARK_GAP));
      const column = Math.floor(slot.index / rows);
      const row = slot.index % rows;
      const inColumn = Math.min(rows, slot.count - column * rows);
      return {
        x: Math.min(geometry.width - 10, geometry.cx + geometry.outer.rx + 22) - column * 18,
        y: geometry.cy + 4 + (row - (inColumn - 1) / 2) * PARK_GAP,
        depth: 0,
      };
    }
  }
}

/** The angle of an orbiting agent at `clock` seconds. */
export function orbitAngle(slot: Extract<OrbitSlot, { kind: "orbit" }>, clock: number): number {
  return slot.base + (clock * TAU) / ORBIT_LAP_SECONDS;
}

/** A point on the inner ring, for the trail that follows an orbiting agent. */
export function orbitTrailPoint(geometry: OrbitGeometry, angle: number): OrbitPoint {
  return ringPoint(geometry, geometry.inner, angle);
}

/** Whether two slots put an agent in the same place, so a change of state needs no glide. */
export function sameOrbitSlot(left: OrbitSlot | undefined, right: OrbitSlot | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  switch (left.kind) {
    case "sun":
      return true;
    case "orbit":
      return right.kind === "orbit" && left.base === right.base;
    case "drift":
    case "still":
      return (right.kind === "drift" || right.kind === "still") && left.angle === right.angle;
    case "park":
      return right.kind === "park" && left.index === right.index && left.count === right.count;
  }
}
