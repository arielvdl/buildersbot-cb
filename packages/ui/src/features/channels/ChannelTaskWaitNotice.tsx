import type { ChannelTask } from "@openbot/contracts/ipc";
import { For, Show } from "solid-js";
import { useText } from "../../text";

/**
 * The queued requests of this tab that wait, one quiet line each with the reason
 * (`ChannelTask.wait`): the earlier request of the tab, the agent's place among its parallel tabs, a
 * computer low on memory, or the agent's own chat. A request with no reason shows nothing here.
 */
export function ChannelTaskWaitNotice(props: {
  tasks: Pick<ChannelTask, "id" | "ownerAgentId" | "wait">[];
  name: (agentId: string | null) => string;
}) {
  const { t } = useText();
  const line = (task: Pick<ChannelTask, "ownerAgentId" | "wait">) => {
    const wait = task.wait;
    const name = props.name(task.ownerAgentId);
    switch (wait?.reason) {
      case "tab":
        return t("channel.task.wait.tab", { name });
      case "agent-tabs":
        return t("channel.task.wait.agentTabs", { name, count: wait.busy ?? wait.limit ?? 1 });
      case "memory":
        return t("channel.task.wait.memory");
      case "agent-chat":
        return t("channel.task.wait.agentChat", { name });
      default:
        return "";
    }
  };
  return (
    <Show when={props.tasks.length}>
      <ul class="channel-task-waits">
        <For each={props.tasks}>
          {(task) => (
            <li class="channel-task-wait" role="status">
              {line(task)}
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
