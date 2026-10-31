/**
 * What the list shows with nothing in it. A brand new profile offers `props.emptyAction` - the first
 * agent, rendered as a pressed row so the sidebar is never a blank column. A roster still on its way
 * from a joined server says that it connects.
 */

import { Button } from "@openbot/ui";
import { Show } from "solid-js";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarEmptyState() {
  const { listFilter, props } = useSidebarScope();
  const { t } = useText();
  const emptyLabel = () => {
    if (props.agentsConnecting) return t("common.connecting");
    if (listFilter.routine()) {
      return props.agentRoutinesLoading ? t("common.loading") : t("sidebar.activity.routine.empty");
    }
    const activity = listFilter.activity();
    if (activity === "finished") return t("sidebar.activity.finishedEmpty");
    // The notice under the list names the filter and turns it off.
    if (activity) return t("sidebar.activity.empty");
    return t("sidebar.empty.noAgents");
  };
  return (
    <Show when={props.emptyAction} fallback={<p class="empty-search">{emptyLabel()}</p>}>
      {(action) => (
        <div class={props.layout.sections.length === 0 ? "sidebar-first-agent-state" : undefined}>
          <Button
            variant="ghost"
            type="button"
            class="agent-row agent-row-active sidebar-first-agent-action"
            aria-label={action().label}
            aria-pressed="true"
            data-avatar-seed={action().avatarSeed}
            data-avatar-hue={action().avatarHue ?? "automatic"}
            onClick={action().onSelect}
          >
            <span class="agent-row-avatar">
              <AgentAvatar seed={action().avatarSeed} hue={action().avatarHue} motion="hover" />
            </span>
            <span class="agent-row-copy">
              <span class="agent-row-heading">
                <span class="agent-row-title">
                  <strong>{action().label}</strong>
                </span>
              </span>
            </span>
          </Button>
        </div>
      )}
    </Show>
  );
}
