/**
 * Agent tabs: leases, handles, limits and the life of each tab (DESIGN §4.5, §5).
 *
 * - A lease is one agent in one thread. Its id stays the same across turns, so `lease.close` at the end
 *   of a turn and `lease.open` at the next keep the same tabs: no new tab and no new group at each turn.
 * - A handle is a 128-bit opaque value. An agent never sees a Chrome tab id, and a handle names only a
 *   tab that the extension put in a project group (or a popup window that such a tab opened).
 * - Limits are counted from the extension's own records, so the count is exact. Past a limit the call
 *   is refused at once with `limit`; nothing waits.
 * - Nothing polls. Deadlines (lease idle, tab discard, group collapse) set one timer, to the nearest one,
 *   and only while there is something to wait for.
 */

import { TAB_TIMING } from "@openbot/contracts/chrome-bridge/protocol";
import { detach, ensureAttached, forgetTab, internalCommand } from "./debugger";
import { floorDecision, syncFloorRules } from "./floor";
import {
  applyLook,
  collapseIfIdle,
  configureProject,
  groupTab,
  isNewGroup,
  isPaused,
  noteActivity,
  noteTabGone,
  placeForNewTab,
  ungroupBeforeClose,
} from "./groups";
import { audit, emit } from "./outbox";
import {
  type AgentTab,
  addTab,
  dropTab,
  type Lease,
  type Project,
  type ProjectColor,
  persist,
  readRegistry,
  state,
  tabByChromeId,
  tabsOfLease,
  tabsOfProject,
} from "./state";
import { markTab } from "./stop";
import { BridgeError, chromeErrorText, MinuteWindow, opaqueId, originOf } from "./util";

const navigations = new MinuteWindow();

export function requireTab(handle: string): AgentTab {
  const tab = state.tabs.get(handle);
  if (!tab) throw new BridgeError("out_of_scope", "no tab has this handle");
  return tab;
}

export function requireProject(projectKey: string): Project {
  const project = state.projects.get(projectKey);
  if (!project) throw new BridgeError("out_of_scope", "the project is not configured");
  return project;
}

/** Refuses while a stop or a pause holds the project. */
export function requireRunning(project: Project): void {
  if (project.shared) throw new BridgeError("group_shared", "the project group is shared: agents are paused");
  if (state.stopAll !== null || project.pausedBy !== null)
    throw new BridgeError("paused_by_user", "the person paused the agents in Chrome");
}

export function requireActiveLease(leaseId: string | null): Lease {
  const lease = leaseId === null ? undefined : state.leases.get(leaseId);
  if (!lease) throw new BridgeError("tab_not_owned", "the tab belongs to no lease");
  if (!lease.active) throw new BridgeError("out_of_scope", "the lease of this tab is not open");
  return lease;
}

/** Counts a navigation of an agent against the limits per origin and per project. */
export function takeNavigation(projectKey: string, url: string): void {
  const origin = originOf(url);
  if (origin && !navigations.take(`o:${origin}`, state.rate.perOriginPerMinute))
    throw new BridgeError("limit", "too many navigations to this site in one minute");
  if (!navigations.take(`p:${projectKey}`, state.rate.perProjectPerMinute))
    throw new BridgeError("limit", "too many navigations in this project in one minute");
  audit.navigations += 1;
}

/**
 * Tabs that a `tab.create` counted but has not made yet. Many calls run at once and each one waits for
 * Chrome, so a slot is taken when the limit is checked, not when the tab exists.
 */
const reserved: { leaseId: string; projectKey: string }[] = [];

function counts(lease: Lease): { lease: number; project: number; total: number } {
  let total = 0;
  let project = 0;
  let ofLease = 0;
  for (const tab of [...state.tabs.values(), ...reserved]) {
    total += 1;
    if (tab.projectKey === lease.projectKey) project += 1;
    if (tab.leaseId === lease.leaseId) ofLease += 1;
  }
  return { lease: ofLease, project, total };
}

