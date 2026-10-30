/**
 * The one native color input of the sidebar. "Choose color" in a section menu opens its picker for
 * that section. The menu closes before the picker opens, so the input cannot be in the menu: one
 * hidden input serves every section.
 *
 * The picker sends `input` while the user moves in it and `change` when it closes. The color saves
 * on `change`, and also after a short pause in `input`, so the box shows the color while the picker
 * is still open.
 */

import { onCleanup } from "solid-js";
import { sidebarSectionPickerColor } from "../section-color";
import type { SidebarProps } from "../sidebar-types";

const INPUT_SAVE_DELAY_MS = 300;

export function createSidebarSectionColorStore(deps: {
  props: SidebarProps;
  setSectionColor: (sectionId: string, color: string | null) => void;
}) {
  const { props, setSectionColor } = deps;
  let input: HTMLInputElement | undefined;
  let targetSectionId: string | null = null;
  let pendingSave: ReturnType<typeof setTimeout> | undefined;

  function cancelPendingSave(): void {
    if (pendingSave !== undefined) clearTimeout(pendingSave);
    pendingSave = undefined;
  }

  onCleanup(cancelPendingSave);

  function setSectionColorInput(element: HTMLInputElement): void {
    input = element;
  }

  function releaseSectionColorInput(element: HTMLInputElement | undefined): void {
    if (input === element) input = undefined;
  }

  /** Opens the picker on the color of the section, or on the default when it has none. */
  function pickCustomSectionColor(sectionId: string): void {
    const section = props.layout.sections.find((candidate) => candidate.id === sectionId);
    if (!input || !section) return;
    cancelPendingSave();
    targetSectionId = sectionId;
    input.value = sidebarSectionPickerColor(section.color);
    try {
      input.showPicker();
    } catch {
      // A browser without `showPicker` for a color input opens the picker on a click.
      input.click();
    }
  }

  function saveCustomSectionColor(value: string): void {
    cancelPendingSave();
    if (targetSectionId !== null) setSectionColor(targetSectionId, value);
  }

  function previewCustomSectionColor(value: string): void {
    cancelPendingSave();
    pendingSave = setTimeout(() => saveCustomSectionColor(value), INPUT_SAVE_DELAY_MS);
  }

  return {
    pickCustomSectionColor,
    previewCustomSectionColor,
    releaseSectionColorInput,
    saveCustomSectionColor,
    setSectionColorInput,
  };
}
