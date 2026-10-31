/**
 * The markers of the list as the sidebar edits them: which marker editor is open, and the create, the
 * save and the remove. A new marker opens its editor once the layout has it, so the user can write its
 * text at once.
 */

import type { SidebarMarkerStyle } from "@openbot/contracts/ipc";
import { createEffect, createSignal } from "solid-js";
import { sidebarCreatedMarkerId, sidebarMarkerCreateSection } from "../sidebar-markers-view";
import type { SidebarProps } from "../sidebar-types";

export interface SidebarMarkerFields {
  label: string;
  style: SidebarMarkerStyle;
  color: string | null;
}

export function createSidebarMarkerStore(deps: {
  props: SidebarProps;
  /** The section that the rail selects, or null for "All". */
  focus: () => string | null;
  announceError: (error: unknown) => void;
}) {
  const { props } = deps;
  const [openMarkerId, setOpenMarkerId] = createSignal<string | null>(null);
  /** The marker ids before a create, until the layout has the new marker. */
  const [created, setCreated] = createSignal<ReadonlySet<string> | null>(null);

  createEffect(
    () => ({ before: created(), layout: props.layout }),
    ({ before, layout }) => {
      if (!before) return;
      const markerId = sidebarCreatedMarkerId(before, layout);
      if (!markerId) return;
      setCreated(null);
      setOpenMarkerId(markerId);
    },
  );

  /** Markers live only in the local layout, which this server must also let the user change. */
  const supported = () => props.markersSupported === true && props.layoutMutable !== false;

  function createMarker(): void {
    if (!supported()) return;
    // The editor opens on the new line, which the compact sidebar does not show.
    props.onExpand();
    setCreated(new Set((props.layout.markers ?? []).map((marker) => marker.id)));
    void props
      .onMutateLayout({
        type: "create-marker",
        sectionId: sidebarMarkerCreateSection(props.layout, deps.focus()),
        label: "",
        style: "normal",
        color: null,
      })
      .catch((error: unknown) => {
        setCreated(null);
        deps.announceError(error);
      });
  }

  async function saveMarker(markerId: string, fields: SidebarMarkerFields): Promise<void> {
    await props.onMutateLayout({ type: "update-marker", markerId, ...fields });
  }

  async function removeMarker(markerId: string): Promise<void> {
    await props.onMutateLayout({ type: "delete-marker", markerId });
  }

  return { createMarker, openMarkerId, removeMarker, saveMarker, setOpenMarkerId, supported };
}