/** Takes one slot for a tab about to be made; the returned function gives it back. */
function reserve(lease: Lease): () => void {
  const slot = { leaseId: lease.leaseId, projectKey: lease.projectKey };
  reserved.push(slot);
  return () => {
    const index = reserved.indexOf(slot);
    if (index !== -1) reserved.splice(index, 1);
  };
}

/** The activity of a lease and its tab: it keeps the lease open and the tab out of the discard. */
export function touch(tab: AgentTab, lease: Lease, project: Project): void {
  const now = Date.now();
  lease.lastCommandAt = now;
  tab.lastCommandAt = now;
  noteActivity(project);
  scheduleHousekeeping();
}

// ---------------------------------------------------------------------------------------------------
// Operations

export function openLease(
  leaseId: string,
  projectKey: string,
  agentLabel: string,
  initials: string,
  routine: boolean,
): void {
  requireProject(projectKey);
  const existing = state.leases.get(leaseId);
  if (existing && existing.projectKey !== projectKey)
    throw new BridgeError("out_of_scope", "the lease belongs to another project");
  const lease: Lease = existing ?? {
    leaseId,
    projectKey,
    agentLabel,
    initials,
    routine,
    active: true,
    lastCommandAt: 0,
  };
  lease.agentLabel = agentLabel;
  lease.initials = initials;
  lease.routine = routine;
  lease.active = true;
  lease.lastCommandAt = Date.now();
  state.leases.set(leaseId, lease);
  persist();
  for (const tab of tabsOfLease(leaseId)) void markTab(tab);
  scheduleHousekeeping();
}

/** Ends a lease: its tabs stay open and stay its own, and the debugger leaves them. */
export async function closeLease(leaseId: string): Promise<void> {
  const lease = state.leases.get(leaseId);
  if (!lease) return;
  lease.active = false;
  persist();
  await Promise.all(tabsOfLease(leaseId).map((tab) => detach(tab.tabId, "lease_end")));
}

export async function createTab(leaseId: string, url: string): Promise<{ handle: string }> {
  const lease = requireActiveLease(leaseId);
  const project = requireProject(lease.projectKey);
  requireRunning(project);
  if (url !== "about:blank") {
    const decision = floorDecision(url, project.projectKey);
    if (decision.blocked) throw new BridgeError("site_blocked", `the address is blocked (${decision.rule})`);
    takeNavigation(project.projectKey, url);
  }
  // The blank tab that holds a group made by `group.ensure` is the first tab of the project's agent.
  const placeholder = tabsOfProject(project.projectKey).find((tab) => tab.createdBy === "extension");
  const used = counts(lease);
  const extra = placeholder ? 0 : 1;
  if (used.lease + 1 > state.limits.tabsPerLease)
    throw new BridgeError("limit", `this agent has ${used.lease} tabs open, its limit; close or reuse one`);
  if (used.project + extra > state.limits.tabsPerProject)
    throw new BridgeError("limit", `the project has ${used.project} tabs open, its limit; close or reuse one`);
  if (used.total + extra > state.limits.tabsTotal)
    throw new BridgeError("limit", `agents have ${used.total} tabs open in Chrome, the limit; close or reuse one`);

  const unreserve = placeholder ? () => undefined : reserve(lease);
  let tab: AgentTab;
  try {
    tab = await takeOrMakeTab(project, lease, placeholder);
  } finally {
    unreserve();
  }
  // The floor rule covers the tab before its first request leaves.
  await syncFloorRules();
  touch(tab, lease, project);
  void markTab(tab);
  if (url !== "about:blank") {
    await ensureAttached(tab);
    await internalCommand(tab.tabId, "Page.navigate", { url });
  }
  return { handle: tab.handle };
}

