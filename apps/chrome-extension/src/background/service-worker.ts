/**
 * The service worker of the Builders Bot extension. Every listener is added here, at the top level and
 * at once, as Manifest V3 requires: Chrome starts a stopped worker for an event only when the first run
 * of this file added a listener for it. Each listener waits for the state to load before it acts.
 */

import { detach, dropStaleSessions, load, onDebuggerDetach, onDebuggerEvent, setInfobarStop } from "./debugger";
import { loadFloorRules, syncFloorRules } from "./floor";
import { onGroupCreated, onGroupRemoved, onGroupUpdated } from "./groups";
import { connect, connectOnWake, noteEvent, onAlarm, timings, WATCHDOG_ALARM } from "./link";
import { emit, flushEvents } from "./outbox";
import { fromOwnPage, onPageRequest } from "./pages";
import { clearRegistry, noteBrowserStart, restore, state } from "./state";
import { showGlobalState, stopAll } from "./stop";
import { onTabActivated, onTabCreated, onTabRemoved, onTabReplaced, onTabUpdated, scheduleHousekeeping } from "./tabs";

const loaded = (async () => {
  await restore();
  await loadFloorRules();
  await dropStaleSessions();
  await syncFloorRules();
  scheduleHousekeeping();
  await showGlobalState();
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
})();

const whenLoaded =
  <A extends unknown[]>(handler: (...args: A) => void | Promise<void>) =>
  (...args: A): void => {
    noteEvent(handler.name || "listener");
    void loaded.then(() => handler(...args)).catch(() => undefined);
  };

setInfobarStop((source) => void stopAll(source));

const onBrowserStart = whenLoaded(async () => {
  // A new browser run: no group of the last run is ours, whatever its title.
  await clearRegistry();
  connect("start");
});
chrome.runtime.onStartup.addListener(() => {
  // Before the state loads: the carry of the last run is not taken.
  noteBrowserStart();
  onBrowserStart();
});

chrome.runtime.onInstalled.addListener(
  whenLoaded(async (details) => {
    if (details.reason === "install")
      await chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html"), active: true });
    connect("start");
  }),
);

chrome.runtime.onUpdateAvailable.addListener(
  whenLoaded(async () => {
    // Wait until no command is in Chrome (10 min at most), then reload into the new version.
    const until = Date.now() + 10 * 60_000;
    while (load().inFlight > 0 && Date.now() < until) await new Promise((done) => setTimeout(done, 1_000));
    // The debugger leaves each tab, and each tab can be discarded again; the next version takes the
    // tabs back from the carry with the same handles.
    await Promise.all([...state.attachedTabIds].map((tabId) => detach(tabId, "lease_end")));
    emit("ext.updating", {});
    await flushEvents();
    chrome.runtime.reload();
  }),
);

chrome.alarms.onAlarm.addListener(whenLoaded((alarm) => onAlarm(alarm.name)));
chrome.windows.onFocusChanged.addListener(whenLoaded(() => connect("event")));
chrome.commands.onCommand.addListener(
  whenLoaded(async (command) => {
    if (command === "stop-all") await stopAll("shortcut");
  }),
);

chrome.tabs.onCreated.addListener(whenLoaded(onTabCreated));
chrome.tabs.onUpdated.addListener(whenLoaded(onTabUpdated));
chrome.tabs.onRemoved.addListener(whenLoaded(onTabRemoved));
chrome.tabs.onActivated.addListener(whenLoaded(onTabActivated));
chrome.tabs.onReplaced.addListener(whenLoaded(onTabReplaced));
chrome.tabGroups.onCreated.addListener(whenLoaded(onGroupCreated));
chrome.tabGroups.onUpdated.addListener(whenLoaded(onGroupUpdated));
chrome.tabGroups.onRemoved.addListener(whenLoaded(onGroupRemoved));
chrome.debugger.onEvent.addListener(whenLoaded(onDebuggerEvent));
chrome.debugger.onDetach.addListener(whenLoaded(onDebuggerDetach));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!fromOwnPage(sender)) return undefined;
  void loaded
    .then(() => onPageRequest(message))
    .then(sendResponse, () => sendResponse({ kind: "error", message: "the extension failed" }));
  return true;
});

// A worker that starts for any other reason connects when the wait of its retry step has passed.
void loaded.then(() => connectOnWake());

// The E2E build lets the test read when this worker started and what woke it. No other build has it.
if (__BB_CHANNEL__ === "e2e") Object.assign(globalThis, { buildersBotTimings: timings });
