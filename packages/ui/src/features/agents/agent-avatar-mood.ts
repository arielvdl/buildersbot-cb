import { type AvatarMood, avatarMoodIsBusy } from "@openbot/brand/bloub-avatar-motion";
import type { AgentApproval, ChannelSummary, QueueSnapshot } from "@openbot/contracts/ipc";
import { isAgentWorking } from "@openbot/ui/features/sidebar/agent-working";
import type { AvatarMotion } from "../../bloub-avatar";

export interface AgentAvatarMoodsInput {
  agentIds: readonly string[];
  activeTurns: Record<string, string | null>;
  queues: Record<string, QueueSnapshot>;
  failedTurns: Record<string, string | undefined>;
  pendingPrompts: Record<string, unknown | undefined>;
  pendingApprovals: Record<string, AgentApproval | undefined>;
  recentReplies: Record<string, boolean>;
}

/**
 * The face each agent wears, from the signals that can claim one.
 *
 * Pure and outside every context, for the same reason `computeSidebarAgentStates` is: the inputs
 * come from agents, turns and conversation at once, so a context that read all three would have to
 * sit under all three. It is the sibling of that function and shares its working test, so a row's
 * badge and the face above it can never disagree.
 *
 * The precedence is the point. It runs from the state that needs a person soonest to the state
 * that needs one least: a failed turn has already stopped, so it outranks a question that is still
 * waiting to be asked, which outranks work that is running on its own, which outranks a reply
 * nobody has read yet. Reading it the other way round would hide a failure behind the running turn
 * that produced it.
 *
 * An agent with nothing to say gets no entry, so the result is sparse and a missing key means
 * `idle` rather than "unknown". `connecting` and `asleep` are not derived here: they belong to the
 * surface around the avatar rather than to the agent, so their callers pass them in.
 */
export function computeAgentAvatarMoods(input: AgentAvatarMoodsInput): Record<string, AvatarMood> {
  const moods: Record<string, AvatarMood> = {};
  for (const agentId of input.agentIds) {
    if (input.failedTurns[agentId]) moods[agentId] = "failed";
    else if (input.pendingApprovals[agentId] || input.pendingPrompts[agentId]) moods[agentId] = "waiting";
    else if (isAgentWorking(agentId, input.activeTurns, input.queues)) moods[agentId] = "working";
    else if (input.recentReplies[agentId]) moods[agentId] = "responded";
  }
  return moods;
}

/**
 * The mood of an avatar that shows an agent whose chat is open. A working agent in the open chat
 * is `live`: the person watches it work, so the avatar moves faster. All other moods do not change.
 */
export function avatarMoodInChat(mood: AvatarMood, chatOpen: boolean): AvatarMood {
  return chatOpen && mood === "working" ? "live" : mood;
}

/**
 * The members of a channel that work now, for the faces of the channel. A set names them. `true`
 * means that the channel works but does not say who, so every face works. `false`: nobody works.
 */
export type ChannelWorkingMembers = ReadonlySet<string> | boolean;

/**
 * The working members of a channel, from its summary. The summary only counts the running tasks, so
 * a member works when the channel runs a task and the member's own mood is `working`. When no
 * member's mood says so, for example while the lead routes the request, every member works.
 */
export function channelWorkingMembers(
  channel: Pick<ChannelSummary, "activeTasks" | "members">,
  agentMoods: Readonly<Record<string, AvatarMood>>,
): ChannelWorkingMembers {
  if (channel.activeTasks <= 0) return false;
  const ids = new Set(
    channel.members.filter((member) => agentMoods[member.agentId] === "working").map((member) => member.agentId),
  );
  return ids.size > 0 ? ids : true;
}

/** The mood of one face of a channel: `working` while the member works, and `live` in the open channel. */
export function channelMemberMood(
  agentId: string,
  working: ChannelWorkingMembers | undefined,
  channelOpen: boolean,
): AvatarMood {
  const works = working === true || (typeof working === "object" && working.has(agentId));
  return works ? avatarMoodInChat("working", channelOpen) : "idle";
}

/** At this width in pixels or less, a pointer or the focus does not wake a resting avatar. */
export const SMALL_AVATAR_SIZE = 28;

export interface AvatarAnimationInput {
  motion: AvatarMotion;
  mood: AvatarMood;
  /** The pupils follow the pointer, so the avatar moves all the time. */
  followPointer: boolean;
  /**
   * The width of the avatar when a pointer or the keyboard focus reached it, or `null` when neither
   * is on it now.
   */
  pointerOn: number | null;
  reducedMotion: boolean;
}

/**
 * Whether an avatar moves now. A busy mood moves on its own. A resting avatar moves for `always` and
 * `followPointer`, and for `hover` and `idle` only while a pointer or the focus is on it. A pointer
 * does not wake the faces of a group (`still`), nor an avatar of `SMALL_AVATAR_SIZE` or less: many
 * small faces that start their motion at once under the pointer cost the most and show the least.
 */
export function avatarAnimates(input: AvatarAnimationInput): boolean {
  if (input.reducedMotion) return false;
  if (avatarMoodIsBusy(input.mood) || input.followPointer || input.motion === "always") return true;
  if (input.motion === "still" || input.pointerOn === null) return false;
  return input.pointerOn > SMALL_AVATAR_SIZE;
}
