/**
 * The "Color" submenu of a custom section, and the hidden native color input that its last item
 * opens. A choice applies at once and the menu stays open, so the user can compare colors on the
 * section box. Each choice is a radio item with the color name, so the keyboard and screen readers
 * reach every swatch.
 */

import { Check, ChevronRight, ContextMenu, Palette, Pipette } from "@openbot/ui";
import { For, onCleanup, Show } from "solid-js";
import { useText } from "../../text";
import { isCustomSidebarSectionColor, SIDEBAR_SECTION_COLOR_PRESETS, SIDEBAR_SECTION_NO_COLOR } from "./section-color";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarSectionColorSubmenu(menuProps: { sectionId: string }) {
  const { customSectionById, pickCustomSectionColor, setSectionColor } = useSidebarScope();
  const { t } = useText();
  const color = () => customSectionById().get(menuProps.sectionId)?.color;
  const customColor = () => {
    const value = color();
    return isCustomSidebarSectionColor(value) ? value : undefined;
  };
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger>
        <Palette class="agent-context-icon size-4" aria-hidden="true" />
        <span>{t("sidebar.section.color")}</span>
        <ChevronRight class="agent-context-submenu-chevron size-4" aria-hidden="true" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          class="ui-action-menu agent-context-menu agent-context-submenu"
          aria-label={t("sidebar.section.color")}
        >
          <ContextMenu.RadioGroup
            value={color() ?? SIDEBAR_SECTION_NO_COLOR}
            onChange={(value: string) =>
              setSectionColor(menuProps.sectionId, value === SIDEBAR_SECTION_NO_COLOR ? null : value)
            }
          >
            <ContextMenu.RadioItem value={SIDEBAR_SECTION_NO_COLOR} aria-label={t("sidebar.section.colorNone")}>
              <span class="sidebar-section-color-swatch sidebar-section-color-swatch-none" aria-hidden="true" />
              <span>{t("sidebar.section.colorNone")}</span>
              <Show when={color() === undefined}>
                <Check class="sidebar-section-color-check size-4" aria-hidden="true" />
              </Show>
            </ContextMenu.RadioItem>
            <For each={SIDEBAR_SECTION_COLOR_PRESETS}>
              {(preset) => (
                <ContextMenu.RadioItem value={preset.color} aria-label={t(preset.label)}>
                  <span class="sidebar-section-color-swatch" style={{ background: preset.color }} aria-hidden="true" />
                  <span>{t(preset.label)}</span>
                  <Show when={color() === preset.color}>
                    <Check class="sidebar-section-color-check size-4" aria-hidden="true" />
                  </Show>
                </ContextMenu.RadioItem>
              )}
            </For>
            <Show when={customColor()}>
              {(value) => (
                <ContextMenu.RadioItem value={value()} aria-label={t("sidebar.section.colorCustom")}>
                  <span class="sidebar-section-color-swatch" style={{ background: value() }} aria-hidden="true" />
                  <span>{t("sidebar.section.colorCustom")}</span>
                  <Check class="sidebar-section-color-check size-4" aria-hidden="true" />
                </ContextMenu.RadioItem>
              )}
            </Show>
          </ContextMenu.RadioGroup>
          <ContextMenu.Separator />
          <ContextMenu.Item onSelectAfterClose={() => pickCustomSectionColor(menuProps.sectionId)}>
            <Pipette class="agent-context-icon size-4" aria-hidden="true" />
            <span>{t("sidebar.section.colorPick")}</span>
          </ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

/**
 * The native color input that "Choose color" opens. It is visually hidden and out of the tab order:
 * the menu item is the way to it, and the picker it opens is the system one.
 */
export function SidebarSectionColorInput() {
  const { previewCustomSectionColor, releaseSectionColorInput, saveCustomSectionColor, setSectionColorInput } =
    useSidebarScope();
  const { t } = useText();
  // The ref callback runs without an owner in Solid 2, so the cleanup is registered in the body.
  let element: HTMLInputElement | undefined;
  onCleanup(() => releaseSectionColorInput(element));
  return (
    <input
      ref={(input: HTMLInputElement) => {
        element = input;
        setSectionColorInput(input);
      }}
      type="color"
      class="sr-only"
      tabindex="-1"
      aria-label={t("sidebar.section.colorPick")}
      onInput={(event) => previewCustomSectionColor(event.currentTarget.value)}
      onChange={(event) => saveCustomSectionColor(event.currentTarget.value)}
    />
  );
}
