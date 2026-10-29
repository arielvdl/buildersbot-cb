/**
 * The search field, the activity filter beside it, and the compact-mode button in the field's place.
 * The field and the compact button both open the global search; the filter narrows the list itself.
 */

import { Activity, Button, DropdownMenu } from "@openbot/ui";
import { Show } from "solid-js";
import { useText } from "../../text";
import { MenuCheck } from "../marketplace/MarketplaceParts";
import { SearchIcon } from "./SidebarIcons";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarSearch() {
  const { props } = useSidebarScope();
  const { t } = useText();
  const filter = () => props.activityFilter ?? null;
  const filterLabel = () => {
    const current = filter();
    if (current === "channels") return t("sidebar.activity.channels");
    if (current === "agents") return t("sidebar.activity.agents");
    return t("sidebar.activity.label");
  };
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
        <Show when={props.onActivityFilterChange}>
          {(change) => (
            <DropdownMenu.Root placement="bottom-end" gutter={4}>
              <DropdownMenu.Trigger
                class="sidebar-icon-button sidebar-activity-button no-drag"
                data-active={filter() ? "true" : undefined}
                aria-label={filterLabel()}
                aria-pressed={filter() ? "true" : "false"}
                title={filterLabel()}
              >
                <Activity aria-hidden="true" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="agent-context-menu" aria-label={t("sidebar.activity.label")}>
                  <DropdownMenu.CheckboxItem
                    closeOnSelect={false}
                    checked={filter() === "channels"}
                    onChange={(checked: boolean) => change()(checked ? "channels" : null)}
                  >
                    <MenuCheck on={filter() === "channels"} />
                    <span>{t("sidebar.activity.channels")}</span>
                  </DropdownMenu.CheckboxItem>
                  <DropdownMenu.CheckboxItem
                    closeOnSelect={false}
                    checked={filter() === "agents"}
                    onChange={(checked: boolean) => change()(checked ? "agents" : null)}
                  >
                    <MenuCheck on={filter() === "agents"} />
                    <span>{t("sidebar.activity.agents")}</span>
                  </DropdownMenu.CheckboxItem>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
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
