/**
 * Requests from the popup and the welcome page. Only pages of this extension may send them, and each
 * request is checked against a closed list. Opening a floor origin for a project needs a choice among
 * three origins at random places, so a click by chance or by a robot at a fixed place opens nothing.
 */

import { hostMatches, SITE_FLOOR } from "@openbot/contracts/chrome-bridge/site-floor";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { PageRequest, PageResponse, ProjectView, StatusView } from "../shared/messages";
import { syncFloorRules } from "./floor";
import { choosePairing, connect, disconnectByPerson, linkInfo, openPairingByPerson } from "./link";
import { emit } from "./outbox";
import { persist, state, tabsOfProject } from "./state";
import { linkState, pauseProject, resumeAll, resumeProject, stopAll } from "./stop";
import { originOf } from "./util";

const COLOR_HEX: Readonly<{ [color: string]: string }> = {
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#e37400",
  green: "#188038",
  pink: "#d01884",
  purple: "#9334e6",
  cyan: "#007b83",
  orange: "#e8710a",
};

let platform = "";
void chrome.runtime.getPlatformInfo().then((info) => {
  platform = info.os;
});

/** Whether a message comes from a page of this extension, not a content script or another extension. */
export function fromOwnPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && (sender.url ?? "").startsWith(chrome.runtime.getURL(""));
}

function readRequest(value: unknown): PageRequest | null {
  if (!isDynamicRecord(value) || !isString(value.kind)) return null;
  const { kind, projectKey, origin, choice, index } = value;
  switch (kind) {
    case "status":
    case "connect":
    case "pair.decline":
    case "disconnect":
    case "stop.all":
    case "resume.all":
      return { kind };
    case "pair.choose":
      return isNumber(index) ? { kind, index } : null;
    case "project.pause":
    case "project.resume":
      return isString(projectKey) ? { kind, projectKey } : null;
    case "floor.options":
    case "floor.relock":
      return isString(projectKey) && isString(origin) ? { kind, projectKey, origin } : null;
    case "floor.unlock":
      return isString(projectKey) && isString(origin) && isString(choice) ? { kind, projectKey, origin, choice } : null;
    default:
      return null;
  }
}

function status(): StatusView {
  const info = linkInfo();
  const projects: ProjectView[] = [...state.projects.values()].map((project) => {
    const leases = [...state.leases.values()].filter((lease) => lease.projectKey === project.projectKey);
    return {
      projectKey: project.projectKey,
      title: project.title,
      color: COLOR_HEX[project.shownColor] ?? "#5f6368",
      paused: project.pausedBy !== null || project.shared,
      pausedByPerson: project.pausedBy !== null && project.pausedBy !== "app",
      tabs: tabsOfProject(project.projectKey).length,
      agents: leases.map((lease) => ({ label: lease.agentLabel, initials: lease.initials, active: lease.active })),
      blocked: project.blocked.filter((origin) => !(state.unlocks.get(project.projectKey) ?? []).includes(origin)),
      unlocked: state.unlocks.get(project.projectKey) ?? [],
    };
  });
  return {
    link: linkState(),
    stopped: state.stopAll !== null,
    projects,
    pairing: info.pairing,
    heldForGesture: info.heldForGesture,
    platform,
  };
}

/** Two other floor sites as decoys, and the right one, at random places. */
function floorOptions(origin: string): string[] {
  const host = (() => {
    try {
      return new URL(origin).hostname;
    } catch {
      return "";
    }
  })();
  // A decoy is another site of the floor, never the blocked site's own domain.
  const pool = SITE_FLOOR.filter((entry) => !hostMatches(host, entry.domain)).map((entry) => `https://${entry.domain}`);
  const pick = () => pool.splice((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % pool.length, 1)[0] ?? "";
  const options = [pick(), pick()];
  options.splice((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 3, 0, origin);
  return options;
}

const offered = new Map<string, string[]>();

export async function onPageRequest(value: unknown): Promise<PageResponse> {
  const request = readRequest(value);
  if (!request) return { kind: "error", message: "unknown request" };
  switch (request.kind) {
    case "status":
      return { kind: "status", status: status() };
    case "connect":
      connect("gesture");
      await openPairingByPerson();
      return { kind: "ok" };
    case "pair.choose":
      return { kind: "pairing", result: await choosePairing(request.index) };
    case "pair.decline":
      return { kind: "pairing", result: await choosePairing(null) };
    case "disconnect":
      await disconnectByPerson();
      return { kind: "ok" };
    case "stop.all":
      await stopAll("popup");
      return { kind: "ok" };
    case "resume.all":
      await resumeAll();
      return { kind: "ok" };
    case "project.pause":
      await pauseProject(request.projectKey, "popup");
      return { kind: "ok" };
    case "project.resume":
      await resumeProject(request.projectKey, "popup");
      return { kind: "ok" };
    case "floor.options": {
      const origin = originOf(request.origin);
      const project = state.projects.get(request.projectKey);
      if (!origin || !project?.blocked.includes(origin)) return { kind: "error", message: "not a blocked site" };
      const options = floorOptions(origin);
      offered.set(`${request.projectKey} ${origin}`, options);
      return { kind: "floor.options", options };
    }
    case "floor.unlock": {
      const origin = originOf(request.origin);
      const key = `${request.projectKey} ${origin}`;
      const options = offered.get(key);
      offered.delete(key);
      if (!origin || !options?.includes(request.choice) || request.choice !== origin)
        return { kind: "error", message: "the choice did not match" };
      const list = state.unlocks.get(request.projectKey) ?? [];
      if (!list.includes(origin)) state.unlocks.set(request.projectKey, [...list, origin]);
      persist();
      await syncFloorRules();
      emit("user.unblock", { projectKey: request.projectKey, origin });
      return { kind: "ok" };
    }
    case "floor.relock": {
      const list = state.unlocks.get(request.projectKey) ?? [];
      state.unlocks.set(
        request.projectKey,
        list.filter((origin) => origin !== request.origin),
      );
      persist();
      await syncFloorRules();
      return { kind: "ok" };
    }
  }
}