async function takeOrMakeTab(project: Project, lease: Lease, placeholder: AgentTab | undefined): Promise<AgentTab> {
  let tab: AgentTab;
  if (placeholder) {
    placeholder.createdBy = "agent";
    placeholder.leaseId = lease.leaseId;
    tab = placeholder;
    persist();
  } else {
    const place = await placeForNewTab(project);
    const created = await chrome.tabs.create({
      windowId: place.windowId,
      index: place.index,
      url: "about:blank",
      active: false,
    });
    if (created.id === undefined) throw new BridgeError("cdp_error", "Chrome made a tab with no id");
    tab = {
      handle: opaqueId(),
      tabId: created.id,
      projectKey: project.projectKey,
      leaseId: lease.leaseId,
      createdBy: "agent",
      viewed: false,
      satelliteOf: null,
      quarantined: false,
      lastCommandAt: Date.now(),
    };
    addTab(tab);
    try {
      await groupTab(project, created.id, created.windowId);
    } catch (error) {
      dropTab(tab.handle);
      await chrome.tabs.remove(created.id).catch(() => undefined);
      throw new BridgeError("cdp_error", `could not group the tab: ${chromeErrorText(error)}`);
    }
  }
  return tab;
}

/** Closes a tab that an agent made; a tab of the person is only given back. */
export async function closeTab(handle: string): Promise<{ closed: boolean }> {
  const tab = requireTab(handle);
  const project = state.projects.get(tab.projectKey);
  await detach(tab.tabId, "lease_end");
  if (tab.createdBy === "person") {
    dropTab(handle);
    await chrome.tabs.ungroup([tab.tabId]).catch(() => undefined);
    await syncFloorRules();
    return { closed: false };
  }
  if (project) await ungroupBeforeClose(project, tab.tabId);
  dropTab(handle);
  forgetTab(tab.tabId);
  await chrome.tabs.remove(tab.tabId).catch(() => undefined);
  await syncFloorRules();
  return { closed: true };
}

/** Shows a tab to the person after a gesture in the app: the only way a tab becomes active. */
export async function activateTab(handle: string): Promise<void> {
  const tab = requireTab(handle);
  const updated = await chrome.tabs.update(tab.tabId, { active: true });
  await chrome.windows.update(updated.windowId, { focused: true });
  tab.viewed = true;
  persist();
}

export async function historyTab(handle: string, action: "back" | "forward" | "reload"): Promise<void> {
  const tab = requireTab(handle);
  const lease = requireActiveLease(tab.leaseId);
  const project = requireProject(tab.projectKey);
  requireRunning(project);
  const current = await chrome.tabs.get(tab.tabId);
  takeNavigation(project.projectKey, current.url ?? "about:blank");
  touch(tab, lease, project);
  if (action === "back") await chrome.tabs.goBack(tab.tabId);
  else if (action === "forward") await chrome.tabs.goForward(tab.tabId);
  else await chrome.tabs.reload(tab.tabId);
}

export async function zoomOf(handle: string): Promise<{ factor: number }> {
  const tab = requireTab(handle);
  const factor = await chrome.tabs.getZoom(tab.tabId);
  return { factor: Math.min(5, Math.max(0.25, factor)) };
}

export async function discardTab(handle: string): Promise<void> {
  const tab = requireTab(handle);
  await detach(tab.tabId, "memory");
  await chrome.tabs.discard(tab.tabId).catch(() => undefined);
}

export async function markTabAs(handle: string, agentLabel: string, initials: string): Promise<void> {
  const tab = requireTab(handle);
  const lease = tab.leaseId === null ? undefined : state.leases.get(tab.leaseId);
  if (lease) {
    lease.agentLabel = agentLabel;
    lease.initials = initials;
    persist();
  }
  await markTab(tab);
}

