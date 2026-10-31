/** The menu label of each list filter. The filter button and the notice under the list both show it. */

import type { AppTextKey } from "@openbot/i18n";
import type { SidebarActivityFilter, SidebarRoutineFilter } from "./sidebar-types";

export const SIDEBAR_ACTIVITY_FILTER_LABELS = {
  channels: "sidebar.activity.channels",
  agents: "sidebar.activity.agents",
  finished: "sidebar.activity.finished",
} as const satisfies Record<SidebarActivityFilter, AppTextKey>;

export const SIDEBAR_ROUTINE_FILTER_LABELS = {
  active: "sidebar.activity.routine.active",
  inactive: "sidebar.activity.routine.inactive",
  created: "sidebar.activity.routine.created",
  edited: "sidebar.activity.routine.edited",
} as const satisfies Record<SidebarRoutineFilter, AppTextKey>;
