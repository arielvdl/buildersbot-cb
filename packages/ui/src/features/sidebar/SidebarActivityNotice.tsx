/**
 * The notice at the bottom of the list while the activity filter is on: which filter, how many chats
 * it hides, and "Show all", which turns the filter off and lists every chat again. It stays in view
 * while the list scrolls. The compact sidebar shows only the button.
 */

import type { AppTextKey } from "@openbot/i18n";
import { Button, X } from "@openbot/ui";
import { Show } from "solid-js";
import { useText } from "../../text";
import { useSidebarScope } from "./sidebar-scope";
import type { SidebarActivityFilter } from "./sidebar-types";

const SIDEBAR_ACTIVITY_FILTER_LABELS = {
  channels: "sidebar.activity.channels",
  agents: "sidebar.activity.agents",
  finished: "sidebar.activity.finished",
} as const satisfies Record<SidebarActivityFilter, AppTextKey>;

export function SidebarActivityNotice() {
  const { activityHiddenCount, props } = useSidebarScope();
  const { t } = useText();
  const filter = () => props.activityFilter ?? null;
  return (
    <Show when={props.onActivityFilterChange ? filter() : null}>
      {(current) => (
        <div class="sidebar-activity-notice">
          <span class="sidebar-activity-notice-text" role="status" aria-live="polite" aria-atomic="true">
            {t("sidebar.activity.notice", {
              filter: t(SIDEBAR_ACTIVITY_FILTER_LABELS[current()]),
              count: activityHiddenCount(),
            })}
          </span>
          <Button
            size="xs"
            variant="ghost"
            type="button"
            class="sidebar-activity-show-all"
            onClick={() => props.onActivityFilterChange?.(null)}
          >
            <X class="sidebar-activity-show-all-icon" aria-hidden="true" />
            <span class="sidebar-activity-show-all-text">{t("sidebar.activity.showAll")}</span>
          </Button>
        </div>
      )}
    </Show>
  );
}
