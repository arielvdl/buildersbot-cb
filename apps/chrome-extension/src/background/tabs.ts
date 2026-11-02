/**
 * Agent tabs: leases, handles, limits and the life of each tab (DESIGN §4.5, §5).
 *
 * - A lease is one agent in one thread. Its id stays the same across turns, so `lease.close` at the end
 *   of a turn and `lease.open` at the next keep the same tabs: no new tab and no new group at each turn.
 * - A handle is a 128-bit opaque value. An agent never sees a Chrome tab id, and a handle names only a
 *   tab that the extension put in a project group (or a popup window that such a tab opened).
 * - Limits are counted from the extension's own records, so the count is exact. Past the limit of a
 *   project or of all agents, the oldest tab that an agent made and nobody looked at, of a lease that
 *   is not open, closes first; when there is none, the call is refused at once with `limit`.
 * - Tabs that agents left are cleaned up: a blank one of a closed lease closes after 10 minutes; a tab
 *   with content is discarded (its memory goes) unless the person looked at it, and it loads again at
 *   the next command.
 * - A tab that the person drags out of the group is the person's: it leaves the lease at once.
 * - Nothing polls. Deadlines (lease idle, tab discard, blank close, group collapse) set one timer, to
 *   the nearest one that still has work, and only while there is something to wait for.
 */

import { TAB_TIMING } from "@openbot/contracts/chrome-bridge/protocol";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { detach, ensureAttached, forgetTab, internalCommand, setMainFrameCheck } from "./debugger";
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
import { forgetSecrets } from "./secrets";
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

/** Chrome says, now, that the tab is in its project's group (a satellite: its opener is). */
export async function requireInGroup(chromeTab: chrome.tabs.Tab, tab: AgentTab, project: Project): Promise<void> {
  const groupTabId = tab.satelliteOf === null ? null : (state.tabs.get(tab.satelliteOf)?.tabId ?? -1);
  const groupId =
    groupTabId === null
      ? chromeTab.groupId
      : await chrome.tabs.get(groupTabId).then(
          (parent) => parent.groupId,
          () => -2,
        );
  if (project.groupId === null || groupId !== project.groupId)
    throw new BridgeError("out_of_scope", "the person took the tab out of the project group");
}

/** The current Chrome tab of an agent tab that is still in its group. */
async function inGroupNow(tab: AgentTab): Promise<chrome.tabs.Tab> {
  const project = requireProject(tab.projectKey);
  let chromeTab: chrome.tabs.Tab;
  try {
    chromeTab = await chrome.tabs.get(tab.tabId);
  } catch {
    throw new BridgeError("out_of_scope", "the tab is closed");
  }
  await requireInGroup(chromeTab, tab, project);
  return chromeTab;
}

/** Resolves when the tab's load ends, or after `ms`. */
export function waitForComplete(tabId: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (id: number, change: chrome.tabs.ChangeInfo) => {
      if (id === tabId && change.status === "complete") done();
    };
    const timer = setTimeout(() => done(), ms);
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
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
  const extra = placeholder ? 0 : 1;
  let used = counts(lease);
  if (used.lease + 1 > state.limits.tabsPerLease)
    throw new BridgeError("limit", `this agent has ${used.lease} tabs open, its limit; close or reuse one`);
  // Room first comes from tabs that agents left: the oldest unseen one of a closed lease closes.
  while (used.project + extra > state.limits.tabsPerProject || used.total + extra > state.limits.tabsTotal) {
    const evicted = await evictLeftTab(used.project + extra > state.limits.tabsPerProject ? project.projectKey : null);
    if (!evicted) break;
    used = counts(lease);
  }
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
  try {
    // The floor rule covers the tab before its first request leaves.
    await syncFloorRules();
    touch(tab, lease, project);
    void markTab(tab);
    if (url !== "about:blank") {
      await ensureAttached(tab);
      await internalCommand(tab.tabId, "Page.navigate", { url });
    }
  } catch (error) {
    // The app never got this tab's handle: the tab goes, so it does not count against the limits.
    await closeTab(tab.handle).catch(() => undefined);
    throw error;
  }
  return { handle: tab.handle };
}

