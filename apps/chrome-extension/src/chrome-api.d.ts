/**
 * The part of the Chrome extension API that this extension calls, typed by hand so the package has no
 * dependency. Each declaration follows https://developer.chrome.com/docs/extensions/reference/api. Add a
 * member here only when the code calls it.
 */

declare const __BB_CHANNEL__: "store" | "local" | "dev" | "e2e";

declare namespace chrome {
  export interface ChromeEvent<Listener> {
    addListener(listener: Listener): void;
    removeListener(listener: Listener): void;
  }

  export namespace runtime {
    const id: string;
    const lastError: { message?: string } | undefined;
    function getURL(path: string): string;
    function getManifest(): { version: string };
    function getPlatformInfo(): Promise<{ os: string; arch: string }>;
    function reload(): void;
    /** Asks the store for a newer version; Chrome installs it and fires `onUpdateAvailable`. */
    const requestUpdateCheck: (() => Promise<{ status: string }>) | undefined;
    /** The extension's own open pages (Chrome 116+), without reading other tabs. */
    function getContexts(filter: { contextTypes?: string[]; documentUrls?: string[] }): Promise<{ tabId: number }[]>;
    /** The answer has the type that the receiver of this extension sends back. */
    function sendMessage<Response>(message: object): Promise<Response | undefined>;
    function connectNative(application: string): Port;
    interface MessageSender {
      id?: string;
      url?: string;
      tab?: tabs.Tab;
    }
    interface Port {
      name: string;
      postMessage(message: object): void;
      disconnect(): void;
      onMessage: ChromeEvent<(message: object, port: Port) => void>;
      onDisconnect: ChromeEvent<(port: Port) => void>;
    }
    const onStartup: ChromeEvent<() => void>;
    const onInstalled: ChromeEvent<(details: { reason: string; previousVersion?: string }) => void>;
    const onUpdateAvailable: ChromeEvent<(details: { version: string }) => void>;
    const onMessage: ChromeEvent<
      (message: object, sender: MessageSender, sendResponse: (response: object) => void) => boolean | undefined
    >;
  }

  export namespace storage {
    interface StorageArea {
      get(keys: string | readonly string[]): Promise<{ readonly [key: string]: unknown }>;
      set(items: object): Promise<void>;
      remove(keys: string | readonly string[]): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
  }

  export namespace tabs {
    const TAB_ID_NONE: -1;
    interface Tab {
      id?: number;
      index: number;
      windowId: number;
      groupId: number;
      openerTabId?: number;
      url?: string;
      pendingUrl?: string;
      title?: string;
      status?: "unloaded" | "loading" | "complete";
      active: boolean;
      discarded: boolean;
      frozen?: boolean;
      autoDiscardable: boolean;
    }
    interface ChangeInfo {
      url?: string;
      title?: string;
      status?: "unloaded" | "loading" | "complete";
      groupId?: number;
      discarded?: boolean;
      frozen?: boolean;
    }
    function create(properties: { windowId?: number; url?: string; active?: boolean; index?: number }): Promise<Tab>;
    function get(tabId: number): Promise<Tab>;
    function query(query: {
      active?: boolean;
      windowId?: number;
      groupId?: number;
      lastFocusedWindow?: boolean;
      windowType?: "normal" | "popup";
    }): Promise<Tab[]>;
    function update(
      tabId: number,
      properties: { active?: boolean; autoDiscardable?: boolean; url?: string },
    ): Promise<Tab>;
    function remove(tabIds: number | number[]): Promise<void>;
    function group(options: {
      tabIds: number | number[];
      groupId?: number;
      createProperties?: { windowId?: number };
    }): Promise<number>;
    function ungroup(tabIds: number | number[]): Promise<void>;
    function goBack(tabId: number): Promise<void>;
    function goForward(tabId: number): Promise<void>;
    function reload(tabId: number, properties?: { bypassCache?: boolean }): Promise<void>;
    function getZoom(tabId: number): Promise<number>;
    function discard(tabId: number): Promise<Tab | undefined>;
    const onCreated: ChromeEvent<(tab: Tab) => void>;
    const onUpdated: ChromeEvent<(tabId: number, changeInfo: ChangeInfo, tab: Tab) => void>;
    const onRemoved: ChromeEvent<(tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void>;
    const onActivated: ChromeEvent<(info: { tabId: number; windowId: number }) => void>;
    const onReplaced: ChromeEvent<(addedTabId: number, removedTabId: number) => void>;
  }

