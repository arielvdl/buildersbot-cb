/**
 * The search field, the activity filter beside it, and the compact-mode button in the field's place.
 * The field and the compact button both open the global search; the filter narrows the list itself.
 * The filters of the menu exclude each other. A dot on the button shows that one is on. The Routines
 * view shows the routine filters in place of the activity filters (`sidebarActivityMenu`).
 */

import { Activity, Button, DropdownMenu } from "@openbot/ui";
import { For, Show } from "solid-js";
import { useText } from "../../text";
import { MenuCheck } from "../marketplace/MarketplaceParts";
import { SearchIcon } from "./SidebarIcons";
import { SIDEBAR_ACTIVITY_FILTER_LABELS, SIDEBAR_ROUTINE_FILTER_LABELS } from "./sidebar-filter-labels";
import { SIDEBAR_ROUTINE_FILTERS } from "./sidebar-routine-filter";
import { useSidebarScope } from "./sidebar-scope";
import type { SidebarActivityFilter } from "./sidebar-types";

const SIDEBAR_ACTIVITY_FILTERS = ["channels", "agents", "finished"] as const satisfies readonly SidebarActivityFilter[];

/** The checkable items of one filter menu. The items exclude each other: a second click turns one off. */
function FilterMenuItems<T extends string>(props: {
  filters: readonly T[];
  label: (filter: T) => string;
  current: T | null;
  onChange: (filter: T | null) => void;
}) {
  return (
    <For each={props.filters}>
      {(filter) => (
        <DropdownMenu.CheckboxItem
          closeOnSelect={false}
          checked={props.current === filter}
          onChange={(checked: boolean) => props.onChange(checked ? filter : null)}
        >
          <MenuCheck on={props.current === filter} />
          <span>{props.label(filter)}</span>
        </DropdownMenu.CheckboxItem>
      )}
    </For>
  );
}

export function SidebarSearch() {
  const { listFilter, props } = useSidebarScope();
  const { t } = useText();
  const routineMenu = () => listFilter.menu() === "routines";
  const filterLabel = () => {
    const routine = listFilter.routine();
    if (routine) return t(SIDEBAR_ROUTINE_FILTER_LABELS[routine]);
    const activity = listFilter.activity();
    if (activity) return t(SIDEBAR_ACTIVITY_FILTER_LABELS[activity]);
    return routineMenu() ? t("sidebar.activity.routine.label") : t("sidebar.activity.label");
  };
  const filterAvailable = () => (routineMenu() ? props.onRoutineFilterChange : props.onActivityFilterChange);
  return (
    <div class="sidebar-search-wrap">
      <div class="sidebar-search-row">
        <Button
          variant="ghost"
          type="button"
          class="search-field sidebar-search-trigger"
          aria-label={t("conversation.globalSearch.title")}
          aria-haspopup="dialog"
          aria-hidden={props.compact ? "true" : undefined}
          tabindex={props.compact ? -1 : 0}
          onClick={props.onOpenSearch}
        >
          <SearchIcon />
          <span class="sidebar-search-placeholder">{t("common.search")}</span>
        </Button>
        <Show when={filterAvailable()}>
          <DropdownMenu.Root placement="bottom-end" gutter={4}>
            <DropdownMenu.Trigger
              class="sidebar-icon-button sidebar-activity-button no-drag"
              data-active={listFilter.on() ? "true" : undefined}
              aria-label={filterLabel()}
              aria-pressed={listFilter.on() ? "true" : "false"}
              title={filterLabel()}
            >
              <Activity aria-hidden="true" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                class="agent-context-menu"
                aria-label={routineMenu() ? t("sidebar.activity.routine.label") : t("sidebar.activity.label")}
              >
                <Show
                  when={routineMenu()}
                  fallback={
                    <FilterMenuItems
                      filters={SIDEBAR_ACTIVITY_FILTERS}
                      label={(filter) => t(SIDEBAR_ACTIVITY_FILTER_LABELS[filter])}
                      current={listFilter.activity()}
                      onChange={(filter) => props.onActivityFilterChange?.(filter)}
                    />
                  }
                >
                  <FilterMenuItems
                    filters={SIDEBAR_ROUTINE_FILTERS}
                    label={(filter) => t(SIDEBAR_ROUTINE_FILTER_LABELS[filter])}
                    current={listFilter.routine()}
                    onChange={(filter) => props.onRoutineFilterChange?.(filter)}
                  />
                </Show>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </Show>
      </div>
      <Button
        variant="ghost"
        type="button"
        class="sidebar-compact-search"
        aria-label={t("conversation.globalSearch.title")}
        aria-haspopup="dialog"
        aria-hidden={props.compact ? undefined : "true"}
        tabindex={props.compact ? 0 : -1}
        onClick={props.onOpenSearch}
      >
        <SearchIcon />
      </Button>
    </div>
  );
}
