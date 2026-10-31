/**
 * One section - the unassigned one included. A custom section stays visible while empty so it can
 * be dropped into.
 *
 * The unassigned section keeps its heading only once a custom section exists. Before that it is the
 * whole list, and "Unassigned" names it against nothing.
 */

import { SIDEBAR_UNASSIGNED_SECTION_ID, type SidebarMarker } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { useText } from "../../text";
import { SidebarAgentRow } from "./SidebarAgentRow";
import { SidebarChannelRow } from "./SidebarChannelRow";
import { SidebarMarkerRow } from "./SidebarMarkerRow";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { sidebarSectionColorStyle } from "./section-color";
import { sidebarMarkerOfChats } from "./sidebar-markers-view";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarAgentSection(sectionProps: { sectionId: string }) {
  const { customSectionById, dragOffset, filteredChatsBySection, props, sectionDragClasses, sectionIsCollapsed } =
    useSidebarScope();
  const { t } = useText();
  const sectionId = () => sectionProps.sectionId;
  const chats = () => filteredChatsBySection().get(sectionId()) ?? [];
  const custom = () => customSectionById().get(sectionId());
  const name = () =>
    sectionId() === SIDEBAR_UNASSIGNED_SECTION_ID ? t("sidebar.section.unassigned") : (custom()?.name ?? "");
  const headed = () => Boolean(custom()) || props.layout.sections.length > 0;
  const collapsed = () => headed() && sectionIsCollapsed(sectionId());
  // Empty when the section has no color: then the box has no new attribute and no new property.
  const colorStyle = () => sidebarSectionColorStyle(custom()?.color);
  /** The marker that styles each row: the nearest marker above it in this section. */
  const markerOf = createMemo(() => sidebarMarkerOfChats(chats()));
  return (
    <Show when={name() && (chats().length > 0 || custom())}>
      <section
        class={["sidebar-chat-group sidebar-section", sectionDragClasses(sectionId())]}
        style={`--sidebar-drag-y: ${dragOffset(sectionId()).y}px;${colorStyle()}`}
        aria-label={name()}
        data-section-id={sectionId()}
        data-section-color={colorStyle() ? "" : undefined}
      >
        <Show when={headed()}>
          <SidebarSectionHeader sectionId={sectionId()} name={name()} />
        </Show>
        <div
          class="sidebar-section-collapse"
          data-collapsed={collapsed() ? "" : undefined}
          aria-hidden={collapsed() ? "true" : undefined}
          inert={collapsed() ? true : undefined}
        >
          <div id={`sidebar-section-body-${sectionId()}`} class="sidebar-section-body">
            <For each={chats()}>
              {(chat) => (
                <Switch>
                  <Match when={chat.kind === "marker" ? chat.marker : undefined}>
                    {(marker) => <SidebarMarkerRow marker={marker()} />}
                  </Match>
                  <Match when={chat.kind === "agent" ? chat.agent : undefined}>
                    {(agent) => (
                      <MarkedRow marker={markerOf().get(chat.id)}>
                        <SidebarAgentRow agent={agent()} />
                      </MarkedRow>
                    )}
                  </Match>
                  <Match when={chat.kind === "channel" ? chat.channel : undefined}>
                    {(channel) => (
                      <MarkedRow marker={markerOf().get(chat.id)}>
                        <SidebarChannelRow channel={channel()} />
                      </MarkedRow>
                    )}
                  </Match>
                </Switch>
              )}
            </For>
          </div>
        </div>
      </section>
    </Show>
  );
}

/**
 * A row below a marker with a style. The wrapper draws no box (`display: contents`), so the row keeps its
 * place in the list; the stylesheet reads the style from it. A row with no marker, or under a marker of
 * the normal style, has no wrapper.
 */
function MarkedRow(rowProps: { marker: SidebarMarker | undefined; children: JSX.Element }) {
  return (
    <Show when={rowProps.marker?.style !== "normal" ? rowProps.marker : undefined} fallback={rowProps.children}>
      {(marker) => (
        <div
          class="sidebar-marked-row"
          data-marker-style={marker().style}
          style={marker().color ? `--sidebar-marker-color: ${marker().color};` : undefined}
        >
          {rowProps.children}
        </div>
      )}
    </Show>
  );
}
