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
 * The motion of the Team panel. Solid draws the structure once; this module owns the one
 * `requestAnimationFrame` loop of the panel. A frame writes the `transform` of the nodes that move,
 * a `z-index` only when it changes, and the path of a link only when one of its ends moved. It reads
 * no layout: the place of each system is read once, at the start of the first frame after a layout.
 * The loop runs only while a node orbits, drifts or glides, the window shows and motion is allowed.
 */

interface OrbitNode {
  id: string;
  systemKey: string;
  el: HTMLElement;
  trails: HTMLElement[];
  slot: OrbitSlot | null;
  /** The node is on an orbit or a drift and in the motion budget, so it moves on each frame. */
  moving: boolean;
  point: OrbitPoint;
  glide: { from: OrbitPoint; progress: number } | null;
  /** Seconds the node was held, so it goes on from where it stopped. */
  lag: number;
  held: boolean;
  phase: number;
  /** The last `transform` and `z-index` written, so a frame writes only what changed. */
  transform: string;
  z: string;
  trailZ: string[];
}

type OrbitSlots = Readonly<Record<string, { slot: OrbitSlot; moving: boolean }>>;

interface OrbitSystemState {
  el: HTMLElement;
  geometry: OrbitGeometry | null;
  /** The last slots, so a node that mounts after the layout finds its place. */
  slots: OrbitSlots;
  /** The place of the system in the container of the links, read after a layout. */
  offset: { x: number; y: number };
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
/** The longest step of the clock in one frame, so a slow frame does not make a node jump. */
const MAX_STEP_SECONDS = 0.05;

export type OrbitEngine = ReturnType<typeof createOrbitEngine>;

export function createOrbitEngine() {
  let clock = 0;
  /** Motion is allowed: the window shows and the person did not ask for reduced motion. */
  let running = false;
  let frame = 0;
  let last = 0;
  let offsetsChanged = true;
  const nodes = new Map<string, OrbitNode>();
  const systems = new Map<string, OrbitSystemState>();
  /** Trails that came before their node. */
  const waitingTrails = new Map<string, HTMLElement[]>();
  let links: (OrbitLinkPath & { d: string })[] = [];

  function place(node: OrbitNode, point: OrbitPoint) {
    node.point = point;
    const ring = node.slot?.kind === "orbit" || node.slot?.kind === "drift" || node.slot?.kind === "still";
    const scale = ring ? 0.86 + (0.16 * (point.depth + 1)) / 2 : 1;
    const transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    if (transform !== node.transform) {
      node.el.style.transform = transform;
      node.transform = transform;
    }
    const z = node.slot?.kind === "sun" ? "4" : point.depth < 0 ? "2" : "5";
    if (z !== node.z) {
      node.el.style.zIndex = z;
      node.z = z;
    }
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
      const z = point.depth < 0 ? "1" : "4";
      if (node.trailZ[index] !== z) {
        trail.style.zIndex = z;
        node.trailZ[index] = z;
      }
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

  /** Whether a node changes its place on the next frame. */
  function moves() {
    for (const node of nodes.values()) if ((node.moving && !node.held) || node.glide) return true;
    return false;
  }

  /** Reads the place of each system. Only a frame after a layout does it, before it writes. */
  function readOffsets() {
    for (const system of systems.values()) system.offset = { x: system.el.offsetLeft, y: system.el.offsetTop };
    offsetsChanged = false;
  }

  function linkPoint(id: string): { x: number; y: number } | null {
    const node = nodes.get(id);
    const system = node ? systems.get(node.systemKey) : undefined;
    if (!node || !system?.geometry) return null;
    return { x: node.point.x + system.offset.x, y: node.point.y + system.offset.y };
  }

  /** Writes the path of each link whose ends moved. */
  function drawLinks() {
    for (const link of links) {
      const from = linkPoint(link.from);
      const to = linkPoint(link.to);
      let d = "";
      if (from && to) {
        const same = nodes.get(link.from)?.systemKey === nodes.get(link.to)?.systemKey;
        const bend = Math.max(from.x, to.x) + 50;
        d = same
          ? `M${from.x.toFixed(1)} ${from.y.toFixed(1)} L${to.x.toFixed(1)} ${to.y.toFixed(1)}`
          : `M${from.x.toFixed(1)} ${from.y.toFixed(1)} Q${bend.toFixed(1)} ${((from.y + to.y) / 2).toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
      }
      if (d === link.d) continue;
      link.path.setAttribute("d", d);
      link.d = d;
    }
  }

  function tick(now: number) {
    frame = 0;
    const dt = running && last > 0 ? Math.min(MAX_STEP_SECONDS, (now - last) / 1000) : 0;
    last = now;
    if (offsetsChanged) readOffsets();
    if (dt > 0) {
      clock += dt;
      for (const node of nodes.values()) {
        if (node.held && node.moving) node.lag += dt;
        if ((node.moving && !node.held) || node.glide) update(node, dt);
      }
    }
    drawLinks();
    if (running && moves()) frame = requestAnimationFrame(tick);
    else last = 0;
  }

  /** Asks for one frame. The frame asks for the next one only while a node moves. */
  function wake() {
    if (frame === 0) frame = requestAnimationFrame(tick);
  }

  return {
    /**
     * Motion is allowed, or not: the window hides, or the person asks for reduced motion. Without
     * motion, the loop stops, a glide ends at once, and a node keeps its place.
     */
    setRunning(on: boolean) {
      if (running === on) return;
      running = on;
      if (!on) {
        for (const node of nodes.values()) {
          if (!node.glide) continue;
          node.glide = null;
          update(node, 0);
        }
      }
      last = 0;
      wake();
    },
    system(key: string, el: HTMLElement) {
      const previous = systems.get(key);
      systems.set(key, {
        el,
        geometry: previous?.geometry ?? null,
        slots: previous?.slots ?? {},
        offset: previous?.offset ?? { x: 0, y: 0 },
      });
      offsetsChanged = true;
      wake();
      return () => {
        if (systems.get(key)?.el !== el) return;
        systems.delete(key);
        offsetsChanged = true;
        wake();
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
        transform: "",
        z: "",
        trailZ: [],
      };
      nodes.set(id, node);
      waitingTrails.delete(id);
      update(node, 0);
      wake();
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
      node.trailZ = [];
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
        if (moved && running) node.glide = { from: { ...node.point }, progress: 0 };
        node.slot = next.slot;
        node.moving = next.moving;
        update(node, 0);
      }
      // The height of the system can change, and the systems under it move.
      offsetsChanged = true;
      wake();
    },
    /** Holds a node in place, such as while its card is open. */
    hold(id: string, held: boolean) {
      const node = nodes.get(id);
      if (!node || node.held === held) return;
      node.held = held;
      if (!held) wake();
    },
    setLinks(next: OrbitLinkPath[]) {
      links = next.map((link) => ({ ...link, d: link.path.getAttribute("d") ?? "" }));
      wake();
    },
    point(id: string): OrbitPoint | null {
      return nodes.get(id)?.point ?? null;
    },
    /** Stops the loop for good: the panel closes. */
    dispose() {
      running = false;
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
