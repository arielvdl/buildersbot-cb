/**
 * One tab group for each project, named after the project and in its color (DESIGN §4). A group is ours
 * only by the id that the extension registered when it made it, never by its title, so a group of the
 * person with the same name is never touched. Grey means that no agent acts there.
 */

import {
  distinctGroupTitles,
  PAUSED_GROUP_COLOR,
  projectGroupTitle,
  type TabGroupColor,
} from "@openbot/contracts/chrome-bridge/groups";
import { TAB_TIMING } from "@openbot/contracts/chrome-bridge/protocol";
import { emit } from "./outbox";
import {
  type Project,
  type ProjectColor,
  persist,
  projectOfGroup,
  type StopSource,
  state,
  tabsOfProject,
} from "./state";
import { chromeErrorText, retryTabEdit } from "./util";

const GROUP_COLORS: readonly ProjectColor[] = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

/** The title that the extension last wrote to each group, to tell a rename by the person apart. */
const writtenTitles = new Map<number, string>();
/** Groups that the extension removes itself (the last tab closed by an agent or a release). */
const removedByExtension = new Set<number>();
/** Groups that Chrome made in the last second: a group dragged to another window is made again there. */
const recentlyCreated = new Map<number, number>();
/** Tabs of each project that went away in the last second, to tell "close the group" from "close a tab". */
const recentRemovals = new Map<string, number[]>();

const edit = <T>(change: () => Promise<T>) => retryTabEdit(change, TAB_TIMING.editRetryMs, TAB_TIMING.editRetries);

export function isPaused(project: Project): boolean {
  return state.stopAll !== null || project.pausedBy !== null || project.shared;
}

/** Adds or updates a project from the app. The title is cleaned again here, whatever the app sent. */
export function configureProject(projectKey: string, title: string, color: ProjectColor): Project {
  const existing = state.projects.get(projectKey);
  const clean = projectGroupTitle(title);
  if (existing) {
    const changed = existing.title !== clean || existing.color !== color;
    existing.title = clean;
    if (existing.color !== color) existing.shownColor = color;
    existing.color = color;
    if (changed) void applyLook(existing);
    persist();
    return existing;
  }
  const project: Project = {
    projectKey,
    title: clean,
    color,
    shownColor: color,
    groupId: null,
    windowId: null,
    userTitle: false,
    shared: false,
    pausedBy: null,
    collapsedByExtension: false,
    blocked: [],
  };
  state.projects.set(projectKey, project);
  persist();
  return project;
}

/** The titles of all our groups, with " (2)" on a repeated name, in the order the projects came. */
function shownTitle(project: Project): string {
  const projects = [...state.projects.values()];
  const titles = distinctGroupTitles(projects.map((entry) => entry.title));
  return titles[projects.indexOf(project)] ?? project.title;
}

/** Writes the title and color of a project's group: grey while paused, the project color otherwise. */
export async function applyLook(project: Project): Promise<void> {
  if (project.groupId === null) return;
  const groupId = project.groupId;
  const color: TabGroupColor = isPaused(project) ? PAUSED_GROUP_COLOR : project.shownColor;
  const update: { title?: string; color: TabGroupColor } = { color };
  if (!project.userTitle) {
    update.title = shownTitle(project);
    writtenTitles.set(groupId, update.title);
  }
  try {
    await edit(() => chrome.tabGroups.update(groupId, update));
  } catch {
    // The group went away meanwhile; its removal event clears it.
  }
}

/** The normal window where a new group is made: the last focused one, without moving the focus. */
async function windowForNewGroup(): Promise<number> {
  try {
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (window.id !== undefined && window.type === "normal") return window.id;
  } catch {
    // No window: make one below.
  }
  const created = await chrome.windows.create({ focused: false, type: "normal" });
  if (created.id === undefined) throw new Error("Chrome made a window with no id");
  return created.id;
}

/** The window and the index at the end of the project's group, where its next tab goes. */
export async function placeForNewTab(project: Project): Promise<{ windowId: number; index?: number }> {
  if (project.groupId !== null) {
    try {
      const group = await chrome.tabGroups.get(project.groupId);
      const tabs = await chrome.tabs.query({ groupId: group.id });
      const last = Math.max(...tabs.map((tab) => tab.index));
      return { windowId: group.windowId, index: Number.isFinite(last) ? last + 1 : undefined };
    } catch {
      project.groupId = null;
      project.windowId = null;
    }
  }
  return { windowId: await windowForNewGroup() };
}

