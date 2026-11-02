import type { ChannelTask } from "@openbot/contracts/ipc";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { useText } from "../../text";

/**
 * The tasks whose start the app tries again (`ChannelTask.startRetry`), one quiet line each, in place
 * of the card of a stopped task: "Trying again (2/3), next in 30 s", "It continues where it stopped (1/3)"
 * after a short provider failure in the middle of a turn, or "Running on the backup model X".
 * The card shows only when the tries end.
 */
export function ChannelStartRetryNotice(props: {
  tasks: Pick<ChannelTask, "id" | "ownerAgentId" | "startRetry">[];
  name: (agentId: string | null) => string;
}) {
  const { t } = useText();
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const line = (task: Pick<ChannelTask, "ownerAgentId" | "startRetry">) => {
    const retry = task.startRetry;
    if (!retry) return "";
    if (retry.phase === "fallback" && retry.attempt === 0)
      return t("channel.task.onBackup", { name: props.name(task.ownerAgentId), model: retry.fallbackModel ?? "" });
    const next = retry.nextAt === null ? 0 : Math.max(0, Math.ceil((Date.parse(retry.nextAt) - now()) / 1000));
    return t(retry.phase === "resuming" ? "channel.task.resuming" : "channel.task.retrying", {
      name: props.name(task.ownerAgentId),
      attempt: retry.attempt,
      max: retry.max,
      seconds: next,
    });
  };
  return (
    <Show when={props.tasks.length}>
      <ul class="channel-start-retries">
        <For each={props.tasks}>
          {(task) => (
            <li class="channel-start-retry" role="status">
              {line(task)}
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
