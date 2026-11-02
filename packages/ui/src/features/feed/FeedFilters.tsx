import type { AppTextKey } from "@openbot/i18n";
import { Button, Input, NativeSelect, Search } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For } from "solid-js";
import {
  FEED_GROUPS,
  FEED_STATE_LABEL,
  FEED_STATE_ORDER,
  type FeedFilterState,
  type FeedGroupBy,
  type FeedOption,
  type FeedStateFilter,
} from "./feed-view";

const GROUP_LABEL = {
  time: "app.feed.group.time",
  project: "app.feed.group.project",
  agent: "app.feed.group.agent",
} as const satisfies Record<FeedGroupBy, AppTextKey>;

export interface FeedFiltersProps {
  filters: FeedFilterState;
  projects: readonly FeedOption[];
  agents: readonly FeedOption[];
  shown: number;
  total: number;
  onChange: (change: Partial<FeedFilterState>) => void;
  searchRef: (element: HTMLInputElement) => void;
}

function isStateFilter(value: string): value is FeedStateFilter {
  return value === "all" || FEED_STATE_ORDER.some((state) => state === value);
}

/** Search, project, agent and state, and how the timeline groups its cards. */
export function FeedFilters(props: FeedFiltersProps) {
  const { t } = useText();
  return (
    <div class="feed-filters">
      <label class="feed-search">
        <Search aria-hidden="true" />
        <Input
          ref={props.searchRef}
          type="search"
          size="sm"
          value={props.filters.query}
          placeholder={t("app.feed.search")}
          aria-label={t("app.feed.search")}
          onInput={(event) => props.onChange({ query: event.currentTarget.value })}
        />
      </label>
      <NativeSelect
        size="sm"
        class="feed-select"
        aria-label={t("app.feed.filter.project")}
        value={props.filters.project ?? ""}
        onChange={(event) => props.onChange({ project: event.currentTarget.value || null })}
      >
        <option value="">{t("app.feed.filter.allProjects")}</option>
        <For each={props.projects} keyed={(option) => option.key}>
          {(option) => (
            <option
              value={option().key}
            >{`${option().label ?? t("app.feed.filter.noProject")} (${option().count})`}</option>
          )}
        </For>
      </NativeSelect>
      <NativeSelect
        size="sm"
        class="feed-select"
        aria-label={t("app.feed.filter.agent")}
        value={props.filters.agent ?? ""}
        onChange={(event) => props.onChange({ agent: event.currentTarget.value || null })}
      >
        <option value="">{t("app.feed.filter.allAgents")}</option>
        <For each={props.agents} keyed={(option) => option.key}>
          {(option) => (
            <option
              value={option().key}
            >{`${option().label ?? t("app.feed.unnamedAgent")} (${option().count})`}</option>
          )}
        </For>
      </NativeSelect>
      <NativeSelect
        size="sm"
        class="feed-select"
        aria-label={t("app.feed.filter.state")}
        value={props.filters.state}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (isStateFilter(value)) props.onChange({ state: value });
        }}
      >
        <option value="all">{t("app.feed.filter.allStates")}</option>
        <For each={FEED_STATE_ORDER} keyed={(state) => state}>
          {(state) => <option value={state()}>{t(FEED_STATE_LABEL[state()])}</option>}
        </For>
      </NativeSelect>
      <fieldset class="feed-group-choice" aria-label={t("app.feed.group.label")}>
        <For each={FEED_GROUPS} keyed={(group) => group}>
          {(group) => (
            <Button
              variant="unstyled"
              class="feed-group-button"
              aria-pressed={props.filters.group === group() ? "true" : "false"}
              onClick={() => props.onChange({ group: group() })}
            >
              {t(GROUP_LABEL[group()])}
            </Button>
          )}
        </For>
      </fieldset>
      <span class="feed-showing" aria-live="off">
        {t("app.feed.showing", { shown: props.shown, total: props.total })}
      </span>
      <Button
        variant="ghost"
        size="xs"
        class="feed-clear"
        hidden={!props.filters.query && !props.filters.project && !props.filters.agent && props.filters.state === "all"}
        onClick={() => props.onChange({ query: "", project: null, agent: null, state: "all" })}
      >
        {t("app.feed.filter.clear")}
      </Button>
    </div>
  );
}
