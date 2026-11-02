import type { AppTextKey } from "@openbot/i18n";
import { Button } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For, Show } from "solid-js";
import { AgentAvatar } from "../agents/AgentAvatar";
import { FEED_STATE_LABEL, type FeedTeamMember, type FeedTeamState } from "./feed-view";

function teamStateLabel(state: FeedTeamState): AppTextKey {
  return state === "idle" ? "app.orbits.state.idle" : FEED_STATE_LABEL[state];
}

export interface FeedTeamListProps {
  members: ReadonlyArray<FeedTeamMember & { count: number }>;
  /** The agent whose runs the timeline shows alone, or null. */
  selected: string | null;
  onSelect: (key: string | null) => void;
}

/**
 * The Team beside the timeline, as a list on the page and not a dialog: each agent, what it does now,
 * and how many runs it has in the feed. Choosing an agent shows only its runs; choosing it again shows
 * every run.
 */
export function FeedTeamList(props: FeedTeamListProps) {
  const { t } = useText();
  const active = () => props.members.filter((member) => member.state !== "idle" && member.state !== "done").length;
  return (
    <aside class="feed-team" aria-labelledby="feed-team-title">
      <header class="feed-team-head">
        <h2 id="feed-team-title">{t("app.feed.team.title")}</h2>
        <span class="feed-team-active">
          {t("app.feed.team.active", { active: active(), total: props.members.length })}
        </span>
      </header>
      <p class="feed-team-hint">{t("app.feed.team.hint")}</p>
      <ul class="feed-team-list">
        <For each={props.members} keyed={(member) => member.key}>
          {(member) => (
            <li>
              <Button
                variant="unstyled"
                class="feed-team-member"
                data-state={member().state}
                aria-pressed={props.selected === member().key ? "true" : "false"}
                aria-label={t("app.feed.team.member", {
                  name: member().name || t("app.feed.unnamedAgent"),
                  state: t(teamStateLabel(member().state)),
                  count: member().count,
                })}
                onClick={() => props.onSelect(props.selected === member().key ? null : member().key)}
              >
                <AgentAvatar
                  seed={member().avatarSeed}
                  hue={member().avatarHue}
                  url={member().avatarUrl}
                  motion="still"
                  animated={false}
                  class="feed-avatar"
                />
                <span class="feed-team-text">
                  <span class="feed-team-name">{member().name || t("app.feed.unnamedAgent")}</span>
                  <span class="feed-team-state" data-state={member().state}>
                    <span class="feed-dot" aria-hidden="true" />
                    {t(teamStateLabel(member().state))}
                  </span>
                  <Show when={member().detail}>{(detail) => <span class="feed-team-detail">{detail()}</span>}</Show>
                </span>
                <Show when={member().count > 0}>
                  <span class="feed-count">{member().count}</span>
                </Show>
              </Button>
            </li>
          )}
        </For>
      </ul>
    </aside>
  );
}
