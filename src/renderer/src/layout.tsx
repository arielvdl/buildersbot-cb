import type { AppInfo } from "@openbot/contracts/ipc";
import type { ServerView } from "@openbot/ui/features/servers/ServerMenu";
import type { SidebarView } from "@openbot/ui/features/sidebar/sidebar-types";
import { PAGE_RAIL_PINNABLE_PAGES, type PageRailPinnablePage } from "@openbot/ui/features/window/PageRail";
import { createEffect, createMemo, createSignal, onSettled } from "solid-js";
import { z } from "zod";
import { readPanelWidth } from "./components/panel-width-storage";
import {
  CONVERSATION_MIN_WIDTH,
  LEFT_PANEL_COLLAPSED_STORAGE_KEY,
  LEFT_PANEL_DEFAULT,
  LEFT_PANEL_MAX,
  LEFT_PANEL_MIN,
  LEFT_PANEL_STORAGE_KEY,
  MAC_SERVER_RAIL_WIDTH,
  NARROW_SERVER_RAIL_WIDTH,
  RAIL_PINS_STORAGE_KEY,
  SERVER_RAIL_WIDTH,
  SIDEBAR_VIEW_STORAGE_KEY,
} from "./layout-constants";
import { type LeftColumnView, readLeftColumnView, writeLeftColumnView } from "./left-column";
import { usePlatform } from "./platform";
import { createSimpleContext } from "./simple-context";

/**
 * Whether the conversation still has room beside a sidebar of this width. The
 * rail column is part of the arithmetic rather than a style detail, and its
 * width depends on the platform: macOS reserves space for the traffic lights,
 * while the two platforms that draw a standard OS frame narrow the rail on a
 * small window. The section rail and the server rail have the same width. A
 * width of `0` means no rail is drawn: main has not reported the platform yet.
 */
function shouldAutoCompactSidebar(platform: AppInfo["platform"] | undefined, panelWidth: number): boolean {
  const serverRailWidth =
    platform === undefined
      ? 0
      : platform === "darwin"
        ? MAC_SERVER_RAIL_WIDTH
        : window.innerWidth <= 800
          ? NARROW_SERVER_RAIL_WIDTH
          : SERVER_RAIL_WIDTH;
  return window.innerWidth - serverRailWidth - panelWidth < CONVERSATION_MIN_WIDTH;
}

/** The pages in the rail until the user chooses. The others start in the More menu. */
const RAIL_PINNED_BY_DEFAULT: ReadonlySet<PageRailPinnablePage> = new Set(["tasks", "workflows", "usage"]);

// A record, not an object: a page that only another version knows keeps its choice when this version saves.
const railPinChoicesSchema = z.record(z.string(), z.boolean().optional().catch(undefined));

type RailPinChoices = z.infer<typeof railPinChoicesSchema>;

/**
 * The pin choices that the user made on this computer. Only a choice is saved, so a page that a later
 * version adds gets its default. Blocked storage or a damaged value reads as no choice.
 */
