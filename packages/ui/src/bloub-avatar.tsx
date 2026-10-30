import { AgentMark, avatarMarkAccent, avatarMarkRole } from "@openbot/brand/agent-mark";
import type { AvatarHue } from "@openbot/contracts/ipc";
import { render } from "@solidjs/web";
import { flush } from "solid-js";

/**
 * When an avatar animates, which is a performance decision and not a state one: `hover` and `idle`
 * rest until a pointer or focus reaches them, `always` runs. What the avatar *expresses* is its
 * `AvatarMood` - see `@openbot/brand/bloub-avatar-motion`.
 */
export type AvatarMotion = "hover" | "always" | "idle";
export {
  AVATAR_HUE_CHOICES,
  AVATAR_HUE_OPTIONS,
  AVATAR_MARK_COLOR,
  AVATAR_MARK_EYE,
  AVATAR_MARK_SHAPE,
  avatarCandidateSeeds,
  avatarHeadColor,
  avatarHueSwatch,
  type BloubAvatarProfile,
  bloubAvatarProfile,
  type SupportedAvatarSilhouetteId,
} from "@openbot/brand/bloub-avatar";
export {
  type AvatarMood,
  avatarMoodIsBusy,
  avatarMoodPresentation,
  SHAPE_SAFE_STATES,
  type ShapeSafeStateId,
} from "@openbot/brand/bloub-avatar-motion";

/** The mark at rest, as a detached SVG. `title` picks the role symbol, as it does on `AgentAvatar`. */
export function createStaticAvatarSvg(seed: string, hue: AvatarHue | null, title?: string): SVGSVGElement {
  const host = document.createElement("span");
  const dispose = mountStaticAvatar(host, seed, hue, title);
  const svg = host.querySelector("svg");
  if (!svg) {
    dispose();
    throw new Error("The mark did not render an SVG avatar.");
  }
  const result = svg.cloneNode(true);
  if (!(result instanceof SVGSVGElement)) {
    dispose();
    throw new Error("The mark did not clone an SVG avatar.");
  }
  dispose();
  return result;
}

function mountStaticAvatar(host: HTMLElement, seed: string, hue: AvatarHue | null, title?: string): () => void {
  const dispose = render(
    () => <AgentMark role={avatarMarkRole(title)} accent={avatarMarkAccent(hue)} seed={seed} animated={false} />,
    host,
  );
  flush();
  const svg = host.querySelector("svg");
  if (!svg) {
    dispose();
    throw new Error("The mark did not render an SVG avatar.");
  }
  svg.setAttribute("width", "100");
  svg.setAttribute("height", "100");
  svg.setAttribute("focusable", "false");
  return dispose;
}
