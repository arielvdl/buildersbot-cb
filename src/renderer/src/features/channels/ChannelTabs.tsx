import type { ChannelTopic } from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, For, Show } from "solid-js";
import { useChannels } from "./channels-context";

/**
 * The tabs of an open channel: one conversation each, under the same memory, members and lead.
 *
 * The tabs live beside the transcript rather than in the sidebar, because they belong to the
 * channel that is open. A double click renames one; the cross closes it with its work.
 */
export function ChannelTabs(props: { channelId: string; archived: boolean }) {
  const channels = useChannels();
  const { t } = useText();
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const topics = () => channels.state.channels.find((channel) => channel.id === props.channelId)?.topics ?? [];

  async function add(): Promise<void> {
    // The name follows the position, so two new tabs are told apart before either is renamed.
    await channels.createTopic(t("channel.topic.defaultName", { n: topics().length + 1 }));
  }

  return (
    <Show when={topics().length > 0}>
      <div class="channel-tabs" role="tablist" aria-label={t("channel.topic.name")}>
        <For each={topics()}>
          {(topic) => (
            <span class="channel-tab" data-active={channels.state.topicId === topic.id ? "" : undefined}>
              <Show
                when={renaming() === topic.id}
                fallback={
                  <button
                    type="button"
                    role="tab"
                    class="channel-tab-name"
                    aria-selected={channels.state.topicId === topic.id ? "true" : "false"}
                    onClick={() => void channels.setTopic(topic.id)}
                    onDblClick={() => void setRenaming(topic.id)}
                  >
                    {topic.name}
                  </button>
                }
              >
                <input
                  class="channel-tab-input"
                  value={topic.name}
                  aria-label={t("channel.topic.rename")}
                  autofocus
                  onBlur={(event) => {
                    void setRenaming(null);
                    const name = event.currentTarget.value.trim();
                    if (name && name !== topic.name) void channels.renameTopic(topic.id, name);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") void setRenaming(null);
                  }}
                />
              </Show>
              <Show when={topics().length > 1 && !props.archived}>
                <button
                  type="button"
                  class="channel-tab-close"
                  aria-label={t("channel.topic.delete")}
                  onClick={() => void channels.deleteTopic(topic.id)}
                >
                  ×
                </button>
              </Show>
            </span>
          )}
        </For>
        <Show when={!props.archived}>
          <Button variant="ghost" size="sm" class="channel-tab-add" aria-label={t("channel.topic.new")} onClick={add}>
            +
          </Button>
        </Show>
      </div>
    </Show>
  );
}

/** The tabs of a channel, for a caller that only has its id. */
export function ChannelTabsFor(props: { channelId: string }) {
  const channels = useChannels();
  const archived = () => channels.state.channels.find((channel) => channel.id === props.channelId)?.archived ?? false;
  return <ChannelTabs channelId={props.channelId} archived={archived()} />;
}

export type { ChannelTopic };
