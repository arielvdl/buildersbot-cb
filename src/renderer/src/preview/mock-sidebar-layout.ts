import {
  normalizeSidebarSectionColor,
  normalizeSidebarSectionIcon,
  type SidebarLayoutAction,
  type SidebarLayoutSnapshot,
  sidebarSectionWithColor,
  sidebarSectionWithIcon,
} from "@openbot/contracts/ipc";
import {
  applySidebarMarkerAction,
  isSidebarMarkerAction,
  sidebarOrdersWithChatMove,
} from "@openbot/contracts/sidebar-markers";

export function applySidebarLayoutAction(
  layout: SidebarLayoutSnapshot,
  action: SidebarLayoutAction,
): SidebarLayoutSnapshot {
  // As main does for a layout with markers: the shared order rules of `@openbot/contracts/sidebar-markers`.
  const chatIds = new Set([...layout.agentOrder, ...Object.keys(layout.agentAssignments)]);
  if (isSidebarMarkerAction(action)) {
    return applySidebarMarkerAction(layout, action, chatIds, () => crypto.randomUUID(), "Too many markers.");
  }
  if (action.type === "move-agent" && layout.markers?.length) {
    const orders = sidebarOrdersWithChatMove(
      layout,
      action.agentId,
      action.sectionId,
      action.beforeAgentId,
      new Set([...chatIds, action.agentId]),
    );
    const agentAssignments = { ...layout.agentAssignments };
    if (action.sectionId === null) delete agentAssignments[action.agentId];
    else agentAssignments[action.agentId] = action.sectionId;
    return { ...layout, revision: layout.revision + 1, agentAssignments, ...orders };
  }
  const revision = layout.revision + 1;
  if (action.type === "create") {
    const id = crypto.randomUUID();
    return {
      ...layout,
      revision,
      sections: [...layout.sections, { id, name: action.name.trim() }],
      order: [...layout.order, id],
      agentAssignments: action.agentId
        ? { ...layout.agentAssignments, [action.agentId]: id }
        : { ...layout.agentAssignments },
      agentOrder: [...layout.agentOrder],
    };
  }
  if (action.type === "rename") {
    return {
      ...layout,
      revision,
      sections: layout.sections.map((section) =>
        section.id === action.sectionId ? { ...section, name: action.name.trim() } : section,
      ),
    };
  }
  if (action.type === "delete") {
    return {
      ...layout,
      revision,
      sections: layout.sections.filter((section) => section.id !== action.sectionId),
      order: layout.order.filter((sectionId) => sectionId !== action.sectionId),
      agentAssignments: Object.fromEntries(
        Object.entries(layout.agentAssignments).filter(([, sectionId]) => sectionId !== action.sectionId),
      ),
      agentOrder: [...layout.agentOrder],
    };
  }
  if (action.type === "move") {
    const order = [...layout.order];
    const index = order.indexOf(action.sectionId);
    const target = index + (action.direction === "up" ? -1 : 1) * (action.steps ?? 1);
    if (index >= 0 && target >= 0 && target < order.length) {
      const [movedSectionId] = order.splice(index, 1);
      if (movedSectionId) order.splice(target, 0, movedSectionId);
    }
    return { ...layout, revision, order };
  }
  if (action.type === "move-agent") {
    const agentOrder = layout.agentOrder.filter((agentId) => agentId !== action.agentId);
    const insertionIndex = action.beforeAgentId === null ? agentOrder.length : agentOrder.indexOf(action.beforeAgentId);
    agentOrder.splice(insertionIndex < 0 ? agentOrder.length : insertionIndex, 0, action.agentId);
    const agentAssignments = { ...layout.agentAssignments };
    if (action.sectionId === null) delete agentAssignments[action.agentId];
    else agentAssignments[action.agentId] = action.sectionId;
    return { ...layout, revision, agentAssignments, agentOrder };
  }
  if (action.type === "set-section-color") {
    // As main does: a color in any case is stored in lower case, and any other value is refused.
    const color = action.color === null ? null : normalizeSidebarSectionColor(action.color);
    if (action.color !== null && color === null) throw new Error("Invalid section color.");
    return {
      ...layout,
      revision,
      sections: layout.sections.map((section) =>
        section.id === action.sectionId ? sidebarSectionWithColor(section, color) : section,
      ),
    };
  }
  if (action.type === "set-section-icon") {
    // As main does: a letter loses its spaces, and any other value is refused.
    const icon = action.icon === null ? null : normalizeSidebarSectionIcon(action.icon);
    if (action.icon !== null && icon === null) throw new Error("Invalid section icon.");
    return {
      ...layout,
      revision,
      sections: layout.sections.map((section) =>
        section.id === action.sectionId ? sidebarSectionWithIcon(section, icon) : section,
      ),
    };
  }
  const agentAssignments = { ...layout.agentAssignments };
  if (action.sectionId === null) delete agentAssignments[action.agentId];
  else agentAssignments[action.agentId] = action.sectionId;
  return { ...layout, revision, agentAssignments };
}
