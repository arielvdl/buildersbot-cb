import { type AgentEvent, type ClientAgentSummary, soundEventPreference } from "@openbot/contracts/ipc";
import { TASK_SOUND_CHOICES, type TaskSoundChoice } from "@openbot/ui/features/settings/app-settings";
import { playSound, previewSound, saveSoundPreference, soundCenterState, unlockSounds } from "./sound-center";

/** The events of finished work: the task sound of the versions before the sound center. */
const FINISHED_WORK = ["agent.reply-finished", "agent.work-finished", "routine.finished"] as const;

type NotificationAgent = Pick<ClientAgentSummary, "id" | "notifications" | "threadId" | "name">;

/** The task sound menu of the web client: the sound of a finished reply in the sound center. */
export function readTaskSound(): TaskSoundChoice {
  const reply = soundEventPreference(soundCenterState().preference, "agent.reply-finished");
  if (!reply.enabled || reply.sound === "none") return "off";
  return TASK_SOUND_CHOICES.find((choice) => choice === reply.sound) ?? "classic";
}

/** Sets the sound of all finished work, as the one task sound of the versions before did. */
export function setTaskSound(choice: TaskSoundChoice): void {
  const { preference } = soundCenterState();
  const events = { ...preference.events };
  for (const id of FINISHED_WORK) {
    const current = soundEventPreference(preference, id);
    events[id] = choice === "off" ? { ...current, enabled: false } : { ...current, enabled: true, sound: choice };
  }
  void saveSoundPreference({ ...preference, events }).catch(() => undefined);
}

/** Plays a task sound from a sound menu, without saving it. */
export function playSoundChoice(choice: TaskSoundChoice): void {
  if (choice === "off") return;
  void previewSound("agent.reply-finished", { enabled: true, sound: choice, volume: 100, customSoundId: null }).catch(
    () => undefined,
  );
}

/**
 * The sound event of a finished turn, or null when it plays nothing. A quiet routine run posted
 * nothing, and a turn that continues its plan is not the end of the request. A routine run, a turn
 * that a teammate started, and a turn in a channel or task thread are background work, so the person
 * can keep them quiet and still hear the replies to their own messages.
 */
export function completionSoundEvent(
  event: AgentEvent,
  agents: NotificationAgent[],
): (typeof FINISHED_WORK)[number] | null {
  if (event.type !== "turn-completed" || event.status !== "completed" || event.quiet || event.continues) return null;
  const agent = agents.find((candidate) => candidate.id === event.agentId && candidate.notifications);
  if (!agent) return null;
  if (event.origin === "routine") return "routine.finished";
  if (event.origin === "agent" || (agent.threadId !== null && event.threadId !== agent.threadId))
    return "agent.work-finished";
  return "agent.reply-finished";
}

export function playCompletionSoundForAgentEvent(event: AgentEvent, agents: NotificationAgent[]): void {
  const id = completionSoundEvent(event, agents);
  if (!id || event.type !== "turn-completed") return;
  playSound(id, { who: agents.find((agent) => agent.id === event.agentId)?.name ?? null });
}

/** Starts the audio from a user action. Safari starts it only from one. */
export function unlockCompletionSound(): void {
  unlockSounds();
}
