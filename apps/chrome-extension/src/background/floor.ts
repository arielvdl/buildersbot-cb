/**
 * The site floor in the extension (DESIGN §6.5, §7 item 9): checked on each URL that an agent tab
 * loads, on each frame target, and before the request leaves through a `declarativeNetRequest` session
 * rule that covers only the tabs of the project groups. The app can add blocks (`policyAdd`); only the
 * person, in the popup, can open one origin for one project.
 */

import {
  type FloorDecision,
  floorHost,
  floorRequestDomains,
  siteFloorDecision,
} from "@openbot/contracts/chrome-bridge/site-floor";
import { state } from "./state";

export function floorDecision(url: string, projectKey: string, subframe = false): FloorDecision {
  return siteFloorDecision(url, {
    added: state.policyAdd,
    unlocked: state.unlocks.get(projectKey) ?? [],
    subframe,
  });
}

const BLOCK_RULE = 1;
const FIRST_ALLOW_RULE = 1000;
const RESOURCE_TYPES: chrome.declarativeNetRequest.ResourceType[] = ["main_frame", "sub_frame"];

let applying: Promise<void> | null = null;
let again = false;
let appliedIds: number[] = [];

/**
 * Makes the session rules match the agent tabs now, and resolves when Chrome holds them. Calls while
 * a write runs are joined into one more write. A tab must be in the rule before its first navigation.
 */
export function syncFloorRules(): Promise<void> {
  if (applying) {
    again = true;
    return applying;
  }
  applying = (async () => {
    do {
      again = false;
      await writeRules();
    } while (again);
  })().finally(() => {
    applying = null;
  });
  return applying;
}

async function writeRules(): Promise<void> {
  const tabIds = [...state.byTabId.keys()];
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  if (tabIds.length > 0) {
    rules.push({
      id: BLOCK_RULE,
      priority: 1,
      action: { type: "block" },
      condition: { requestDomains: floorRequestDomains(state.policyAdd), resourceTypes: RESOURCE_TYPES, tabIds },
    });
    let next = FIRST_ALLOW_RULE;
    for (const [projectKey, origins] of state.unlocks) {
      const projectTabs = [...state.tabs.values()]
        .filter((tab) => tab.projectKey === projectKey)
        .map((tab) => tab.tabId);
      const hosts = origins.flatMap((origin) => {
        try {
          return [floorHost(new URL(origin).hostname)];
        } catch {
          return [];
        }
      });
      if (projectTabs.length === 0 || hosts.length === 0) continue;
      rules.push({
        id: next,
        priority: 2,
        action: { type: "allow" },
        condition: { requestDomains: hosts, resourceTypes: RESOURCE_TYPES, tabIds: projectTabs },
      });
      next += 1;
    }
  }
  const removeRuleIds = [...new Set([BLOCK_RULE, ...appliedIds])];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: rules });
  appliedIds = rules.map((rule) => rule.id);
}

/** Learns the rule ids of an earlier worker, so the first write replaces them. */
export async function loadFloorRules(): Promise<void> {
  appliedIds = (await chrome.declarativeNetRequest.getSessionRules()).map((rule) => rule.id);
}
