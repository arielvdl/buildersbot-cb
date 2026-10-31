import { AgentMark, type AgentMarkRole, avatarMarkAccent, avatarMarkRole } from "@openbot/brand/agent-mark";
import { type AvatarMood, avatarMoodIsBusy, avatarMoodPresentation } from "@openbot/brand/bloub-avatar-motion";
import type { AvatarHue } from "@openbot/contracts/ipc";
import { prefersReducedMotion } from "@openbot/ui/utils";
import { createEffect, createMemo, createSignal, onSettled, Show, untrack } from "solid-js";
import type { AvatarMotion, SupportedAvatarSilhouetteId } from "../../bloub-avatar";
import type { AgentProfile } from "../../data";
import { attachPointerGaze } from "./avatar-pointer-gaze";

// Motions that rest until pointer/focus arrives. The sidebar is not virtualized, so every row would
// otherwise run its laser; the light is a small animation but a long list of them is not free.
const STATIC_MOTIONS: ReadonlySet<AvatarMotion> = new Set(["hover", "idle"]);

// Hover group lookup: the first `[data-avatar-hover]`/control ancestor, since dialogs and
// scroll regions with `[tabindex]` are too wide to count as one.
const HOVER_GROUP = "[data-avatar-hover], button, a, [role='button'], [role='link'], [role='menuitem']";

interface AgentAvatarProps {
  agent?:
    | (Pick<AgentProfile, "avatarSeed" | "avatarHue" | "avatarUrl"> & Partial<Pick<AgentProfile, "title">>)
    | undefined;
  seed?: string | undefined;
  /** The agent's title. It picks the role symbol on the mark. The title of `agent` by default. */
  title?: string | undefined;
  hue?: AvatarHue | null;
  url?: string | null | undefined;
  motion?: AvatarMotion;
  /** What the agent is doing. It decides the symbol on the lid of the mark and how the mark moves. */
  mood?: AvatarMood;
  cycleOffset?: number;
  animationOffset?: number;
  /** The silhouette of the Bloub, kept for callers. The mark is always the box. */
  shape?: SupportedAvatarSilhouetteId;
  /**
   * The pupils turn toward the pointer. The avatar then moves without hover, so use it only where few
   * avatars show. A photo avatar and reduced motion ignore it.
   */
  followPointer?: boolean;
  class?: string;
  style?: Record<string, string>;
}

export function AgentAvatar(props: AgentAvatarProps) {
  const seed = () => props.seed ?? props.agent?.avatarSeed ?? "agent";
  const hue = () => (props.hue !== undefined ? props.hue : (props.agent?.avatarHue ?? null));
  const motion = () => props.motion ?? "hover";
  const url = () => (props.url !== undefined ? props.url : (props.agent?.avatarUrl ?? null));
  const title = () => props.title ?? props.agent?.title ?? "";
  const mood = (): AvatarMood => props.mood ?? "idle";
  const presentation = () => avatarMoodPresentation(mood());
  const [imageFailed, setImageFailed] = createSignal(false);
  createEffect(
    () => url(),
    () => {
      setImageFailed(false);
    },
  );
  const className = () => `agent-avatar agent-avatar-motion-${motion()} ${props.class ?? ""}`;
  const breathe = () => (presentation().breathe > 0 ? String(presentation().breathe) : undefined);
  const style = (): Record<string, string> => {
    const amount = breathe();
    return amount ? { ...props.style, "--agent-avatar-breathe": amount } : { ...props.style };
  };
  return (
    <Show
      when={url() && !imageFailed()}
      fallback={
        <GeneratedAvatar
          seed={seed()}
          hue={hue()}
          title={title()}
          motion={motion()}
          mood={mood()}
          followPointer={props.followPointer === true}
          class={className()}
          style={props.style}
        />
      }
    >
      <span
        class={`${className()} agent-avatar-custom`}
        style={style()}
        data-avatar="image"
        data-mood={mood()}
        data-breathe={breathe()}
        aria-hidden="true"
      >
        {/* A photo cannot wear the mark, so the light stays on the frame: a working agent glows at
            its edge instead of flying rings around it. */}
        <img src={url() ?? ""} alt="" draggable={false} onError={() => setImageFailed(true)} />
      </span>
    </Show>
  );
}

/**
 * The generated avatar is the agent mark. The mark moves on its own, so it does not take the
 * breathing of the photo avatar.
 */
function GeneratedAvatar(props: {
  seed: string;
  hue: AvatarHue | null;
  title: string;
  motion: AvatarMotion;
  mood: AvatarMood;
  followPointer: boolean;
  class: string;
  style?: Record<string, string> | undefined;
}) {
  let element: HTMLSpanElement | undefined;
  const [interacting, setInteracting] = createSignal(false);
  const [reducedMotion, setReducedMotion] = createSignal(prefersReducedMotion());
  const accent = createMemo(() => avatarMarkAccent(props.hue));
  const role = createMemo<AgentMarkRole | null>(() => avatarMarkRole(props.title));
  // A busy mood runs on its own; a resting one waits for the pointer or the focus, and the light
  // stops when neither is there.
  const animated = () =>
    !reducedMotion() &&
    (props.followPointer || avatarMoodIsBusy(props.mood) || !STATIC_MOTIONS.has(props.motion) || interacting());

  onSettled(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const syncReducedMotion = () => setReducedMotion(media?.matches ?? false);
    syncReducedMotion();
    media?.addEventListener?.("change", syncReducedMotion);

    // What must be hovered or focused for a resting avatar to light up: the control the avatar sits
    // in or beside, marked with `data-avatar-hover` when the avatar is only a neighbour of it.
    const group = element?.closest<HTMLElement>(`${HOVER_GROUP}, [tabindex]`);
    const interactionTarget = group?.matches(HOVER_GROUP) ? group : element;
    // `logo.css` turns the pupils only without reduced motion, so the gaze can stay attached.
    const releaseGaze = element && untrack(() => props.followPointer) ? attachPointerGaze(element) : undefined;
    const startInteraction = () => setInteracting(true);
    const stopInteraction = () => setInteracting(false);
    // Only keyboard focus starts the avatar. A click leaves the focus on the button it lands on, such as
    // the sidebar row of the open channel, and the window gives that button `focusin` again each time it
    // comes back to the front. No pointer is there to leave, so the avatar moved until the next click.
    const startFocusInteraction = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.matches(":focus-visible")) startInteraction();
    };
    const stopFocusInteraction = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !interactionTarget?.contains(event.relatedTarget)) {
        stopInteraction();
      }
    };
    interactionTarget?.addEventListener("pointerenter", startInteraction);
    interactionTarget?.addEventListener("pointerleave", stopInteraction);
    interactionTarget?.addEventListener("focusin", startFocusInteraction);
    interactionTarget?.addEventListener("focusout", stopFocusInteraction);

    return () => {
      media?.removeEventListener?.("change", syncReducedMotion);
      interactionTarget?.removeEventListener("pointerenter", startInteraction);
      interactionTarget?.removeEventListener("pointerleave", stopInteraction);
      interactionTarget?.removeEventListener("focusin", startFocusInteraction);
      interactionTarget?.removeEventListener("focusout", stopFocusInteraction);
      releaseGaze?.();
    };
  });

  return (
    <span
      ref={element}
      class={`${props.class} agent-avatar-mark`}
      style={props.style}
      data-avatar="generated"
      data-mood={props.mood}
      aria-hidden="true"
    >
      <AgentMark mood={props.mood} role={role()} accent={accent()} seed={props.seed} animated={animated()} />
    </span>
  );
}
