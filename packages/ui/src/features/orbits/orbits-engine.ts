import {
  type OrbitGeometry,
  type OrbitPoint,
  type OrbitSlot,
  orbitAngle,
  orbitPoint,
  orbitTrailPoint,
  sameOrbitSlot,
} from "./orbits-geometry";

/**
 * The motion of the Team panel. Solid draws the structure once; this module writes only `transform`
 * and `z-index` on each frame, so a frame does no layout and no reactive work. One loop serves the
 * whole panel, and it runs only while the panel is open, the window shows and motion is allowed.
 */

interface OrbitNode {
  id: string;
  systemKey: string;
  el: HTMLElement;
  trails: HTMLElement[];
  slot: OrbitSlot | null;
  /** The node moves on each frame. Outside the motion budget, a working agent holds its place. */
  moving: boolean;
  point: OrbitPoint;
  glide: { from: OrbitPoint; progress: number } | null;
  /** Seconds the node was held, so it goes on from where it stopped. */
  lag: number;
  held: boolean;
  phase: number;
}

type OrbitSlots = Readonly<Record<string, { slot: OrbitSlot; moving: boolean }>>;

interface OrbitSystemState {
  el: HTMLElement;
  geometry: OrbitGeometry | null;
  /** The last slots, so a node that mounts after the layout finds its place. */
  slots: OrbitSlots;
}

interface OrbitLinkPath {
  path: SVGPathElement;
  from: string;
  to: string;
}

/** Seconds a node takes to glide to a new place when its state changes. */
const GLIDE_SECONDS = 0.7;
/** The gap, in radians, between an orbiting agent and each dot of its trail. */
const TRAIL_STEP = 0.26;

export type OrbitEngine = ReturnType<typeof createOrbitEngine>;

