/**
 * The section rail: the narrow column at the left of the list, in the place of the server rail.
 * "All" lists every section; a section lists only its chats. Each item shows the section mark and one
 * badge for what asks for the user there: a wait, unread messages, or work in flight. The plus button
 * opens the new section field of the list.
 *
 * The rail uses the server rail classes, so the frame gives it the same column on desktop and on the
 * web, and hides it in the same places.
 */

import { SIDEBAR_UNASSIGNED_SECTION_ID } from "@openbot/contracts/ipc";
import {
  Button,
  buttonVariants,
  ContextMenu,
  Inbox,
  LayoutGrid,
  MotionTooltip,
  Pencil,
  Plus,
  Shapes,
  Trash2,
} from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { createScrollFades } from "../../components/createScrollFades";
import { useText } from "../../text";
import { SidebarSectionMark } from "./SidebarSectionMark";
import { sidebarSectionColorStyle } from "./section-color";
import { useSidebarScope } from "./sidebar-scope";
import { type SidebarSectionRailBadge, sidebarSectionMark, sidebarSectionRailBadgeKind } from "./sidebar-section-rail";

export function SidebarSectionRail() {
  const { layoutMutable, openDelete, props, sectionRail, startCreateSection, startRenameSection } = useSidebarScope();
  const { t } = useText();
  const scrollFades = createScrollFades();
  let list: HTMLDivElement | undefined;
  onCleanup(() => scrollFades.stop());
  createEffect(
    () => sectionRail.items().length,
    () => {
      scrollFades.remeasure();
    },
  );

  const select = (sectionId: string | null) => props.sectionRail?.onSelect(sectionId);

  /** The words that a badge stands for, after the section name. */
  function statusLabels(badge: SidebarSectionRailBadge): string[] {
    return [
      ...(badge.waiting > 0 ? [t("sidebar.waiting.title")] : []),
      ...(badge.unread > 0 ? [t("sidebar.sectionRail.unread", { count: badge.unread })] : []),
      ...(badge.working > 0 ? [t("sidebar.sectionRail.working", { count: badge.working })] : []),
    ];
  }

  /** Arrow keys, Home and End move the focus between the items. Enter and Space select. */
  function moveFocus(event: KeyboardEvent): void {
    const keys = ["ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key) || event.altKey || event.metaKey || event.ctrlKey) return;
    const buttons = [...(list?.querySelectorAll<HTMLButtonElement>(".section-rail-button") ?? [])];
    const active = document.activeElement;
    const index = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1;
    if (index < 0) return;
    event.preventDefault();
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : Math.min(buttons.length - 1, Math.max(0, index + (event.key === "ArrowUp" ? -1 : 1)));
    buttons[target]?.focus();
  }

  function createSection(): void {
    // The new section field is at the end of the list, which shows it only with every section.
    select(null);
    startCreateSection();
  }

  function renameSection(sectionId: string): void {
    // The name field is in the section header, which the list draws while the section shows.
    if (sectionRail.focus() !== null && sectionRail.focus() !== sectionId) select(sectionId);
    queueMicrotask(() => startRenameSection(sectionId));
  }

  return (
    <nav class="server-rail section-rail" aria-label={t("sidebar.sectionRail.label")}>
      <div
        class={["server-rail-list", "section-rail-list", scrollFades.classes()]}
        ref={(element) => {
          list = element;
          scrollFades.bind(element);
        }}
        onScroll={scrollFades.measure}
      >
        <SectionRailButton
          onNavigate={moveFocus}
          label={t("sidebar.sectionRail.all")}
          selected={sectionRail.focus() === null}
          onSelect={() => select(null)}
          mark={
            <span class="section-rail-mark-tile" data-kind="all" aria-hidden="true">
              <LayoutGrid class="section-rail-glyph" />
            </span>
          }
        />
        <For each={sectionRail.items()} keyed={(item) => item.id}>
          {(item) => {
            const name = () => item().section?.name ?? t("sidebar.section.unassigned");
            const custom = () => item().section !== null;
            const editable = () => custom() && layoutMutable();
            return (
              <SectionRailButton
                onNavigate={moveFocus}
                label={name()}
                status={statusLabels(item().badge)}
                badge={item().badge}
                selected={sectionRail.focus() === item().id}
                colorStyle={sidebarSectionColorStyle(item().section?.color)}
                onSelect={() => select(item().id)}
                mark={
                  <Show
                    when={item().section}
                    fallback={
                      <span class="section-rail-mark-tile" data-kind="unassigned" aria-hidden="true">
                        <Inbox class="section-rail-glyph" />
                      </span>
                    }
                  >
                    {(section) => <SidebarSectionMark icon={sidebarSectionMark(section())} />}
                  </Show>
                }
                menu={
                  editable()
                    ? {
                        label: t("sidebar.section.actions"),
                        items: (
                          <>
                            <Show when={sectionRail.iconEditable(item().id)}>
                              <ContextMenu.Item onSelectAfterClose={() => sectionRail.openIconEditor(item().id)}>
                                <Shapes class="agent-context-icon size-4" aria-hidden="true" />
                                <span>{t("sidebar.sectionIcon.open")}</span>
                              </ContextMenu.Item>
                            </Show>
                            <ContextMenu.Item onSelectAfterClose={() => renameSection(item().id)}>
                              <Pencil class="agent-context-icon size-4" aria-hidden="true" />
                              <span>{t("common.rename")}</span>
                            </ContextMenu.Item>
                            <ContextMenu.Separator />
                            <ContextMenu.Item
                              class="ui-action-menu-danger agent-context-danger"
                              onSelect={() => openDelete("section", item().id)}
                            >
                              <Trash2 class="agent-context-icon agent-context-danger-icon size-4" aria-hidden="true" />
                              <span>{t("common.delete")}</span>
                            </ContextMenu.Item>
                          </>
                        ),
                      }
                    : undefined
                }
                unassigned={item().id === SIDEBAR_UNASSIGNED_SECTION_ID}
              />
            );
          }}
        </For>
        <Show when={layoutMutable()}>
          <MotionTooltip content={t("sidebar.new.section")}>
            <Button
              variant="ghost"
              type="button"
              class="server-rail-button server-rail-action section-rail-add"
              aria-label={t("sidebar.new.section")}
              data-cuelume-open=""
              data-cuelume-emphasis="subtle"
              onClick={createSection}
            >
              <span class="server-rail-monogram" aria-hidden="true">
                <Plus />
              </span>
            </Button>
          </MotionTooltip>
        </Show>
      </div>
    </nav>
  );
}

function SectionRailButton(props: {
  label: string;
  status?: string[];
  badge?: SidebarSectionRailBadge;
  selected: boolean;
  colorStyle?: string;
  unassigned?: boolean;
  mark: JSX.Element;
  menu?: { label: string; items: JSX.Element } | undefined;
  onSelect: () => void;
  /** Moves the focus to another item on an arrow key. */
  onNavigate: (event: KeyboardEvent) => void;
}) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const badgeKind = () => (props.badge ? sidebarSectionRailBadgeKind(props.badge) : null);
  const status = () => props.status ?? [];
  return (
    <MotionTooltip
      content={
        <>
          <span class="section-rail-tooltip-name">{props.label}</span>
          <Show when={status().length > 0}>
            <span class="section-rail-tooltip-status">{status().join(" · ")}</span>
          </Show>
        </>
      }
      suppressed={menuOpen()}
    >
      {/* A rail item without actions has no menu content, so a right click opens nothing. */}
      <ContextMenu.Root modal={false} onOpenChange={setMenuOpen}>
        <ContextMenu.Trigger
          as="button"
          type="button"
          class={buttonVariants({ variant: "ghost", class: "server-rail-button section-rail-button" })}
          aria-label={[props.label, ...status()].join(", ")}
          aria-pressed={props.selected ? "true" : "false"}
          aria-keyshortcuts={props.menu ? "Shift+F10" : undefined}
          tabindex={props.selected ? 0 : -1}
          style={props.colorStyle || undefined}
          data-section-color={props.colorStyle ? "" : undefined}
          data-unassigned={props.unassigned ? "" : undefined}
          data-cuelume-navigate=""
          onClick={() => props.onSelect()}
          onKeyDown={(event: KeyboardEvent & { currentTarget: HTMLButtonElement }) => {
            props.onNavigate(event);
            if (!props.menu || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: bounds.right,
                clientY: bounds.top,
              }),
            );
          }}
        >
          <span class="server-rail-mark" aria-hidden="true" />
          {props.mark}
          <Show when={badgeKind()}>
            {(kind) => (
              <span class="section-rail-badge" data-kind={kind()} aria-hidden="true">
                <Show when={kind() === "unread"}>{Math.min(props.badge?.unread ?? 0, 99)}</Show>
              </span>
            )}
          </Show>
        </ContextMenu.Trigger>
        <Show when={props.menu}>
          {(menu) => (
            <ContextMenu.Portal>
              <ContextMenu.Content class="agent-context-menu" aria-label={menu().label}>
                {menu().items}
              </ContextMenu.Content>
            </ContextMenu.Portal>
          )}
        </Show>
      </ContextMenu.Root>
    </MotionTooltip>
  );
}