function readRailPinChoices(): RailPinChoices {
  try {
    const parsed = railPinChoicesSchema.safeParse(
      JSON.parse(window.localStorage.getItem(RAIL_PINS_STORAGE_KEY) ?? "{}"),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * The width of the workspace sidebar, and the two independent reasons it can be
 * narrow: the user collapsed it, or the window is too small to keep it open.
 *
 * Only the first is persisted. The second is recomputed from the window on every
 * resize and on every platform change, so restoring a wide sidebar into a narrow
 * window compacts it again rather than restoring an unusable layout - and
 * `expandSidebar` clears both, because a user asking for the sidebar back means
 * both reasons at once.
 *
 * The user also chooses what the column beside the page rail shows: the
 * sections of the active server, which is the default, or the servers. With the
 * sections, the menu on the server name lists the servers and switches between
 * them. That choice is persisted on this computer. A compact sidebar hides the
 * server name, so with the sections the user expands the sidebar to switch
 * servers.
 *
 * The user also pins pages to the page rail. Pages that are not pinned are in its More menu. The
 * choice is saved on this computer.
 *
 * The geometry itself is in `layout-constants.ts`; the view imports it directly
 * rather than reading constants through a context.
 */
const Layout = createSimpleContext({
  name: "Layout",
  init: () => {
    const platform = usePlatform();
    const [leftPanelWidth, setLeftPanelWidth] = createSignal(
      readPanelWidth(LEFT_PANEL_STORAGE_KEY, LEFT_PANEL_DEFAULT, LEFT_PANEL_MIN, LEFT_PANEL_MAX),
    );
    const [leftPanelCollapsed, setLeftPanelCollapsed] = createSignal(
      window.localStorage.getItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY) === "true",
    );
    // The column shows the sections unless the user chose the servers. With the sections, the server
    // menu on the server name lists the servers, so `serverView` follows this one choice.
    const [leftColumn, setLeftColumnSignal] = createSignal<LeftColumnView>(readLeftColumnView(window.localStorage));
    const serverView = createMemo<ServerView>(() => (leftColumn() === "servers" ? "rail" : "menu"));
    const [sidebarView, setSidebarViewSignal] = createSignal<SidebarView>(
      window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) === "routines" ? "routines" : "agents",
    );
    const [railPinChoices, setRailPinChoices] = createSignal<RailPinChoices>(readRailPinChoices());
    const railPinned = createMemo(() => {
      const choices = railPinChoices();
      return PAGE_RAIL_PINNABLE_PAGES.filter((page) => choices[page] ?? RAIL_PINNED_BY_DEFAULT.has(page));
    });
    const [leftPanelAutoCompact, setLeftPanelAutoCompact] = createSignal(false);
    const leftPanelCompact = createMemo(() => leftPanelCollapsed() || leftPanelAutoCompact());
    /**
     * Whether the window draws a rail column: the section rail or the server rail. The frame class and
     * the rails need the answer. `appInfo` is null until main answers, and no rail is drawn before then.
     * A window of one chat has no sidebar, so it has no rail column either.
     */
    const railColumnVisible = createMemo(() => platform.appInfo() !== null && platform.chatWindow === null);
    const serverRailVisible = createMemo(() => railColumnVisible() && leftColumn() === "servers");
    const sectionRailVisible = createMemo(() => railColumnVisible() && leftColumn() === "sections");

    function updateResponsiveSidebar(): void {
      setLeftPanelAutoCompact(shouldAutoCompactSidebar(platform.appInfo()?.platform, leftPanelWidth()));
    }

    createEffect(
      () => ({ osPlatform: platform.appInfo()?.platform, panelWidth: leftPanelWidth() }),
      ({ osPlatform, panelWidth }) => {
        setLeftPanelAutoCompact(shouldAutoCompactSidebar(osPlatform, panelWidth));
      },
    );

    onSettled(() => {
      window.addEventListener("resize", updateResponsiveSidebar);
      return () => window.removeEventListener("resize", updateResponsiveSidebar);
    });

    // Another window or browser tab can change the pins.
    function readRailPinsFromStorage(event: StorageEvent): void {
      if (event.key === null || event.key === RAIL_PINS_STORAGE_KEY) setRailPinChoices(readRailPinChoices());
    }

    onSettled(() => {
      window.addEventListener("storage", readRailPinsFromStorage);
      return () => window.removeEventListener("storage", readRailPinsFromStorage);
    });

    function setSidebarCollapsed(collapsed: boolean): void {
      setLeftPanelCollapsed(collapsed);
      window.localStorage.setItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY, String(collapsed));
    }

    function setLeftColumn(view: LeftColumnView): void {
      setLeftColumnSignal(view);
      writeLeftColumnView(view, window.localStorage);
    }

    /** The choice of the server menu: the server rail puts the servers in the column, the menu the sections. */
    function setServerView(view: ServerView): void {
      setLeftColumn(view === "rail" ? "servers" : "sections");
    }

    function setSidebarView(view: SidebarView): void {
      setSidebarViewSignal(view);
      window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view);
    }

    function setRailPinned(page: PageRailPinnablePage, pinned: boolean): void {
      // Start from the saved value, so the choices of another window stay. Blocked storage reads as no choice.
      const choices = { ...railPinChoices(), ...readRailPinChoices(), [page]: pinned };
      setRailPinChoices(choices);
      try {
        window.localStorage.setItem(RAIL_PINS_STORAGE_KEY, JSON.stringify(choices));
      } catch {
        // Blocked or full storage keeps the choice for this window only.
      }
    }

    function expandSidebar(): void {
      setSidebarCollapsed(false);
      setLeftPanelAutoCompact(false);
    }

    return {
      leftPanelWidth,
      setLeftPanelWidth,
      leftPanelCompact,
      setSidebarCollapsed,
      expandSidebar,
      leftColumn,
      setLeftColumn,
      serverView,
      setServerView,
      railColumnVisible,
      serverRailVisible,
      sectionRailVisible,
      sidebarView,
      setSidebarView,
      railPinned,
      setRailPinned,
    };
  },
});

export const LayoutProvider = Layout.provider;
export const useLayout = Layout.use;