export function createOrbitEngine() {
  let clock = 0;
  let glides = true;
  const nodes = new Map<string, OrbitNode>();
  const systems = new Map<string, OrbitSystemState>();
  /** Trails that came before their node. */
  const waitingTrails = new Map<string, HTMLElement[]>();
  let links: OrbitLinkPath[] = [];

  function place(node: OrbitNode, point: OrbitPoint) {
    node.point = point;
    const ring = node.slot?.kind === "orbit" || node.slot?.kind === "drift" || node.slot?.kind === "still";
    const scale = ring ? 0.86 + (0.16 * (point.depth + 1)) / 2 : 1;
    node.el.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    node.el.style.zIndex = node.slot?.kind === "sun" ? "4" : point.depth < 0 ? "2" : "5";
  }

  function target(node: OrbitNode): OrbitPoint | null {
    const geometry = systems.get(node.systemKey)?.geometry;
    if (!geometry || !node.slot) return null;
    const time = node.moving ? clock - node.lag : 0;
    return orbitPoint(geometry, node.slot, time, node.phase);
  }

  function placeTrails(node: OrbitNode) {
    const geometry = systems.get(node.systemKey)?.geometry;
    if (!geometry || node.slot?.kind !== "orbit" || node.trails.length === 0) return;
    const angle = orbitAngle(node.slot, clock - node.lag);
    node.trails.forEach((trail, index) => {
      const point = orbitTrailPoint(geometry, angle - TRAIL_STEP * (index + 1));
      trail.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`;
      trail.style.zIndex = point.depth < 0 ? "1" : "4";
    });
  }

  function update(node: OrbitNode, dt: number) {
    const live = target(node);
    if (!live) return;
    let point = live;
    if (node.glide) {
      const progress = Math.min(1, node.glide.progress + dt / GLIDE_SECONDS);
      const eased = 1 - (1 - progress) ** 3;
      point = {
        x: node.glide.from.x + (live.x - node.glide.from.x) * eased,
        y: node.glide.from.y + (live.y - node.glide.from.y) * eased,
        depth: live.depth,
      };
      node.glide = progress >= 1 ? null : { from: node.glide.from, progress };
    }
    place(node, point);
    placeTrails(node);
  }

  function linkPoint(id: string): { x: number; y: number } | null {
    const node = nodes.get(id);
    const system = node ? systems.get(node.systemKey) : undefined;
    if (!node || !system?.geometry) return null;
    return { x: node.point.x + system.el.offsetLeft, y: node.point.y + system.el.offsetTop };
  }

  function drawLinks() {
    for (const link of links) {
      const from = linkPoint(link.from);
      const to = linkPoint(link.to);
      if (!from || !to) {
        link.path.setAttribute("d", "");
        continue;
      }
      const same = nodes.get(link.from)?.systemKey === nodes.get(link.to)?.systemKey;
      const bend = Math.max(from.x, to.x) + 50;
      link.path.setAttribute(
        "d",
        same
          ? `M${from.x.toFixed(1)} ${from.y.toFixed(1)} L${to.x.toFixed(1)} ${to.y.toFixed(1)}`
          : `M${from.x.toFixed(1)} ${from.y.toFixed(1)} Q${bend.toFixed(1)} ${((from.y + to.y) / 2).toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`,
      );
    }
  }

  return {
    /** A glide only runs when motion is allowed. Without it, a node jumps to its new place. */
    setGlides(on: boolean) {
      glides = on;
    },
    system(key: string, el: HTMLElement) {
      const previous = systems.get(key);
      systems.set(key, { el, geometry: previous?.geometry ?? null, slots: previous?.slots ?? {} });
      return () => {
        if (systems.get(key)?.el === el) systems.delete(key);
      };
    },
    /** A node of an agent. Its place comes from the last layout of its system. */
    node(id: string, systemKey: string, el: HTMLElement) {
      const known = systems.get(systemKey)?.slots[id];
      const node: OrbitNode = {
        id,
        systemKey,
        el,
        trails: waitingTrails.get(id) ?? [],
        slot: known?.slot ?? null,
        moving: known?.moving ?? false,
        point: { x: 0, y: 0, depth: 0 },
        glide: null,
        lag: 0,
        held: false,
        phase: Math.random() * 6,
      };
      nodes.set(id, node);
      waitingTrails.delete(id);
      update(node, 0);
      return () => {
        if (nodes.get(id) === node) nodes.delete(id);
      };
    },
    /** The trail dots that follow an orbiting node. */
    trails(id: string, trails: HTMLElement[]) {
      const node = nodes.get(id);
      if (!node) {
        waitingTrails.set(id, trails);
        return;
      }
      node.trails = trails;
      placeTrails(node);
    },
    /** New measures for a system, and the slot of each of its agents. Nodes that change place glide. */
    layout(key: string, geometry: OrbitGeometry, slots: OrbitSlots) {
      const system = systems.get(key);
      if (!system) return;
      system.geometry = geometry;
      system.slots = slots;
      for (const node of nodes.values()) {
        if (node.systemKey !== key) continue;
        const next = slots[node.id];
        if (!next) continue;
        const moved = node.slot !== null && !sameOrbitSlot(node.slot, next.slot);
        if (moved && glides) node.glide = { from: { ...node.point }, progress: 0 };
        node.slot = next.slot;
        node.moving = next.moving;
        update(node, 0);
      }
      drawLinks();
    },
    /** Holds a node in place, such as while its card is open. */
    hold(id: string, held: boolean) {
      const node = nodes.get(id);
      if (node) node.held = held;
    },
    /** One frame: `dt` seconds passed. */
    frame(dt: number) {
      clock += dt;
      for (const node of nodes.values()) {
        if (node.held && node.moving) node.lag += dt;
        if (node.moving || node.glide) update(node, dt);
      }
      drawLinks();
    },
    /** Places every node again, such as after a resize while the loop does not run. */
    placeAll() {
      for (const node of nodes.values()) update(node, 0);
      drawLinks();
    },
    setLinks(next: OrbitLinkPath[]) {
      links = next;
      drawLinks();
    },
    /** Whether some node moves on each frame. Without one, the loop does not need to run. */
    moves() {
      for (const node of nodes.values()) if (node.moving || node.glide) return true;
      return false;
    },
    point(id: string): OrbitPoint | null {
      return nodes.get(id)?.point ?? null;
    },
  };
}