/**
 * Closes the oldest tab that an agent made, that the person never looked at, of a lease that is not
 * open (or of no lease), in `projectKey` or in any project. False when there is none.
 */
async function evictLeftTab(projectKey: string | null): Promise<boolean> {
  const left = [...state.tabs.values()]
    .filter((tab) => {
      if (tab.createdBy !== "agent" || tab.viewed || tab.satelliteOf !== null) return false;
      if (projectKey !== null && tab.projectKey !== projectKey) return false;
      const lease = tab.leaseId === null ? undefined : state.leases.get(tab.leaseId);
      return lease?.active !== true;
    })
    .sort((a, b) => a.lastCommandAt - b.lastCommandAt)[0];
  if (!left) return false;
  await closeTab(left.handle).catch(() => undefined);
  emit("tab.removed", { handle: left.handle, by: "extension" });
  return !state.tabs.has(left.handle);
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
  forgetSecrets(tab.tabId);
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

/**
 * Back, forward or reload. The entry that back or forward reaches is checked against the floor first:
 * the back-forward cache shows a page again with no request, so the network rule never sees it.
 */
export async function historyTab(handle: string, action: "back" | "forward" | "reload"): Promise<void> {
  const tab = requireTab(handle);
  const lease = requireActiveLease(tab.leaseId);
  const project = requireProject(tab.projectKey);
  requireRunning(project);
  const current = await inGroupNow(tab);
  if (action !== "reload") {
    await ensureAttached(tab);
    const history = await internalCommand(tab.tabId, "Page.getNavigationHistory", {});
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const index = (isNumber(history.currentIndex) ? history.currentIndex : -1) + (action === "back" ? -1 : 1);
    const entry = entries[index];
    const url = isDynamicRecord(entry) && isString(entry.url) ? entry.url : "";
    if (url !== "" && url !== "about:blank" && floorDecision(url, tab.projectKey).blocked)
      throw new BridgeError("site_blocked", "the history entry is a site that agents may not use");
  }
  takeNavigation(project.projectKey, current.url ?? "about:blank");
  touch(tab, lease, project);
  if (action === "back") await chrome.tabs.goBack(tab.tabId);
  else if (action === "forward") await chrome.tabs.goForward(tab.tabId);
  else await chrome.tabs.reload(tab.tabId);
}

export async function zoomOf(handle: string): Promise<{ factor: number }> {
  const tab = requireTab(handle);
  await inGroupNow(tab);
  const factor = await chrome.tabs.getZoom(tab.tabId);
  return { factor: Math.min(5, Math.max(0.25, factor)) };
}

export async function discardTab(handle: string): Promise<void> {
  const tab = requireTab(handle);
  const chromeTab = await inGroupNow(tab);
  // A tab that the person looks at, or looked at in the last 5 minutes, keeps its page.
  if (chromeTab.active || recentlyViewed(tab)) return;
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
  forgetSecrets(tabId);
  activatedAt.delete(tabId);
  if (!tab) return;
  // A window that closes is not the person closing the group: the project is not paused for it.
  if (!info.isWindowClosing) noteTabGone(tab.projectKey);
  discarded.delete(tab.handle);
  waitingBlank.delete(tab.handle);
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

/** When the person last activated each agent tab, so a tab in use is not discarded. */
const activatedAt = new Map<number, number>();

function recentlyViewed(tab: AgentTab): boolean {
  return Date.now() - (activatedAt.get(tab.tabId) ?? 0) < TAB_TIMING.discardIdleMs;
}

export function onTabActivated(info: { tabId: number }): void {
  const tab = tabByChromeId(info.tabId);
  if (!tab) return;
  activatedAt.set(info.tabId, Date.now());
  // The person looks at the group now: a collapse that waited for that can be tried again.
  collapseRefused.delete(tab.projectKey);
  if (tab.viewed) return;
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
    // When the tab is still out of the group a moment later, it leaves the lease and the limits.
    setTimeout(() => void letGoIfTaken(tab.handle), TAKEN_SETTLE_MS);
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

/** How long a tab may stay out of its group (a group being made or moved) before it is the person's. */
const TAKEN_SETTLE_MS = 1_500;

/** A tab that is still out of its project's group: the person took it, so the lease lets it go. */
async function letGoIfTaken(handle: string): Promise<void> {
  const tab = state.tabs.get(handle);
  const project = tab ? state.projects.get(tab.projectKey) : undefined;
  if (!tab || !project || project.groupId === null || tab.satelliteOf !== null) return;
  const chromeTab = await chrome.tabs.get(tab.tabId).catch(() => null);
  if (!chromeTab || chromeTab.groupId === project.groupId) return;
  dropTab(handle);
  forgetTab(tab.tabId);
  discarded.delete(handle);
  emit("tab.removed", { handle, by: "person" });
  void syncFloorRules();
}

/**
 * A main frame on the floor puts the tab in quarantine: no debugger, only history and close. True when
 * the tab is in quarantine.
 */
function checkMainFrame(tab: AgentTab, url: string): boolean {
  const decision = floorDecision(url, tab.projectKey);
  if (decision.blocked && decision.rule !== "scheme" && decision.rule !== "invalid-url") {
    if (tab.quarantined) return true;
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
    return true;
  }
  // `chrome://`, `data:` and other schemes are refused at each command, not quarantined: the error page
  // of a blocked request shows such a URL too.
  if (tab.quarantined && !decision.blocked) {
    tab.quarantined = false;
    persist();
  }
  return tab.quarantined;
}

setMainFrameCheck(checkMainFrame);

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
  // The slot is taken before the wait, as `tab.create` takes it.
  const unreserve = reserve(lease);
  const window = await chrome.windows.get(created.windowId).catch(() => null);
  unreserve();
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

/** Agent tabs that the housekeeping discarded; a command takes a tab out again. */
const discarded = new Set<string>();
/** Blank agent tabs that wait for their close; a command takes a tab out again. */
const waitingBlank = new Set<string>();
/** Projects whose group the person kept open (an active tab in it): no collapse until the person moves. */
const collapseRefused = new Set<string>();

function leaseOf(tab: AgentTab): Lease | undefined {
  return tab.leaseId === null ? undefined : state.leases.get(tab.leaseId);
}

/**
 * The time after which the housekeeping has work for a tab, or Infinity when it has none. A tab that the
 * person looked at keeps its page; a blank tab waits for its close; any other tab is discarded once.
 */
function tabDeadline(tab: AgentTab): number {
  if (tab.createdBy !== "agent" || tab.lastCommandAt <= 0 || tab.viewed) return Number.POSITIVE_INFINITY;
  if (leaseOf(tab)?.active === true) return Number.POSITIVE_INFINITY;
  if (waitingBlank.has(tab.handle)) return tab.lastCommandAt + BLANK_CLOSE_MS;
  if (discarded.has(tab.handle)) return Number.POSITIVE_INFINITY;
  return tab.lastCommandAt + TAB_TIMING.discardIdleMs;
}

/** A blank tab that an agent left: it closes after this long with no command. */
const BLANK_CLOSE_MS = 10 * 60_000;

/**
 * Sets one timer to the nearest deadline that still has work: a lease to close, a tab to discard or
 * close, a group to collapse. None when nothing waits; never a deadline that already passed and has
 * nothing left to do, so the worker is not woken in a loop.
 */
export function scheduleHousekeeping(): void {
  let next = Number.POSITIVE_INFINITY;
  for (const lease of state.leases.values()) {
    if (lease.active) next = Math.min(next, lease.lastCommandAt + TAB_TIMING.leaseIdleMs);
  }
  for (const tab of state.tabs.values()) next = Math.min(next, tabDeadline(tab));
  const busy = new Set([...state.leases.values()].filter((lease) => lease.active).map((lease) => lease.projectKey));
  const lastByProject = new Map<string, number>();
  for (const tab of state.tabs.values())
    lastByProject.set(tab.projectKey, Math.max(lastByProject.get(tab.projectKey) ?? 0, tab.lastCommandAt));
  for (const project of state.projects.values()) {
    if (project.groupId === null || project.collapsedByExtension) continue;
    if (busy.has(project.projectKey) || collapseRefused.has(project.projectKey)) continue;
    next = Math.min(next, (lastByProject.get(project.projectKey) ?? 0) + TAB_TIMING.collapseIdleMs);
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

async function housekeeping(): Promise<void> {
  const now = Date.now();
  for (const lease of state.leases.values()) {
    if (lease.active && now - lease.lastCommandAt >= TAB_TIMING.leaseIdleMs) await closeLease(lease.leaseId);
  }
  for (const tab of [...state.tabs.values()]) {
    if (tabDeadline(tab) > now) continue;
    const chromeTab = await chrome.tabs.get(tab.tabId).catch(() => null);
    if (!chromeTab) continue;
    const blank = (chromeTab.url ?? "") === "about:blank" || (chromeTab.url ?? "") === "";
    if (blank) {
      // Nothing to keep in a blank tab that an agent left: it closes, and the app forgets it.
      if (now - tab.lastCommandAt < BLANK_CLOSE_MS) {
        waitingBlank.add(tab.handle);
        continue;
      }
      waitingBlank.delete(tab.handle);
      await closeTab(tab.handle).catch(() => undefined);
      emit("tab.removed", { handle: tab.handle, by: "extension" });
      continue;
    }
    waitingBlank.delete(tab.handle);
    discarded.add(tab.handle);
    // A tab that the person looks at, or looked at in the last minutes, keeps its page.
    if (chromeTab.active || recentlyViewed(tab)) continue;
    await chrome.tabs.discard(tab.tabId).catch(() => undefined);
  }
  for (const project of state.projects.values()) {
    if (project.groupId === null || project.collapsedByExtension || collapseRefused.has(project.projectKey)) continue;
    const tabs = tabsOfProject(project.projectKey);
    const busy = [...state.leases.values()].some((lease) => lease.active && lease.projectKey === project.projectKey);
    const last = Math.max(0, ...tabs.map((tab) => tab.lastCommandAt));
    if (busy || now - last < TAB_TIMING.collapseIdleMs) continue;
    if (!(await collapseIfIdle(project))) collapseRefused.add(project.projectKey);
  }
  pruneRecords(now);
}

/** Leases closed for an hour with no tab, and projects with nothing left, leave the records. */
function pruneRecords(now: number): void {
  let changed = false;
  for (const lease of [...state.leases.values()]) {
    if (lease.active || now - lease.lastCommandAt < 60 * 60_000 || tabsOfLease(lease.leaseId).length > 0) continue;
    state.leases.delete(lease.leaseId);
    changed = true;
  }
  for (const project of [...state.projects.values()]) {
    const leases = [...state.leases.values()].some((lease) => lease.projectKey === project.projectKey);
    if (project.groupId !== null || project.pausedBy !== null || leases || tabsOfProject(project.projectKey).length > 0)
      continue;
    // The project comes back with the app's next `session.configure`; its floor unlocks stay.
    state.projects.delete(project.projectKey);
    changed = true;
  }
  if (changed) persist();
}

export function noteUsed(tab: AgentTab): void {
  discarded.delete(tab.handle);
  waitingBlank.delete(tab.handle);
  collapseRefused.delete(tab.projectKey);
}
