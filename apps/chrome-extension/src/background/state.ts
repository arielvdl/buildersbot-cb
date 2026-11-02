/**
 * What the extension knows, in memory, and where it keeps it between two lives of the service worker.
 *
 * - `storage.session` holds the projects, leases, tab handles and stops. Chrome clears it when the
 *   browser restarts and when the extension updates or reloads.
 * - `storage.local` holds the registry of the groups that the extension made (cleared at
 *   `runtime.onStartup`, because group ids change with a browser restart) and the floor origins that the
 *   person opened for a project in the popup.
 *
 * Writes are joined: many changes in one task make one write.
 */

import type { TabGroupColor } from "@openbot/contracts/chrome-bridge/groups";
import { DEFAULT_NAVIGATION_RATE, DEFAULT_TAB_LIMITS } from "@openbot/contracts/chrome-bridge/protocol";
import { isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

export type ProjectColor = Exclude<TabGroupColor, "grey">;
export type StopSource = "popup" | "shortcut" | "infobar" | "group" | "app";

export interface Project {
  projectKey: string;
  title: string;
  color: ProjectColor;
  /** The color the group shows when it is not paused: `color`, or the next free one in its window. */
  shownColor: ProjectColor;
  groupId: number | null;
  windowId: number | null;
  /** The person renamed the group; the extension stops writing its title. */
  userTitle: boolean;
  shared: boolean;
  pausedBy: StopSource | null;
  /** The extension collapsed the group; only then does it open it again. */
  collapsedByExtension: boolean;
  /** Origins of the floor that a person blocked an agent from, newest first, for the popup. */
  blocked: string[];
}

export interface Lease {
  leaseId: string;
  projectKey: string;
  agentLabel: string;
  initials: string;
  routine: boolean;
  active: boolean;
  lastCommandAt: number;
}

export interface AgentTab {
  handle: string;
  tabId: number;
  projectKey: string;
  leaseId: string | null;
  /** `extension`: the blank tab that holds a group made by `group.ensure`; the next `tab.create` uses it. */
  createdBy: "agent" | "person" | "extension";
  /** The person activated the tab; a release then ungroups it and does not close it. */
  viewed: boolean;
  /** The handle of the tab that opened this one in a `popup` window. */
  satelliteOf: string | null;
  /** The main frame is on the floor: only history and close work until it leaves. */
  quarantined: boolean;
  lastCommandAt: number;
}

export interface Limits {
  tabsPerLease: number;
  tabsPerProject: number;
  tabsTotal: number;
}

export interface ExtensionState {
  projects: Map<string, Project>;
  leases: Map<string, Lease>;
  tabs: Map<string, AgentTab>;
  byTabId: Map<number, string>;
  stopAll: StopSource | null;
  limits: Limits;
  rate: { perOriginPerMinute: number; perProjectPerMinute: number };
  policyAdd: string[];
  /** Origins of the floor that the person opened, by project. */
  unlocks: Map<string, string[]>;
  /** Tabs with the debugger attached when the worker last wrote its state. */
  attachedTabIds: Set<number>;
}

export const state: ExtensionState = {
  projects: new Map(),
  leases: new Map(),
  tabs: new Map(),
  byTabId: new Map(),
  stopAll: null,
  limits: { ...DEFAULT_TAB_LIMITS },
  rate: { ...DEFAULT_NAVIGATION_RATE },
  policyAdd: [],
  unlocks: new Map(),
  attachedTabIds: new Set(),
};

export function addTab(tab: AgentTab): void {
  state.tabs.set(tab.handle, tab);
  state.byTabId.set(tab.tabId, tab.handle);
  persist();
}

export function dropTab(handle: string): AgentTab | undefined {
  const tab = state.tabs.get(handle);
  if (!tab) return undefined;
  state.tabs.delete(handle);
  if (state.byTabId.get(tab.tabId) === handle) state.byTabId.delete(tab.tabId);
  state.attachedTabIds.delete(tab.tabId);
  persist();
  return tab;
}

export function tabByChromeId(tabId: number): AgentTab | undefined {
  const handle = state.byTabId.get(tabId);
  return handle === undefined ? undefined : state.tabs.get(handle);
}

export function tabsOfProject(projectKey: string): AgentTab[] {
  return [...state.tabs.values()].filter((tab) => tab.projectKey === projectKey);
}

export function tabsOfLease(leaseId: string): AgentTab[] {
  return [...state.tabs.values()].filter((tab) => tab.leaseId === leaseId);
}

export function projectOfGroup(groupId: number): Project | undefined {
  for (const project of state.projects.values()) if (project.groupId === groupId) return project;
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// Persistence

const SESSION_KEY = "bb.state";
const REGISTRY_KEY = "bb.registry";
const UNLOCKS_KEY = "bb.unlocks";

let writeScheduled = false;

/** Schedules one write of the whole state at the end of this task. */
export function persist(): void {
  if (writeScheduled) return;
  writeScheduled = true;
  setTimeout(() => {
    writeScheduled = false;
    void writeNow();
  }, 0);
}

async function writeNow(): Promise<void> {
  const registry: { [projectKey: string]: { groupId: number; windowId: number } } = {};
  for (const project of state.projects.values()) {
    if (project.groupId !== null && project.windowId !== null)
      registry[project.projectKey] = { groupId: project.groupId, windowId: project.windowId };
  }
  await Promise.all([
    chrome.storage.session.set({
      [SESSION_KEY]: {
        projects: [...state.projects.values()],
        leases: [...state.leases.values()],
        tabs: [...state.tabs.values()],
        stopAll: state.stopAll,
        limits: state.limits,
        rate: state.rate,
        policyAdd: state.policyAdd,
        attachedTabIds: [...state.attachedTabIds],
      },
    }),
    chrome.storage.local.set({ [REGISTRY_KEY]: registry, [UNLOCKS_KEY]: Object.fromEntries(state.unlocks) }),
  ]);
}

/** The group registry of the extension: the only proof that a group is ours. */
export async function readRegistry(): Promise<Map<string, { groupId: number; windowId: number }>> {
  const stored = (await chrome.storage.local.get(REGISTRY_KEY))[REGISTRY_KEY];
  const registry = new Map<string, { groupId: number; windowId: number }>();
  if (!isDynamicRecord(stored)) return registry;
  for (const [projectKey, entry] of Object.entries(stored)) {
    if (isDynamicRecord(entry) && isNumber(entry.groupId) && isNumber(entry.windowId))
      registry.set(projectKey, { groupId: entry.groupId, windowId: entry.windowId });
  }
  return registry;
}

/** At a browser start, no group of before is ours: their ids are new, and the person may have kept them. */
export async function clearRegistry(): Promise<void> {
  await chrome.storage.local.remove(REGISTRY_KEY);
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isString) : []);

/** Loads the state after the worker starts. Values are checked: storage is editable on disk (T3). */
export async function restore(): Promise<void> {
  const [session, local] = await Promise.all([
    chrome.storage.session.get(SESSION_KEY),
    chrome.storage.local.get(UNLOCKS_KEY),
  ]);
  const unlocks = local[UNLOCKS_KEY];
  if (isDynamicRecord(unlocks)) {
    for (const [projectKey, origins] of Object.entries(unlocks)) state.unlocks.set(projectKey, strings(origins));
  }
  const saved = session[SESSION_KEY];
  if (!isDynamicRecord(saved)) return;
  const registry = await readRegistry();
  for (const value of Array.isArray(saved.projects) ? saved.projects : []) {
    const project = readProject(value);
    if (!project) continue;
    // A group id counts only while the registry of this browser run still holds it.
    const registered = registry.get(project.projectKey);
    if (!registered || registered.groupId !== project.groupId) {
      project.groupId = null;
      project.windowId = null;
    }
    state.projects.set(project.projectKey, project);
  }
  for (const value of Array.isArray(saved.leases) ? saved.leases : []) {
    const lease = readLease(value);
    if (lease) state.leases.set(lease.leaseId, lease);
  }
  for (const value of Array.isArray(saved.tabs) ? saved.tabs : []) {
    const tab = readTab(value);
    if (tab) {
      state.tabs.set(tab.handle, tab);
      state.byTabId.set(tab.tabId, tab.handle);
    }
  }
  if (isString(saved.stopAll)) state.stopAll = readStopSource(saved.stopAll);
  if (isDynamicRecord(saved.limits)) {
    const { tabsPerLease, tabsPerProject, tabsTotal } = saved.limits;
    if (isNumber(tabsPerLease) && isNumber(tabsPerProject) && isNumber(tabsTotal))
      state.limits = { tabsPerLease, tabsPerProject, tabsTotal };
  }
  if (isDynamicRecord(saved.rate)) {
    const { perOriginPerMinute, perProjectPerMinute } = saved.rate;
    if (isNumber(perOriginPerMinute) && isNumber(perProjectPerMinute))
      state.rate = { perOriginPerMinute, perProjectPerMinute };
  }
  state.policyAdd = strings(saved.policyAdd);
  for (const tabId of Array.isArray(saved.attachedTabIds) ? saved.attachedTabIds : [])
    if (isNumber(tabId)) state.attachedTabIds.add(tabId);
}

const COLORS: readonly ProjectColor[] = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const readColor = (value: unknown): ProjectColor | null => COLORS.find((color) => color === value) ?? null;
const STOP_SOURCES: readonly StopSource[] = ["popup", "shortcut", "infobar", "group", "app"];
const readStopSource = (value: unknown): StopSource | null => STOP_SOURCES.find((source) => source === value) ?? null;
const numberOrNull = (value: unknown): number | null => (isNumber(value) ? value : null);

function readProject(value: unknown): Project | null {
  if (!isDynamicRecord(value) || !isString(value.projectKey) || !isString(value.title)) return null;
  const color = readColor(value.color);
  if (!color) return null;
  return {
    projectKey: value.projectKey,
    title: value.title,
    color,
    shownColor: readColor(value.shownColor) ?? color,
    groupId: numberOrNull(value.groupId),
    windowId: numberOrNull(value.windowId),
    userTitle: value.userTitle === true,
    shared: value.shared === true,
    pausedBy: readStopSource(value.pausedBy),
    collapsedByExtension: value.collapsedByExtension === true,
    blocked: strings(value.blocked).slice(0, 6),
  };
}

function readLease(value: unknown): Lease | null {
  if (!isDynamicRecord(value)) return null;
  const { leaseId, projectKey, agentLabel, initials, lastCommandAt } = value;
  if (!isString(leaseId) || !isString(projectKey) || !isString(agentLabel) || !isString(initials)) return null;
  return {
    leaseId,
    projectKey,
    agentLabel,
    initials,
    routine: value.routine === true,
    active: value.active === true,
    lastCommandAt: isNumber(lastCommandAt) ? lastCommandAt : 0,
  };
}

function readTab(value: unknown): AgentTab | null {
  if (!isDynamicRecord(value)) return null;
  const { handle, tabId, projectKey, createdBy } = value;
  if (!isString(handle) || !isNumber(tabId) || !isString(projectKey)) return null;
  if (createdBy !== "agent" && createdBy !== "person" && createdBy !== "extension") return null;
  return {
    handle,
    tabId,
    projectKey,
    createdBy,
    leaseId: isString(value.leaseId) ? value.leaseId : null,
    viewed: isBoolean(value.viewed) && value.viewed,
    satelliteOf: isString(value.satelliteOf) ? value.satelliteOf : null,
    quarantined: value.quarantined === true,
    lastCommandAt: isNumber(value.lastCommandAt) ? value.lastCommandAt : 0,
  };
}
