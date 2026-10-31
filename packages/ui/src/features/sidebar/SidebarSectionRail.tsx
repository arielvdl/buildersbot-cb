/**
 * The section rail: the narrow column at the left of the list, in the place of the server rail.
 * "All" lists every section; a section lists only its chats. Each item shows the section mark and one
 * badge for what asks for the user there: a wait, unread messages, or work in flight. The plus button
 * opens the new section field of the list.
 *
 * The rail uses the server rail classes, so the frame gives it the same column on desktop and on the
 * web, and hides it in the same places.
 *
 * On the local server, a section item drags up or down to reorder the sections, as a server does in the
 * server rail, and Alt+Arrow moves it by one place. The drop sends the `move` action of the section
 * list, so the rail and the list keep one order. "All", "Unassigned" and the plus button stay in place.
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
import { createEffect, createSignal, createStore, For, Match, onCleanup, Show, Switch } from "solid-js";
import { createScrollFades } from "../../components/createScrollFades";
import { createVerticalDragPreview } from "../../components/createVerticalDragPreview";
import { useText } from "../../text";
import { SidebarSectionColorSubmenu } from "./SidebarSectionColorMenu";
import { SidebarSectionMark } from "./SidebarSectionMark";
import { sidebarSectionColorStyle } from "./section-color";
import { useSidebarScope } from "./sidebar-scope";
import {
  type SidebarSectionRailBadge,
  sidebarSectionMark,
  sidebarSectionRailBadgeKind,
  sidebarSectionRailDragStep,
  sidebarSectionRailMenuItems,
  sidebarSectionRailMove,
  sidebarSectionRailNeighbor,
} from "./sidebar-section-rail";

/** What a rail item needs to drag. Only a custom section has it. */
interface SectionRailReorder {
  id: string;
  step: number;
  dragging: boolean;
  onDragStart: (event: DragEvent & { currentTarget: HTMLElement }) => void;
  onDragEnd: () => void;
  onMove: (direction: -1 | 1) => void;
}

