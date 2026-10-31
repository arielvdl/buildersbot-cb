/**
 * The notice at the bottom of the list while the activity filter or the routine filter is on: which
 * filter, how many chats it hides, and "Show all", which turns the filter off and lists every chat
 * again. It stays in view while the list scrolls. The compact sidebar shows only the button.
 */

import { Button, X } from "@openbot/ui";
import { Show } from "solid-js";
import { useText } from "../../text";
import { SIDEBAR_ACTIVITY_FILTER_LABELS, SIDEBAR_ROUTINE_FILTER_LABELS } from "./sidebar-filter-labels";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarActivityNotice() {
  const { activityHiddenCount, listFilter, props } = useSidebarScope();
  const { t } = useText();
  /** The notice text of the filter that is on, or null when the caller cannot turn it off. */
  const notice = () => {
    const routine = listFilter.routine();
    if (routine && props.onRoutineFilterChange) {
      return t("sidebar.activity.routine.notice", {
        filter: t(SIDEBAR_ROUTINE_FILTER_LABELS[routine]),
        count: activityHiddenCount(),
      });
    }
    const activity = listFilter.activity();
    if (activity && props.onActivityFilterChange) {
      return t("sidebar.activity.notice", {
        filter: t(SIDEBAR_ACTIVITY_FILTER_LABELS[activity]),
        count: activityHiddenCount(),
      });
    }
    return null;
  };
  const showAll = () => {
    if (listFilter.routine()) props.onRoutineFilterChange?.(null);
    else props.onActivityFilterChange?.(null);
  };
  return (
    <Show when={notice()}>
      {(text) => (
        <div class="sidebar-activity-notice">
          <span class="sidebar-activity-notice-text" role="status" aria-live="polite" aria-atomic="true">
            {text()}
          </span>
          <Button size="xs" variant="ghost" type="button" class="sidebar-activity-show-all" onClick={showAll}>
            <X class="sidebar-activity-show-all-icon" aria-hidden="true" />
            <span class="sidebar-activity-show-all-text">{t("sidebar.activity.showAll")}</span>
          </Button>
        </div>
      )}
    </Show>
  );
}
