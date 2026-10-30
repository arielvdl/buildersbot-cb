import { Show } from "solid-js";
import { SidebarDialogs } from "./SidebarDialogs";
import { SidebarFrame } from "./SidebarFrame";
import { SidebarNav } from "./SidebarNav";
import { SidebarSearch } from "./SidebarSearch";
import { SidebarSectionColorInput } from "./SidebarSectionColorMenu";
import { SidebarSectionIconDialog } from "./SidebarSectionIconDialog";
import { SidebarSectionRail } from "./SidebarSectionRail";
import { SidebarTopbar } from "./SidebarTopbar";
import { SidebarViewSwitch } from "./SidebarViewSwitch";
import { createSidebarScope, SidebarScopeContext } from "./sidebar-scope";
import type { SidebarProps } from "./sidebar-types";

export function Sidebar(props: SidebarProps) {
  const scope = createSidebarScope(props);
  return (
    <SidebarScopeContext value={scope}>
      {/* Before the frame: the app frame gives its first column to a rail. */}
      <Show when={props.sectionRail}>
        <SidebarSectionRail />
      </Show>
      <SidebarFrame compact={props.compact}>
        <SidebarTopbar />

        <SidebarSearch />

        <Show when={props.onViewChange && !props.compact}>
          <SidebarViewSwitch />
        </Show>

        <SidebarNav />

        <Show when={!props.compact}>{props.footer}</Show>

        <SidebarDialogs />

        <SidebarSectionIconDialog />

        <Show when={props.sectionColorSupported && props.layoutMutable !== false}>
          <SidebarSectionColorInput />
        </Show>
      </SidebarFrame>
    </SidebarScopeContext>
  );
}
