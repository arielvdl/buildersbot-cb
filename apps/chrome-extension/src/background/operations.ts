/**
 * The extension's answer to each operation of the protocol's closed list. `decodeToExtension` has
 * already decoded the body; each handler resolves to the result body or throws a `BridgeError`.
 */

import { projectGroupTitle } from "@openbot/contracts/chrome-bridge/groups";
import { MAX_TAB_LIMITS, type OperationHandlers } from "@openbot/contracts/chrome-bridge/protocol";
import { floorHost } from "@openbot/contracts/chrome-bridge/site-floor";
import { cdpBatch, cdpSend, runScript, secretFill } from "./commands";
import { syncFloorRules } from "./floor";
import { applyLook, configureProject } from "./groups";
import { persist, state } from "./state";
import { pauseProject, resumeProject, stopAll } from "./stop";
import {
  activateTab,
  closeLease,
  closeTab,
  createTab,
  discardTab,
  ensureGroup,
  historyTab,
  markTabAs,
  openLease,
  releaseGroup,
  requireProject,
  resync,
  zoomOf,
} from "./tabs";
import { BridgeError } from "./util";

const EMPTY = {};
const done = async (work: Promise<unknown> | undefined): Promise<object> => {
  await work;
  return EMPTY;
};

export function operationHandlers(hooks: {
  pairDone: () => Promise<void>;
  ping: () => void;
}): OperationHandlers<Promise<object>> {
  return {
    "session.configure": async (body) => {
      state.limits = {
        tabsPerLease: Math.min(body.limits.tabsPerLease, MAX_TAB_LIMITS.tabsPerLease),
        tabsPerProject: Math.min(body.limits.tabsPerProject, MAX_TAB_LIMITS.tabsPerProject),
        tabsTotal: Math.min(body.limits.tabsTotal, MAX_TAB_LIMITS.tabsTotal),
      };
      state.rate = { ...body.ratePerOrigin };
      // The app can only add blocks: the compiled floor stays whatever this list holds.
      state.policyAdd = [...new Set(body.policyAdd.map(floorHost))];
      for (const project of body.projects) configureProject(project.projectKey, project.title, project.color);
      persist();
      await syncFloorRules();
      return EMPTY;
    },
    "group.ensure": (body) => ensureGroup(body.projectKey, body.title, body.color, body.collapsed),
    "group.update": async (body) => {
      const project = requireProject(body.projectKey);
      configureProject(project.projectKey, body.title ?? project.title, body.color ?? project.color);
      if (body.title !== undefined) project.title = projectGroupTitle(body.title);
      await applyLook(project);
      if (body.collapsed !== undefined && project.groupId !== null)
        await chrome.tabGroups.update(project.groupId, { collapsed: body.collapsed }).catch(() => undefined);
      return EMPTY;
    },
    "group.release": (body) => releaseGroup(body.projectKey),
    "lease.open": async (body) => {
      openLease(body.leaseId, body.projectKey, body.agentLabel, body.initials, body.routine === true);
      return EMPTY;
    },
    "lease.close": (body) => done(closeLease(body.leaseId)),
    "tab.create": (body) => createTab(body.leaseId, body.url),
    "tab.claim": () => Promise.reject(new BridgeError("out_of_scope", "this extension does not take handed tabs yet")),
    "tab.release": () =>
      Promise.reject(new BridgeError("out_of_scope", "this extension does not take handed tabs yet")),
    "tab.close": (body) => closeTab(body.handle),
    "tab.activate": (body) => done(activateTab(body.handle)),
    "tab.history": (body) => done(historyTab(body.handle, body.action)),
    "tab.zoom": (body) => zoomOf(body.handle),
    "tab.discard": (body) => done(discardTab(body.handle)),
    "tab.mark": (body) => done(markTabAs(body.handle, body.agentLabel, body.initials)),
    "cdp.send": (body) => cdpSend(body.leaseId, body.handle, body.method, body.params, body.session),
    "cdp.batch": (body) => cdpBatch(body.leaseId, body.handle, body.commands),
    "script.run": (body) => runScript(body.leaseId, body.handle, body.source, body.args, body.world, body.session),
    "secret.fill": (body) =>
      secretFill(body.leaseId, body.handle, body.expectOrigin, body.nodeId, body.text).then(() => EMPTY),
    "project.pause": (body) => done(pauseProject(body.projectKey, "app")),
    "project.resume": async (body) => {
      if (!(await resumeProject(body.projectKey, "app")))
        throw new BridgeError("paused_by_user", "the person paused this project in Chrome; only the popup resumes it");
      return EMPTY;
    },
    "stop.all": () => done(stopAll("app")),
    resync: (body) => resync(body.tabs),
    ping: async () => {
      hooks.ping();
      return EMPTY;
    },
    "pair.done": () => done(hooks.pairDone()),
  };
}