/** A color that no other group of ours shows in the window, starting at the project color. */
async function freeColor(project: Project, windowId: number): Promise<ProjectColor> {
  const used = new Set<string>();
  for (const other of state.projects.values()) {
    if (other !== project && other.groupId !== null && other.windowId === windowId) used.add(other.shownColor);
  }
  if (!used.has(project.color)) return project.color;
  const start = GROUP_COLORS.indexOf(project.color);
  for (let step = 1; step < GROUP_COLORS.length; step += 1) {
    const color = GROUP_COLORS[(start + step) % GROUP_COLORS.length];
    if (color && !used.has(color)) return color;
  }
  return project.color;
}

/** A group that is being made, by project: the tabs that come meanwhile join it, not a second group. */
const groupsBeingMade = new Map<string, Promise<void>>();

/** Puts a tab into its project's group, and makes the group when the project has none. */
export async function groupTab(project: Project, tabId: number, windowId: number): Promise<void> {
  const pending = groupsBeingMade.get(project.projectKey);
  if (pending) await pending.catch(() => undefined);
  if (project.groupId !== null) {
    const groupId = project.groupId;
    await edit(() => chrome.tabs.group({ tabIds: [tabId], groupId }));
    if (project.collapsedByExtension) await expand(project);
    return;
  }
  const making = (async () => {
    const groupId = await edit(() => chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } }));
    project.groupId = groupId;
    project.windowId = windowId;
    project.shownColor = await freeColor(project, windowId);
    project.collapsedByExtension = false;
    persist();
    await applyLook(project);
  })();
  groupsBeingMade.set(project.projectKey, making);
  try {
    await making;
  } finally {
    if (groupsBeingMade.get(project.projectKey) === making) groupsBeingMade.delete(project.projectKey);
  }
}

/** Takes a tab out of its group before the extension closes it, so Chrome does not keep the group saved. */
export async function ungroupBeforeClose(project: Project, tabId: number): Promise<void> {
  if (project.groupId === null) return;
  const left = tabsOfProject(project.projectKey).filter((tab) => tab.tabId !== tabId).length;
  if (left === 0) removedByExtension.add(project.groupId);
  try {
    await edit(() => chrome.tabs.ungroup([tabId]));
  } catch {
    // The tab already left the group.
  }
  if (left === 0) {
    project.groupId = null;
    project.windowId = null;
    persist();
  }
}

async function expand(project: Project): Promise<void> {
  if (project.groupId === null || !project.collapsedByExtension) return;
  const groupId = project.groupId;
  project.collapsedByExtension = false;
  persist();
  try {
    await edit(() => chrome.tabGroups.update(groupId, { collapsed: false }));
  } catch {
    // Gone.
  }
}

/** Opens a group that the extension collapsed, at the next agent activity in it. */
export function noteActivity(project: Project): void {
  if (project.collapsedByExtension) void expand(project);
}

/**
 * Collapses a group with no active lease, unless it holds the active tab of its window. Only a group
 * that the extension collapsed opens again by itself.
 */
export async function collapseIfIdle(project: Project): Promise<void> {
  if (project.groupId === null || project.collapsedByExtension) return;
  const groupId = project.groupId;
  try {
    const group = await chrome.tabGroups.get(groupId);
    if (group.collapsed) return;
    const [active] = await chrome.tabs.query({ active: true, windowId: group.windowId });
    if (active?.groupId === groupId) return;
    await edit(() => chrome.tabGroups.update(groupId, { collapsed: true }));
    project.collapsedByExtension = true;
    persist();
  } catch {
    // Gone or being edited: try at the next idle time.
  }
}

/** A group that Chrome made in the last second: a group dragged to another window, or one of ours. */
export function isNewGroup(groupId: number): boolean {
  const made = recentlyCreated.get(groupId);
  return made !== undefined && Date.now() - made < 1_000;
}

