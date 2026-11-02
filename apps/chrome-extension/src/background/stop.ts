/**
 * Stops and pauses (DESIGN §5.8), and the badge that tells the person which agent drives a tab.
 *
 * A stop that starts in Chrome (popup, shortcut, the debugging bar, closing the group) ends only with a
 * gesture in Chrome: [Resume] in the popup. The app can undo only what the app started.
 */

import type { TabGroupColor } from "@openbot/contracts/chrome-bridge/groups";
import { t } from "../shared/text";
import { detach } from "./debugger";
import { applyLook, setPersonStop } from "./groups";
import { audit, emit } from "./outbox";
import { type AgentTab, persist, type StopSource, state, tabsOfProject } from "./state";

const COLOR_HEX: Readonly<{ [color in TabGroupColor]: string }> = {
  grey: "#5f6368",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#e37400",
  green: "#188038",
  pink: "#d01884",
  purple: "#9334e6",
  cyan: "#007b83",
  orange: "#e8710a",
};

/** Every source but the app: those stops end only with [Resume] in the popup. */
const PERSON_SOURCES: readonly StopSource[] = ["popup", "shortcut", "infobar", "group"];

export async function stopAll(source: StopSource): Promise<void> {
  const already = state.stopAll !== null;
  const reason = source === "infobar" ? "canceled_by_user" : "person";
  // The "Cancel" of the debugging bar detaches every tab, one event each: the first one stops all, and
  // the others only detach what is left, with no new event, group edit or badge.
  if (already && state.stopAll === source) {
    await Promise.all([...state.attachedTabIds].map((tabId) => detach(tabId, reason)));
    return;
  }
  // A stop of the person wins over a stop of the app: only the popup can end it then.
  if (!already || PERSON_SOURCES.includes(source)) state.stopAll = source;
  persist();
  audit.stops += 1;
  await Promise.all([...state.attachedTabIds].map((tabId) => detach(tabId, reason)));
  await Promise.all(
    [...state.projects.values()].filter((project) => project.groupId !== null).map((project) => applyLook(project)),
  );
  if (source !== "app") emit("user.stop", { scope: "all", source: personSource(source) });
  await showGlobalState();
}

/** [Resume] in the popup: ends every stop, wherever it started. */
export async function resumeAll(): Promise<void> {
  state.stopAll = null;
  for (const project of state.projects.values()) {
    if (project.pausedBy !== null) emit("user.resume", { source: "popup", projectKey: project.projectKey });
    project.pausedBy = null;
  }
  persist();
  emit("user.resume", { source: "popup" });
  await Promise.all([...state.projects.values()].map((project) => applyLook(project)));
  await showGlobalState();
}

export async function pauseProject(projectKey: string, source: StopSource): Promise<void> {
  const project = state.projects.get(projectKey);
  if (!project) return;
  if (project.pausedBy === null || PERSON_SOURCES.includes(source)) project.pausedBy = source;
  persist();
  await Promise.all(
    tabsOfProject(projectKey)
      .filter((tab) => state.attachedTabIds.has(tab.tabId))
      .map((tab) => detach(tab.tabId, "person")),
  );
  await applyLook(project);
  if (source !== "app") emit("user.stop", { scope: "project", source: personSource(source), projectKey });
}

/** Ends a pause. The app (`project.resume`) ends only a pause that the app started. */
export async function resumeProject(projectKey: string, by: "app" | "popup"): Promise<boolean> {
  const project = state.projects.get(projectKey);
  if (!project || project.pausedBy === null) return true;
  if (by === "app" && project.pausedBy !== "app") return false;
  project.pausedBy = null;
  persist();
  await applyLook(project);
  if (by === "popup") emit("user.resume", { source: "popup", projectKey });
  return true;
}

function personSource(source: StopSource): "popup" | "shortcut" | "infobar" | "group" {
  return source === "app" ? "popup" : source;
}

setPersonStop((projectKey, source) => void pauseProject(projectKey, source));

// ---------------------------------------------------------------------------------------------------
// Badges

/** The badge of one agent tab: the agent's initials in the project's color, and who drives it. */
export async function markTab(tab: AgentTab): Promise<void> {
  const lease = tab.leaseId === null ? undefined : state.leases.get(tab.leaseId);
  const project = state.projects.get(tab.projectKey);
  if (!lease || !project) return;
  const color = state.stopAll !== null || project.pausedBy !== null ? "grey" : project.shownColor;
  await Promise.all([
    chrome.action.setBadgeText({ tabId: tab.tabId, text: lease.initials.slice(0, 3) }),
    chrome.action.setBadgeBackgroundColor({ tabId: tab.tabId, color: COLOR_HEX[color] }),
    chrome.action.setTitle({
      tabId: tab.tabId,
      title: t("chromeExtension.badge.controlledBy", [lease.agentLabel, project.title]),
    }),
  ]).catch(() => undefined);
}

export type LinkState = "connected" | "app-offline" | "not-paired" | "no-host" | "connecting";
let link: LinkState = "connecting";

export function setLinkState(next: LinkState): void {
  link = next;
  void showGlobalState();
}

export function linkState(): LinkState {
  return link;
}

/** The badge of the toolbar icon: empty when all is well, a sign otherwise. */
export async function showGlobalState(): Promise<void> {
  const stopped = state.stopAll !== null;
  const text = stopped ? "■" : link === "connected" ? "" : "!";
  const color = stopped ? COLOR_HEX.red : link === "connected" ? COLOR_HEX.green : COLOR_HEX.grey;
  await Promise.all([chrome.action.setBadgeText({ text }), chrome.action.setBadgeBackgroundColor({ color })]).catch(
    () => undefined,
  );
}
