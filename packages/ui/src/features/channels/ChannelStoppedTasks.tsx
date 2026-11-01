import type { ChannelMember, ChannelTask } from "@openbot/contracts/ipc";
import { Button, buttonVariants } from "@openbot/ui";
import { For, Show } from "solid-js";
import { useText } from "../../text";
import { AgentPicker, type AgentPickerAgent } from "../agents/AgentPicker";

export function ChannelStoppedTasks(props: {
  tasks: Pick<ChannelTask, "id" | "ownerAgentId" | "error">[];
  members: Pick<ChannelMember, "agentId">[];
  name: (agentId: string | null) => string;
  /** The face, provider and model of a member, for the Reassign menu. Absent shows the names only. */
  agent?: ((agentId: string) => AgentPickerAgent | undefined) | undefined;
  onResume: (taskId: string, recipientAgentId: string | null) => Promise<boolean>;
}) {
  const { t, sourceText } = useText();
  /** The members that can take the task: every member but its owner. */
  const reassignTo = (ownerAgentId: string | null): AgentPickerAgent[] =>
    props.members
      .filter((member) => member.agentId !== ownerAgentId)
      .map((member) => ({ ...props.agent?.(member.agentId), id: member.agentId, name: props.name(member.agentId) }));
  return (
    <Show when={props.tasks.length}>
      <div class="channel-paused-tasks">
        <For each={props.tasks}>
          {(task) => (
            <section
              class="channel-paused-task"
              aria-label={t("channel.stoppedTask.label", { name: props.name(task.ownerAgentId) })}
            >
              <p class="channel-paused-task-reason">{task.error ? sourceText(task.error) : null}</p>
              <div class="channel-paused-task-actions">
                {/* `resume` keeps the owner, and the service stops the task again when the owner left
                    the channel, so only Reassign can start it. */}
                <Show when={!task.ownerAgentId || props.members.some((member) => member.agentId === task.ownerAgentId)}>
                  <Button size="xs" onClick={() => void props.onResume(task.id, null)}>
                    {t("common.continue")}
                  </Button>
                </Show>
                <AgentPicker
                  agents={reassignTo(task.ownerAgentId)}
                  label={t("channel.stoppedTask.reassignLabel", { name: props.name(task.ownerAgentId) })}
                  triggerLabel={t("channel.stoppedTask.reassignLabel", { name: props.name(task.ownerAgentId) })}
                  triggerClass={buttonVariants({ variant: "ghost", size: "xs" })}
                  onChoose={(agent) => void props.onResume(task.id, agent.id)}
                >
                  {t("channel.stoppedTask.reassign")}
                </AgentPicker>
              </div>
            </section>
          )}
        </For>
      </div>
    </Show>
  );
}
