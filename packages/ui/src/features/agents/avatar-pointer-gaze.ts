/**
 * The pupils of an agent mark turn toward the pointer. `AgentAvatar` uses it for `followPointer`,
 * where few avatars show, such as the first run screen.
 *
 * One pointer listener serves all following avatars, and one animation frame aims them all: it
 * measures every avatar first and then writes, so a move costs one layout and not one per avatar.
 * The avatar gets `data-agent-mark-gaze` and the offset of the pupils in `--agent-mark-gaze-x` and
 * `--agent-mark-gaze-y`, in the units of the eye. `logo.css` stops the look around while it is set.
 */

const GAZE_ATTRIBUTE = "data-agent-mark-gaze";
const GAZE_X = "--agent-mark-gaze-x";
const GAZE_Y = "--agent-mark-gaze-y";
// How far the pupils go: the reach of the look around (`agent-mark-look`), so they stay in the eye.
const PUPIL_REACH_X = 4;
const PUPIL_REACH_Y = 3.5;
// How far the pointer can go from an avatar before the pupils stop turning. A distance in pixels, so
// that agents next to each other look at the pointer from their own place.
const REACH = 320;
// The eyes lie on the left face of the box. One step along the face goes right and this much down.
const FACE_SLANT = 0.5774;

const followers = new Set<HTMLElement>();
let pointer: { x: number; y: number } | null = null;
let frame = 0;

function trackPointer(event: PointerEvent): void {
  if (event.pointerType === "touch") return;
  pointer = { x: event.clientX, y: event.clientY };
  scheduleAim();
}

function forgetPointer(event: PointerEvent): void {
  // Leaving the window is the only `pointerout` without a next target.
  if (event.relatedTarget !== null) return;
  pointer = null;
  scheduleAim();
}

function scheduleAim(): void {
  if (frame === 0) frame = requestAnimationFrame(aimAll);
}

function aimAll(): void {
  frame = 0;
  const at = pointer;
  if (at === null) {
    for (const element of followers) rest(element);
    return;
  }
  const aims = [...followers].map((element) => {
    const box = element.getBoundingClientRect();
    if (box.width === 0) return { element, offset: null };
    const dx = at.x - (box.left + box.width / 2);
    const dy = at.y - (box.top + box.height / 2);
    const along = clampUnit(dx / REACH);
    const down = clampUnit((dy - FACE_SLANT * dx) / REACH);
    return { element, offset: { x: round(along * PUPIL_REACH_X), y: round(down * PUPIL_REACH_Y) } };
  });
  for (const { element, offset } of aims) {
    if (offset === null) {
      rest(element);
      continue;
    }
    element.setAttribute(GAZE_ATTRIBUTE, "");
    element.style.setProperty(GAZE_X, String(offset.x));
    element.style.setProperty(GAZE_Y, String(offset.y));
  }
}

function rest(element: HTMLElement): void {
  element.removeAttribute(GAZE_ATTRIBUTE);
  element.style.removeProperty(GAZE_X);
  element.style.removeProperty(GAZE_Y);
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The pupils of the mark in `element` follow the pointer. Returns the release. */
export function attachPointerGaze(element: HTMLElement): () => void {
  if (followers.size === 0) {
    window.addEventListener("pointermove", trackPointer, { passive: true });
    document.addEventListener("pointerout", forgetPointer, { passive: true });
  }
  followers.add(element);
  scheduleAim();
  return () => {
    followers.delete(element);
    rest(element);
    if (followers.size > 0) return;
    window.removeEventListener("pointermove", trackPointer);
    document.removeEventListener("pointerout", forgetPointer);
    cancelAnimationFrame(frame);
    frame = 0;
    pointer = null;
  };
}