export function SidebarSectionRail() {
  const { layoutMutable, openDelete, props, sectionRail } = useSidebarScope();
  const { t } = useText();
  const scrollFades = createScrollFades();
  const dragPreview = createVerticalDragPreview();
  const [drag, setDrag] = createStore<{ sourceId: string | null; overId: string | null }>({
    sourceId: null,
    overId: null,
  });
  const [announcement, setAnnouncement] = createSignal("");
  let list: HTMLDivElement | undefined;
  let slots: { id: string; centerY: number }[] = [];
  let startScrollTop = 0;
  onCleanup(() => {
    scrollFades.stop();
    dragPreview.stop();
  });
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

  /** Only the local server reorders here, as for the section color and icon. */
  const reorderable = () => props.sectionIconsSupported === true && layoutMutable();
  /** The custom sections in the rail order: the only items that drag and take a drop. */
  const railIds = () => sectionRail.items().flatMap((item) => (item.section ? [item.id] : []));

  function moveSection(sourceId: string, targetId: string): void {
    const action = sidebarSectionRailMove(
      props.layout.order,
      new Set(props.layout.sections.map((section) => section.id)),
      sourceId,
      targetId,
    );
    if (!action) return;
    const position = railIds().indexOf(targetId) + 1;
    const total = railIds().length;
    const name = props.layout.sections.find((section) => section.id === sourceId)?.name ?? "";
    void props.onMutateLayout(action).then(
      () => {
        setAnnouncement(t("sidebar.announce.movedToPosition", { name, position, total }));
        // The item moved in the DOM; the focus stays with it for the next Alt+Arrow.
        queueMicrotask(() =>
          list?.querySelector<HTMLElement>(`[data-section-rail-id="${CSS.escape(sourceId)}"]`)?.focus(),
        );
      },
      () => setAnnouncement(t("sidebar.announce.updateFailed")),
    );
  }

  function closestSlot(clientY: number): string | null {
    const scrollDelta = (list?.scrollTop ?? 0) - startScrollTop;
    let closest: { id: string; distance: number } | null = null;
    for (const slot of slots) {
      const distance = Math.abs(clientY - (slot.centerY - scrollDelta));
      if (!closest || distance < closest.distance) closest = { id: slot.id, distance };
    }
    if (closest && drag.overId !== closest.id) {
      setDrag((state) => {
        state.overId = closest.id;
      });
    }
    return closest?.id ?? null;
  }

  /** Near an edge of a rail that scrolls, the drag scrolls it. */
  function scrollNearEdge(clientY: number): void {
    if (!list) return;
    const bounds = list.getBoundingClientRect();
    const edge = Math.min(36, bounds.height / 3);
    if (clientY - bounds.top < edge) list.scrollTop -= 6;
    else if (bounds.bottom - clientY < edge) list.scrollTop += 6;
  }

  function stopDragging(): void {
    dragPreview.stop();
    slots = [];
    setDrag((state) => {
      state.sourceId = null;
      state.overId = null;
    });
  }

  function startDragging(event: DragEvent & { currentTarget: HTMLElement }, sectionId: string): void {
    if (!reorderable() || !list) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData("text/plain", sectionId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    startScrollTop = list.scrollTop;
    slots = [...list.querySelectorAll<HTMLElement>("[data-section-rail-id]")].flatMap((element) => {
      const id = element.dataset.sectionRailId;
      const bounds = element.getBoundingClientRect();
      return id ? [{ id, centerY: bounds.top + bounds.height / 2 }] : [];
    });
    dragPreview.start({ bounds: list, className: "section-rail-drag-preview", event, source: event.currentTarget });
    setDrag((state) => {
      state.sourceId = sectionId;
      state.overId = sectionId;
    });
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

  return (
    <nav
      class="server-rail section-rail"
      aria-label={t("sidebar.sectionRail.label")}
      data-dragging={drag.sourceId ? "" : undefined}
      onDragOver={(event) => {
        if (!drag.sourceId) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        dragPreview.move(event.clientY);
        closestSlot(event.clientY);
        scrollNearEdge(event.clientY);
      }}
      onDrop={(event) => {
        if (!drag.sourceId) return;
        event.preventDefault();
        const sourceId = drag.sourceId;
        const targetId = closestSlot(event.clientY) ?? drag.overId;
        stopDragging();
        if (targetId) moveSection(sourceId, targetId);
      }}
    >
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
            // A function, not an element: the menu builds its items once, when it opens.
            const sectionMenu = () => (
              <For
                each={sidebarSectionRailMenuItems({
                  iconEditable: sectionRail.iconEditable(item().id),
                  colorSupported: props.sectionColorSupported === true,
                })}
              >
                {(entry) => (
                  <Switch>
                    <Match when={entry === "icon"}>
                      <ContextMenu.Item onSelectAfterClose={() => sectionRail.openIconEditor(item().id)}>
                        <Shapes class="agent-context-icon size-4" aria-hidden="true" />
                        <span>{t("sidebar.sectionIcon.open")}</span>
                      </ContextMenu.Item>
                    </Match>
                    <Match when={entry === "color"}>
                      {/* A submenu: each color applies at once, so the rail tile shows it while the menu is open. */}
                      <SidebarSectionColorSubmenu sectionId={item().id} label={t("sidebar.sectionRail.changeColor")} />
                    </Match>
                    <Match when={entry === "rename"}>
                      <ContextMenu.Item
                        onSelectAfterClose={() => sectionRail.openNameDialog({ kind: "rename", sectionId: item().id })}
                      >
                        <Pencil class="agent-context-icon size-4" aria-hidden="true" />
                        <span>{t("common.rename")}</span>
                      </ContextMenu.Item>
                    </Match>
                    <Match when={entry === "delete"}>
                      <ContextMenu.Separator />
                      <ContextMenu.Item
                        class="ui-action-menu-danger agent-context-danger"
                        onSelect={() => openDelete("section", item().id)}
                      >
                        <Trash2 class="agent-context-icon agent-context-danger-icon size-4" aria-hidden="true" />
                        <span>{t("common.delete")}</span>
                      </ContextMenu.Item>
                    </Match>
                  </Switch>
                )}
              </For>
            );
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
                menuItems={editable() ? sectionMenu : undefined}
                unassigned={item().id === SIDEBAR_UNASSIGNED_SECTION_ID}
                reorder={
                  custom() && reorderable()
                    ? {
                        id: item().id,
                        step: sidebarSectionRailDragStep(railIds(), drag.sourceId, drag.overId, item().id),
                        dragging: drag.sourceId === item().id,
                        onDragStart: (event) => startDragging(event, item().id),
                        onDragEnd: stopDragging,
                        onMove: (direction) => {
                          const target = sidebarSectionRailNeighbor(railIds(), item().id, direction);
                          if (target) moveSection(item().id, target);
                        },
                      }
                    : undefined
                }
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
              onClick={() => sectionRail.openNameDialog({ kind: "create" })}
            >
              <span class="server-rail-monogram" aria-hidden="true">
                <Plus />
              </span>
            </Button>
          </MotionTooltip>
        </Show>
        <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement()}
        </span>
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
  /** The actions of the item. Without them, a right click opens nothing. */
  menuItems?: (() => JSX.Element) | undefined;
  onSelect: () => void;
  /** Moves the focus to another item on an arrow key. */
  onNavigate: (event: KeyboardEvent) => void;
  /** The drag and the Alt+Arrow move of a custom section, where the server allows them. */
  reorder?: SectionRailReorder | undefined;
}) {
  const { t } = useText();
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
          aria-keyshortcuts={
            [props.menuItems ? "Shift+F10" : "", props.reorder ? "Alt+ArrowUp Alt+ArrowDown" : ""]
              .filter(Boolean)
              .join(" ") || undefined
          }
          tabindex={props.selected ? 0 : -1}
          style={
            `${props.colorStyle ?? ""}${props.reorder ? `--section-rail-drag-step: ${props.reorder.step};` : ""}` ||
            undefined
          }
          draggable={props.reorder ? "true" : undefined}
          data-section-rail-id={props.reorder?.id}
          data-dragging={props.reorder?.dragging ? "" : undefined}
          onDragStart={(event: DragEvent & { currentTarget: HTMLElement }) => props.reorder?.onDragStart(event)}
          onDragEnd={() => props.reorder?.onDragEnd()}
          data-section-color={props.colorStyle ? "" : undefined}
          data-unassigned={props.unassigned ? "" : undefined}
          data-cuelume-navigate=""
          onClick={() => props.onSelect()}
          onKeyDown={(event: KeyboardEvent & { currentTarget: HTMLButtonElement }) => {
            if (props.reorder && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
              event.preventDefault();
              props.reorder.onMove(event.key === "ArrowUp" ? -1 : 1);
              return;
            }
            props.onNavigate(event);
            if (!props.menuItems || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
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
        <Show when={props.menuItems}>
          {(items) => (
            <ContextMenu.Portal>
              <ContextMenu.Content class="agent-context-menu" aria-label={t("sidebar.section.actions")}>
                {items()()}
              </ContextMenu.Content>
            </ContextMenu.Portal>
          )}
        </Show>
      </ContextMenu.Root>
    </MotionTooltip>
  );
}