export function noteTabGone(projectKey: string): void {
  const now = Date.now();
  const recent = (recentRemovals.get(projectKey) ?? []).filter((time) => now - time < 1_000);
  recent.push(now);
  recentRemovals.set(projectKey, recent);
}

// ---------------------------------------------------------------------------------------------------
// Chrome events

type PersonStop = (projectKey: string, source: StopSource) => void;
let stopProjectByPerson: PersonStop = () => undefined;

/** The stop module gives the action that pauses a project, to keep the imports one way. */
export function setPersonStop(action: PersonStop): void {
  stopProjectByPerson = action;
}

export function onGroupCreated(group: chrome.tabGroups.TabGroup): void {
  const now = Date.now();
  recentlyCreated.set(group.id, now);
  for (const [id, time] of recentlyCreated) if (now - time > 2_000) recentlyCreated.delete(id);
}

export function onGroupUpdated(group: chrome.tabGroups.TabGroup): void {
  const project = projectOfGroup(group.id);
  if (!project) return;
  if (group.shared === true && !project.shared) {
    project.shared = true;
    persist();
    emit("group.shared", { projectKey: project.projectKey });
    void applyLook(project);
  }
  const written = writtenTitles.get(group.id);
  if (!project.userTitle && written !== undefined && group.title !== undefined && group.title !== written) {
    project.userTitle = true;
    persist();
    emit("group.renamed", { projectKey: project.projectKey, userTitle: true });
  }
  if (!group.collapsed && project.collapsedByExtension) {
    // The person opened it: it is theirs to collapse now.
    project.collapsedByExtension = false;
    persist();
  }
}

export function onGroupRemoved(group: chrome.tabGroups.TabGroup): void {
  const project = projectOfGroup(group.id);
  writtenTitles.delete(group.id);
  if (!project) return;
  if (removedByExtension.delete(group.id)) {
    project.groupId = null;
    project.windowId = null;
    persist();
    return;
  }
  // A group dragged to another window is removed here and made again there (tabGroups.onMoved does not
  // fire across windows). Wait, then follow the tabs before calling it closed.
  setTimeout(() => void settleRemovedGroup(project, group.id), 500);
}

async function settleRemovedGroup(project: Project, oldGroupId: number): Promise<void> {
  if (project.groupId !== oldGroupId) return;
  const live: chrome.tabs.Tab[] = [];
  for (const tab of tabsOfProject(project.projectKey)) {
    try {
      live.push(await chrome.tabs.get(tab.tabId));
    } catch {
      // Closed.
    }
  }
  const groups = new Set(live.map((tab) => tab.groupId).filter((id) => id !== chrome.tabGroups.TAB_GROUP_ID_NONE));
  const [movedTo] = groups;
  if (groups.size === 1 && movedTo !== undefined && recentlyCreated.has(movedTo)) {
    const inGroup = await chrome.tabs.query({ groupId: movedTo });
    const ours = (tab: chrome.tabs.Tab) =>
      tab.id !== undefined && tabsOfProject(project.projectKey).some((entry) => entry.tabId === tab.id);
    if (inGroup.length > 0 && inGroup.every(ours)) {
      const windowId = inGroup[0]?.windowId ?? project.windowId ?? 0;
      project.groupId = movedTo;
      project.windowId = windowId;
      persist();
      emit("group.moved", { projectKey: project.projectKey, windowId });
      await applyLook(project);
      return;
    }
  }
  project.groupId = null;
  project.windowId = null;
  project.collapsedByExtension = false;
  persist();
  const ungrouped = live.filter((tab) => tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE).length;
  const closedTogether = (recentRemovals.get(project.projectKey) ?? []).filter((time) => Date.now() - time < 1_500);
  // The person closed or ungrouped the whole group: that is a stop for the project. Closing the only
  // tab of a group is not; the next tab makes the group again.
  if (ungrouped > 0 || closedTogether.length >= 2) stopProjectByPerson(project.projectKey, "group");
  emit("group.removed", { projectKey: project.projectKey });
}

/** Chrome error text that says a group edit failed for a reason other than a drag in progress. */
export function isGroupGone(error: unknown): boolean {
  return /No group with id|No tab with id/u.test(chromeErrorText(error));
}