export async function ensureGroup(
  projectKey: string,
  title: string | undefined,
  color: ProjectColor | undefined,
  collapsed: boolean | undefined,
): Promise<{ groupId: number; windowId: number }> {
  const known = state.projects.get(projectKey);
  if (!known && title === undefined) throw new BridgeError("out_of_scope", "a new project needs a title");
  const project = configureProject(projectKey, title ?? known?.title ?? "", color ?? known?.color ?? "blue");
  if (project.groupId === null) {
    const total = state.tabs.size;
    if (total + 1 > state.limits.tabsTotal || tabsOfProject(projectKey).length + 1 > state.limits.tabsPerProject)
      throw new BridgeError("limit", "no room for a new group tab");
    const place = await placeForNewTab(project);
    const created = await chrome.tabs.create({ windowId: place.windowId, url: "about:blank", active: false });
    if (created.id === undefined) throw new BridgeError("cdp_error", "Chrome made a tab with no id");
    addTab({
      handle: opaqueId(),
      tabId: created.id,
      projectKey,
      leaseId: null,
      createdBy: "extension",
      viewed: false,
      satelliteOf: null,
      quarantined: false,
      lastCommandAt: Date.now(),
    });
    await groupTab(project, created.id, created.windowId);
    await syncFloorRules();
  } else await applyLook(project);
  if (collapsed !== undefined && project.groupId !== null) {
    const groupId = project.groupId;
    await chrome.tabGroups.update(groupId, { collapsed }).catch(() => undefined);
  }
  if (project.groupId === null || project.windowId === null)
    throw new BridgeError("cdp_error", "the group went away while it was made");
  return { groupId: project.groupId, windowId: project.windowId };
}

/**
 * The safe clean-up of a project (thread archived, agent removed, [Clean up]): agent tabs that the person
 * never looked at close, tabs the person looked at stay open out of the group, the person's tabs go back.
 */
export async function releaseGroup(projectKey: string): Promise<{ closed: number; kept: number }> {
  const project = requireProject(projectKey);
  let closed = 0;
  let kept = 0;
  for (const tab of tabsOfProject(projectKey)) {
    await detach(tab.tabId, "lease_end");
    if (tab.createdBy !== "person" && !tab.viewed) {
      await ungroupBeforeClose(project, tab.tabId);
      dropTab(tab.handle);
      await chrome.tabs.remove(tab.tabId).catch(() => undefined);
      closed += 1;
    } else {
      dropTab(tab.handle);
      await chrome.tabs.ungroup([tab.tabId]).catch(() => undefined);
      kept += 1;
    }
  }
  project.groupId = null;
  project.windowId = null;
  persist();
  await syncFloorRules();
  return { closed, kept };
}

/**
 * After the extension updated or reloaded (its session storage is empty), the app names the tabs it
 * knows. Only a tab still inside a group of the extension's own registry is taken back.
 */
export async function resync(
  entries: readonly { handle: string; tabId: number; groupId: number; projectKey: string; leaseId: string }[],
): Promise<{ adopted: string[]; refused: string[] }> {
  const registry = await readRegistry();
  const adopted: string[] = [];
  const refused: string[] = [];
  for (const entry of entries) {
    const registered = registry.get(entry.projectKey);
    const project = state.projects.get(entry.projectKey);
    let inGroup = false;
    try {
      inGroup = (await chrome.tabs.get(entry.tabId)).groupId === entry.groupId;
    } catch {
      inGroup = false;
    }
    if (!registered || registered.groupId !== entry.groupId || !project || !inGroup || state.tabs.has(entry.handle)) {
      refused.push(entry.handle);
      continue;
    }
    project.groupId = registered.groupId;
    project.windowId = registered.windowId;
    addTab({
      handle: entry.handle,
      tabId: entry.tabId,
      projectKey: entry.projectKey,
      leaseId: entry.leaseId,
      createdBy: "agent",
      viewed: false,
      satelliteOf: null,
      quarantined: false,
      lastCommandAt: Date.now(),
    });
    adopted.push(entry.handle);
  }
  await syncFloorRules();
  return { adopted, refused };
}

// ---------------------------------------------------------------------------------------------------
// Chrome events

const stripFragment = (url: string) => {
  const hash = url.indexOf("#");
  return (hash === -1 ? url : url.slice(0, hash)).slice(0, 8192);
};

