import { AgentMark, avatarMarkAccent } from "@openbot/brand/agent-mark";
import { AGENT_MARK_ROLES } from "@openbot/brand/agent-mark-role";
import type { AvatarMood } from "@openbot/brand/bloub-avatar-motion";
import type { AvatarHue } from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { TeamPersonAvatar } from "@openbot/ui/features/team/TeamPersonAvatar";
import { createStore, For, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_AGENTS, STORY_PRESENCE } from "./fixtures";

const agentMeta = {
  title: "Identity/AgentAvatar",
  component: AgentAvatar,
  parameters: { layout: "centered" },
} satisfies Meta<typeof AgentAvatar>;

export default agentMeta;
type AgentStory = StoryObj<typeof agentMeta>;

export const Generated: AgentStory = {
  args: { agent: STORY_AGENTS[0], motion: "hover" },
};

export const Thinking: AgentStory = {
  args: { agent: STORY_AGENTS[1], motion: "always", class: "size-12" },
};

export const IndependentMotion: AgentStory = {
  render: () => {
    const [state, setState] = createStore({
      seeds: ["agent-alpha", "agent-beta", "agent-gamma", "agent-delta"],
      updates: 0,
      visible: true,
    });
    return (
      <div class="grid gap-6 p-8">
        <div class="flex gap-3">
          <Button
            onClick={() =>
              setState((draft) => {
                draft.seeds.reverse();
              })
            }
          >
            Reverse agents
          </Button>
          <Button
            onClick={() =>
              setState((draft) => {
                draft.updates += 1;
              })
            }
          >
            Update conversation
          </Button>
          <Button
            onClick={() =>
              setState((draft) => {
                draft.visible = !draft.visible;
              })
            }
          >
            {state.visible ? "Hide avatars" : "Show avatars"}
          </Button>
        </div>
        <p>Conversation updates: {state.updates}</p>
        <Show when={state.visible}>
          <For each={["idle", "always", "hover"] as const}>
            {(motion) => (
              <section class="grid gap-3" aria-label={`${motion} avatars`}>
                <strong>{motion}</strong>
                <div class="flex gap-5">
                  <For each={state.seeds}>
                    {(seed) => (
                      <Button variant="ghost" aria-label={`${motion} ${seed}`}>
                        <AgentAvatar seed={seed} motion={motion} class="size-12" hue={215} />
                        {seed}
                      </Button>
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
        </Show>
      </div>
    );
  },
};

export const CustomImageFallback: AgentStory = {
  args: { agent: { ...STORY_AGENTS[2], avatarUrl: "mock-avatar://missing" } },
};

const AVATAR_SIZES = [16, 18, 24, 32, 36, 42, 62] as const;
const AVATAR_MOODS = [
  "idle",
  "working",
  "live",
  "waiting",
  "failed",
  "responded",
  "connecting",
  "asleep",
] as const satisfies readonly AvatarMood[];

/**
 * One seed across every mood and every size.
 *
 * This is the story that proves the point of the mood table: reading down a column, the box is the
 * same in all eight rows and only the lid, the eyelids and the light change.
 */
export const SizesAndMoods: AgentStory = {
  render: () => {
    return (
      <div
        class="grid gap-6 p-8"
        style={{ background: "var(--openbot-bg-canvas)", color: "var(--openbot-text-primary)" }}
      >
        {AVATAR_MOODS.map((mood) => (
          <section class="grid gap-3" aria-label={`${mood} avatar sizes`}>
            <strong class="text-sm capitalize">{mood}</strong>
            <div class="flex items-end gap-5">
              {AVATAR_SIZES.map((size) => (
                <div class="grid justify-items-center gap-2">
                  <span class="agent-avatar agent-avatar-mark" style={{ width: `${size}px`, height: `${size}px` }}>
                    <AgentMark mood={mood} accent={avatarMarkAccent(215)} seed="story-avatar" />
                  </span>
                  <small style={{ color: "var(--openbot-text-muted)" }}>{size}</small>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  },
};

/** The live moods, with their rings and breathing, as the app actually renders them. */
export const Moods: AgentStory = {
  render: () => (
    <div class="flex items-center gap-8 p-8">
      {AVATAR_MOODS.map((mood) => (
        <div class="grid justify-items-center gap-3">
          <AgentAvatar seed="story-avatar" hue={215} mood={mood} motion="always" class="size-12" />
          <small style={{ color: "var(--openbot-text-muted)" }}>{mood}</small>
        </div>
      ))}
    </div>
  ),
};

/** The states of the orbit mark, as the sidebar shows them. `live` is `working` in the open chat. */
const ORBIT_MOODS = ["idle", "working", "live", "waiting", "failed"] as const satisfies readonly AvatarMood[];

/** Agents whose titles pick a role emblem, in English and Portuguese, and one with no role: it has no emblem. */
const ORBIT_AGENTS: ReadonlyArray<{ seed: string; hue: AvatarHue | null; title: string }> = [
  { seed: "story-research", hue: 185, title: "Pesquisadora de mercado" },
  { seed: "story-code", hue: 150, title: "Software engineer" },
  { seed: "story-finance", hue: 55, title: "Financeiro" },
  { seed: "story-support", hue: 0, title: "Customer support" },
  { seed: "story-design", hue: 245, title: "Product designer" },
  { seed: "story-personal", hue: null, title: "Assistente pessoal" },
  { seed: "story-chief", hue: 320, title: "Chief of staff" },
];

/** A stand-in for an uploaded picture. A photo cannot wear the mark, so only its frame shows the mood. */
const STORY_PHOTO =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23c9a27e'/%3E%3Ccircle cx='32' cy='26' r='12' fill='%23f3d9bd'/%3E%3Cpath d='M10 64c2-14 12-20 22-20s20 6 22 20z' fill='%23365f8c'/%3E%3C/svg%3E";

/**
 * `always` moves as a large view does. `idle` is a sidebar row at rest: the eyes of an idle agent stay
 * still until a pointer or the focus reaches the row, and a busy agent moves anyway.
 */
const ORBIT_SIZES = [
  { label: "96 px", style: { width: "96px", height: "96px" }, motion: "always" },
  { label: "36 px", style: { width: "36px", height: "36px" }, motion: "always" },
  { label: "36 px, a sidebar row at rest", style: { width: "36px", height: "36px" }, motion: "idle" },
] as const;

/**
 * Each state at the size of a large view and at the size of a sidebar row, for agents of several
 * roles and colours, and for a photo. Switch the colour scheme in the toolbar to see both themes.
 */
export const OrbitStates: AgentStory = {
  render: () => (
    <div
      class="grid gap-8 p-8"
      style={{ background: "var(--openbot-bg-canvas)", color: "var(--openbot-text-primary)" }}
    >
      {ORBIT_SIZES.map((size) => (
        <section class="grid gap-3" aria-label={`Orbit states at ${size.label}`}>
          <strong class="text-sm">{size.label}</strong>
          <div class="grid gap-4" style={{ "grid-template-columns": `6rem repeat(${ORBIT_AGENTS.length + 1}, auto)` }}>
            <span />
            {ORBIT_AGENTS.map((agent) => (
              <small class="text-center" style={{ color: "var(--openbot-text-muted)" }}>
                {agent.title}
              </small>
            ))}
            <small class="text-center" style={{ color: "var(--openbot-text-muted)" }}>
              Photo
            </small>
            {ORBIT_MOODS.map((mood) => (
              <>
                <strong class="self-center text-sm">{mood}</strong>
                {ORBIT_AGENTS.map((agent) => (
                  <span class="grid place-items-center">
                    <AgentAvatar
                      seed={agent.seed}
                      hue={agent.hue}
                      title={agent.title}
                      mood={mood}
                      motion={size.motion}
                      style={size.style}
                    />
                  </span>
                ))}
                <span class="grid place-items-center">
                  <AgentAvatar
                    seed="story-photo"
                    url={STORY_PHOTO}
                    mood={mood}
                    motion={size.motion}
                    style={size.style}
                  />
                </span>
              </>
            ))}
          </div>
        </section>
      ))}
    </div>
  ),
};

/** Every role emblem on the right face, at work, so each one moves. */
export const RoleSymbols: AgentStory = {
  render: () => (
    <div
      class="flex flex-wrap gap-6 p-8"
      style={{ background: "var(--openbot-bg-canvas)", color: "var(--openbot-text-primary)" }}
    >
      {AGENT_MARK_ROLES.map((role, index) => (
        <div class="grid justify-items-center gap-2">
          <span class="agent-avatar agent-avatar-mark" style={{ width: "96px", height: "96px" }}>
            <AgentMark
              mood="working"
              role={role}
              accent={avatarMarkAccent(([0, 30, 55, 150, 185, 215, 245, 320] as const)[index % 8] ?? 215)}
              seed={role}
            />
          </span>
          <small style={{ color: "var(--openbot-text-muted)" }}>{role}</small>
        </div>
      ))}
    </div>
  ),
};

export const PersonAvatars: AgentStory = {
  render: () => (
    <div class="flex items-center gap-4">
      {STORY_PRESENCE.members.slice(0, 3).map((member) => (
        <TeamPersonAvatar member={member} large />
      ))}
    </div>
  ),
};
