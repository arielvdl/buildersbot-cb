/**
 * The tab strip of one chat row: a bar at the bottom inside the row, and the tabs it opens.
 *
 * The user opens the tabs with a click on the avatar of the row or on the bar; the pointer over the
 * row opens nothing. The row lists at most `SIDEBAR_CHAT_TABS_LIMIT` tabs. The tab that was open keeps
 * a mark and `aria-current`, so the row never falls back to the first tab. The bar and the tabs sit
 * outside the row button, because a button cannot hold another one.
 */

import { For, Show } from "solid-js";
import { useText } from "../../text";
import { useSidebarScope } from "./sidebar-scope";
import { type SidebarChatItem, type SidebarChatTabs, sidebarChatTabsKey } from "./sidebar-types";
import { visibleSidebarChatTabs } from "./stores/tab-strip-store";

/** A click inside the avatar of a row, which is where the tabs of a chat open. */
export function clickIsOnAvatar(event: MouseEvent): boolean {
  return event.target instanceof Element && event.target.closest(".agent-row-avatar") !== null;
}

export function SidebarChatTabStrip(props: {
  chat: SidebarChatItem;
  tabs: SidebarChatTabs;
  onOpen: (tabId: string) => void;
}) {
  const { tabStrips } = useSidebarScope();
  const { t } = useText();
  const key = () => sidebarChatTabsKey(props.chat);
  const open = () => tabStrips.isOpen(key());
  const expanded = () => tabStrips.isExpanded(key());
  const listId = () => `sidebar-chat-tabs-${props.chat.kind}-${props.chat.id}`;
  const count = () => props.tabs.tabs.length;
  const barLabel = () => (expanded() ? t("sidebar.tabs.hide") : t("sidebar.tabs.show", { count: count() }));
  const unread = (value: number | undefined) => Math.min(value ?? 0, 99);

  return (
    <>
      <button
        type="button"
        class="sidebar-chat-tab-strip"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={listId()}
        aria-label={barLabel()}
        title={barLabel()}
        onClick={() => tabStrips.toggle(key())}
      >
        <span class="sidebar-chat-tab-strip-line" aria-hidden="true" />
      </button>
      <div id={listId()} class="sidebar-chat-tabs" data-open={open() ? "" : undefined}>
        <div class="sidebar-chat-tabs-inner" inert={open() ? undefined : true}>
          <ul class="sidebar-chat-tab-list">
            <For each={visibleSidebarChatTabs(props.tabs.tabs, props.tabs.activeId)}>
              {(tab) => (
                <li>
                  <button
                    type="button"
                    class="sidebar-chat-tab"
                    aria-current={props.tabs.activeId === tab.id ? "true" : undefined}
                    title={tab.title}
                    onClick={() => props.onOpen(tab.id)}
                  >
                    <span class="sidebar-chat-tab-mark" aria-hidden="true" />
                    <span class="sidebar-chat-tab-title">{tab.title}</span>
                    <Show when={(tab.unread ?? 0) > 0}>
                      <span class="sidebar-chat-tab-unread" aria-hidden="true">
                        {unread(tab.unread)}
                      </span>
                    </Show>
                    <Show when={tab.working || tab.queued}>
                      <span
                        class="sidebar-chat-tab-work"
                        data-queued={tab.queued && !tab.working ? "" : undefined}
                        aria-hidden="true"
                      />
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </div>
    </>
  );
}