export function onTabRemoved(tabId: number, info: { isWindowClosing: boolean }): void {
  const tab = tabByChromeId(tabId);
  forgetTab(tabId);
  if (!tab) return;
  noteTabGone(tab.projectKey);
  dropTab(tab.handle);
  emit("tab.removed", { handle: tab.handle, by: info.isWindowClosing ? "browser" : "person" });
  void syncFloorRules();
}

export function onTabReplaced(addedTabId: number, removedTabId: number): void {
  const tab = tabByChromeId(removedTabId);
  if (!tab) return;
  forgetTab(removedTabId);
  state.byTabId.delete(removedTabId);
  tab.tabId = addedTabId;
  state.byTabId.set(addedTabId, tab.handle);
  persist();
  void syncFloorRules();
}

export function onTabActivated(info: { tabId: number }): void {
  const tab = tabByChromeId(info.tabId);
  if (!tab || tab.viewed) return;
  tab.viewed = true;
  persist();
}

export function onTabUpdated(tabId: number, change: chrome.tabs.ChangeInfo, chromeTab: chrome.tabs.Tab): void {
  const tab = tabByChromeId(tabId);
  if (!tab) return;
  const project = state.projects.get(tab.projectKey);
  if (change.url !== undefined) checkMainFrame(tab, change.url);
  if (
    change.groupId !== undefined &&
    project &&
    tab.satelliteOf === null &&
    change.groupId !== project.groupId &&
    !isNewGroup(change.groupId)
  ) {
    // The person dragged the tab out of the group: the tab is the person's now. A group that Chrome just
    // made is a group dragged to another window (or our own new group); the group events decide that.
    void detach(tabId, "person");
  }
  const update: {
    url?: string;
    title?: string;
    status?: "loading" | "complete" | "unloaded";
    discarded?: boolean;
    frozen?: boolean;
  } = {};
  if (change.url !== undefined) update.url = stripFragment(change.url);
  if (change.title !== undefined) update.title = change.title.slice(0, 512);
  if (change.status !== undefined) update.status = change.status;
  if (change.discarded !== undefined) update.discarded = change.discarded;
  if (change.frozen !== undefined) update.frozen = change.frozen;
  if (Object.keys(update).length > 0) emit("tab.updated", { handle: tab.handle, ...update });
  if (change.status === "complete" && chromeTab.url) checkMainFrame(tab, chromeTab.url);
}

/** A main frame on the floor puts the tab in quarantine: no debugger, only history and close. */
function checkMainFrame(tab: AgentTab, url: string): void {
  const decision = floorDecision(url, tab.projectKey);
  if (decision.blocked && decision.rule !== "scheme" && decision.rule !== "invalid-url") {
    if (tab.quarantined) return;
    tab.quarantined = true;
    persist();
    const origin = originOf(url) ?? "null";
    const project = state.projects.get(tab.projectKey);
    if (project && origin !== "null" && !project.blocked.includes(origin)) {
      project.blocked = [origin, ...project.blocked].slice(0, 6);
      persist();
    }
    audit.blocked += 1;
    void detach(tab.tabId, "site_blocked");
    emit("tab.blocked", { handle: tab.handle, origin, rule: decision.rule });
    return;
  }
  // `chrome://`, `data:` and other schemes are refused at each command, not quarantined: the error page
  // of a blocked request shows such a URL too.
  if (tab.quarantined && !decision.blocked) {
    tab.quarantined = false;
    persist();
  }
}