  export namespace tabGroups {
    const TAB_GROUP_ID_NONE: -1;
    type Color = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";
    interface TabGroup {
      id: number;
      windowId: number;
      title?: string;
      color: Color;
      collapsed: boolean;
      shared?: boolean;
    }
    function get(groupId: number): Promise<TabGroup>;
    function query(query: { windowId?: number }): Promise<TabGroup[]>;
    function update(
      groupId: number,
      properties: { title?: string; color?: Color; collapsed?: boolean },
    ): Promise<TabGroup>;
    const onCreated: ChromeEvent<(group: TabGroup) => void>;
    const onUpdated: ChromeEvent<(group: TabGroup) => void>;
    const onRemoved: ChromeEvent<(group: TabGroup) => void>;
  }

  export namespace windows {
    const WINDOW_ID_NONE: -1;
    interface Window {
      id?: number;
      type?: "normal" | "popup" | "panel" | "app" | "devtools";
      focused: boolean;
      incognito: boolean;
    }
    function get(windowId: number): Promise<Window>;
    function getLastFocused(options?: { windowTypes?: Array<"normal" | "popup"> }): Promise<Window>;
    function getAll(options?: { windowTypes?: Array<"normal" | "popup"> }): Promise<Window[]>;
    function create(options: { focused?: boolean; url?: string; type?: "normal" }): Promise<Window>;
    function update(windowId: number, properties: { focused?: boolean }): Promise<Window>;
    const onFocusChanged: ChromeEvent<(windowId: number) => void>;
  }

  // `debugger` is a reserved word; @types/chrome declares the namespace the same way.
  export namespace _debugger {
    interface Debuggee {
      tabId?: number;
      sessionId?: string;
    }
    function attach(target: Debuggee, requiredVersion: string): Promise<void>;
    function detach(target: Debuggee): Promise<void>;
    function sendCommand(target: Debuggee, method: string, params?: object): Promise<object | undefined>;
    const onEvent: ChromeEvent<
      (source: Debuggee, method: string, params?: { readonly [key: string]: unknown }) => void
    >;
    const onDetach: ChromeEvent<(source: Debuggee, reason: string) => void>;
  }

  export { _debugger as debugger };

  export namespace declarativeNetRequest {
    type ResourceType = "main_frame" | "sub_frame";
    interface Rule {
      id: number;
      priority: number;
      action: { type: "block" | "allow" | "allowAllRequests" };
      condition: {
        requestDomains?: string[];
        /** `|` anchors the start of the URL; see the declarativeNetRequest URL filter syntax. */
        urlFilter?: string;
        tabIds?: number[];
        resourceTypes?: ResourceType[];
      };
    }
    function updateSessionRules(options: { removeRuleIds?: number[]; addRules?: Rule[] }): Promise<void>;
    function getSessionRules(): Promise<Rule[]>;
  }

  export namespace alarms {
    interface Alarm {
      name: string;
    }
    function create(name: string, info: { delayInMinutes?: number; periodInMinutes?: number }): Promise<void>;
    function clear(name: string): Promise<boolean>;
    const onAlarm: ChromeEvent<(alarm: Alarm) => void>;
  }

  export namespace action {
    function setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
    function setTitle(details: { title: string; tabId?: number }): Promise<void>;
  }

  export namespace commands {
    const onCommand: ChromeEvent<(command: string) => void>;
  }

  export namespace i18n {
    function getMessage(name: string, substitutions?: string | string[]): string;
  }
}