/** A popup of an agent tab: same owner, same group, or a satellite when Chrome opened a popup window. */
export async function onTabCreated(created: chrome.tabs.Tab): Promise<void> {
  if (created.id === undefined || created.openerTabId === undefined) return;
  const opener = tabByChromeId(created.openerTabId);
  if (!opener || opener.leaseId === null) return;
  const lease = state.leases.get(opener.leaseId);
  const project = state.projects.get(opener.projectKey);
  if (!lease?.active || !project || isPaused(project)) return;
  const url = created.pendingUrl ?? created.url ?? "about:blank";
  if (url !== "about:blank" && url !== "" && floorDecision(url, project.projectKey).blocked) return;
  const used = counts(lease);
  if (
    used.lease + 1 > state.limits.tabsPerLease ||
    used.project + 1 > state.limits.tabsPerProject ||
    used.total + 1 > state.limits.tabsTotal
  )
    return;
  const window = await chrome.windows.get(created.windowId).catch(() => null);
  const satellite = window?.type === "popup";
  const tab: AgentTab = {
    handle: opaqueId(),
    tabId: created.id,
    projectKey: project.projectKey,
    leaseId: lease.leaseId,
    createdBy: "agent",
    viewed: false,
    satelliteOf: satellite ? opener.handle : null,
    quarantined: false,
    lastCommandAt: Date.now(),
  };
  addTab(tab);
  if (!satellite) {
    try {
      await groupTab(project, created.id, created.windowId);
    } catch {
      dropTab(tab.handle);
      return;
    }
  }
  await syncFloorRules();
  void markTab(tab);
  emit("tab.created", { handle: tab.handle, leaseId: lease.leaseId, opener: opener.handle, satellite });
}

// ---------------------------------------------------------------------------------------------------
// Deadlines

let timer: ReturnType<typeof setTimeout> | null = null;
let timerAt = 0;

/** Sets one timer to the nearest deadline of a lease, a tab or a group; none when nothing waits. */
export function scheduleHousekeeping(): void {
  let next = Number.POSITIVE_INFINITY;
  for (const lease of state.leases.values()) {
    if (lease.active) next = Math.min(next, lease.lastCommandAt + TAB_TIMING.leaseIdleMs);
  }
  for (const tab of state.tabs.values()) {
    if (tab.createdBy === "agent" && tab.lastCommandAt > 0)
      next = Math.min(next, tab.lastCommandAt + TAB_TIMING.discardIdleMs);
  }
  for (const project of state.projects.values()) {
    if (project.groupId !== null && !project.collapsedByExtension) {
      const last = Math.max(0, ...tabsOfProject(project.projectKey).map((tab) => tab.lastCommandAt));
      next = Math.min(next, last + TAB_TIMING.collapseIdleMs);
    }
  }
  if (!Number.isFinite(next)) return;
  const at = Math.max(next, Date.now() + 1_000);
  if (timer !== null && timerAt <= at) return;
  if (timer !== null) clearTimeout(timer);
  timerAt = at;
  timer = setTimeout(() => {
    timer = null;
    void housekeeping().finally(scheduleHousekeeping);
  }, at - Date.now());
}

const discarded = new Set<string>();

async function housekeeping(): Promise<void> {
  const now = Date.now();
  for (const lease of state.leases.values()) {
    if (lease.active && now - lease.lastCommandAt >= TAB_TIMING.leaseIdleMs) await closeLease(lease.leaseId);
  }
  for (const tab of [...state.tabs.values()]) {
    const lease = tab.leaseId === null ? undefined : state.leases.get(tab.leaseId);
    if (tab.createdBy !== "agent" || lease?.active || discarded.has(tab.handle)) continue;
    if (tab.lastCommandAt > 0 && now - tab.lastCommandAt >= TAB_TIMING.discardIdleMs) {
      discarded.add(tab.handle);
      await chrome.tabs.discard(tab.tabId).catch(() => undefined);
    }
  }
  for (const project of state.projects.values()) {
    const tabs = tabsOfProject(project.projectKey);
    const busy = [...state.leases.values()].some((lease) => lease.active && lease.projectKey === project.projectKey);
    const last = Math.max(0, ...tabs.map((tab) => tab.lastCommandAt));
    if (!busy && now - last >= TAB_TIMING.collapseIdleMs) await collapseIfIdle(project);
  }
}

export function noteUsed(tab: AgentTab): void {
  discarded.delete(tab.handle);
}
