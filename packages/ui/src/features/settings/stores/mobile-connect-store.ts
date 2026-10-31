import type { MobileConnectedDevice, RemoteNetworkRoute, RemoteNetworkRouteState } from "@openbot/contracts/ipc";
import { createEffect, createSignal, createStore, onCleanup, untrack } from "solid-js";
import { currentText } from "../../../text";

interface MobileConnectStoreProps {
  open: boolean;
  onListMobileConnectedDevices?: () => Promise<MobileConnectedDevice[]>;
  onRevokeMobileConnectedDevice?: (sessionId: string) => Promise<void>;
  onGetRemoteNetworkRoute?: () => Promise<RemoteNetworkRouteState>;
  onSetRemoteNetworkRoute?: (route: RemoteNetworkRoute) => Promise<RemoteNetworkRouteState>;
  /** The address of the web client that a phone installs, on the origin of the account service. */
  onGetMobileWebAppUrl?: () => Promise<string>;
}

interface MobileDeviceList {
  devices: MobileConnectedDevice[];
  error: string | null;
  /** Stays true across a refresh, so the list keeps rendering while `loading` is also true. */
  loaded: boolean;
  loading: boolean;
  revokingSessionId: string | null;
}

/** How devices that connect to this computer send chats and files. */
interface RemoteNetworkRoutePanel {
  /** Null until main answers. */
  current: RemoteNetworkRouteState | null;
  busy: boolean;
  error: string | null;
}

/** The web client that a phone installs from its browser. */
interface MobileWebAppPanel {
  /** Null until main answers. */
  url: string | null;
  error: string | null;
}

interface SettingsMobileConnectPanels {
  devices: MobileDeviceList;
  route: RemoteNetworkRoutePanel;
  webApp: MobileWebAppPanel;
}

/**
 * The Mobile Connect tab: the phones of the earlier phone app, how devices connect, and the address of
 * the web app. No code or link signs a phone in from here any more: a phone opens the web app and
 * signs in there with Cultura Builder.
 */
export function createSettingsMobileConnectStore(props: MobileConnectStoreProps, isActive: () => boolean) {
  const [panels, setPanels] = createStore<SettingsMobileConnectPanels>({
    devices: { devices: [], error: null, loaded: false, loading: false, revokingSessionId: null },
    route: { current: null, busy: false, error: null },
    webApp: { url: null, error: null },
  });
  /** A clock, not panel state: it ticks the device list's "3m ago" labels. */
  const [now, setNow] = createSignal(Date.now());
  const [pageVisible, setPageVisible] = createSignal(document.visibilityState !== "hidden");
  const updatePageVisible = () => setPageVisible(document.visibilityState !== "hidden");
  document.addEventListener("visibilitychange", updatePageVisible);
  onCleanup(() => document.removeEventListener("visibilitychange", updatePageVisible));
  let devicesRequestRevision = 0;

  // The list loads when the tab opens or the window is shown again. Nothing polls it.
  createEffect(
    () => ({
      open: props.open,
      active: isActive(),
      visible: pageVisible(),
      list: props.onListMobileConnectedDevices,
    }),
    ({ open, active, visible, list }) => {
      devicesRequestRevision += 1;
      if (!open || !active || !visible || !list) return;
      void untrack(() => refreshDevices(true));
      return () => {
        devicesRequestRevision += 1;
      };
    },
  );

  // Each visit reads the route again, so a Tailscale that started since the last visit shows.
  createEffect(
    () => ({ open: props.open, active: isActive(), get: props.onGetRemoteNetworkRoute }),
    ({ open, active, get }) => {
      if (!open || !active || !get) return;
      let current = true;
      void untrack(async () => {
        try {
          const route = await get();
          if (!current) return;
          setPanels((state) => {
            state.route.current = route;
            state.route.error = null;
          });
        } catch (error) {
          if (!current) return;
          setPanels((state) => {
            const text = currentText();
            state.route.error = text.errorMessage(error, text.t("settings.mobileConnect.route.error.load"));
          });
        }
      });
      return () => {
        current = false;
      };
    },
  );

  // The address does not change while the app runs, so the first answer stays.
  createEffect(
    () => ({ open: props.open, active: isActive(), get: props.onGetMobileWebAppUrl }),
    ({ open, active, get }) => {
      if (!open || !active || !get || untrack(() => panels.webApp.url)) return;
      let current = true;
      void untrack(async () => {
        try {
          const url = await get();
          if (!current) return;
          setPanels((state) => {
            state.webApp.url = url;
            state.webApp.error = null;
          });
        } catch (error) {
          if (!current) return;
          setPanels((state) => {
            const text = currentText();
            state.webApp.error = text.errorMessage(error, text.t("settings.mobileConnect.webApp.unavailable"));
          });
        }
      });
      return () => {
        current = false;
      };
    },
  );

  async function setRoute(route: RemoteNetworkRoute) {
    const set = props.onSetRemoteNetworkRoute;
    const previous = panels.route.current;
    if (!set || !previous || panels.route.busy || previous.route === route) return;
    setPanels((state) => {
      state.route.current = { ...previous, route };
      state.route.busy = true;
      state.route.error = null;
    });
    try {
      const saved = await set(route);
      setPanels((state) => {
        state.route.current = saved;
      });
    } catch (error) {
      setPanels((state) => {
        const text = currentText();
        state.route.current = previous;
        state.route.error = text.errorMessage(error, text.t("settings.mobileConnect.route.error.save"));
      });
    } finally {
      setPanels((state) => {
        state.route.busy = false;
      });
    }
  }

  async function refreshDevices(showLoading: boolean): Promise<MobileConnectedDevice[] | null> {
    const list = props.onListMobileConnectedDevices;
    if (!list || panels.devices.revokingSessionId) return null;
    const revision = ++devicesRequestRevision;
    if (showLoading)
      setPanels((state) => {
        state.devices.loading = true;
      });
    try {
      const devices = await list();
      if (revision !== devicesRequestRevision) return null;
      setPanels((state) => {
        state.devices.devices = devices;
        state.devices.loaded = true;
        state.devices.error = null;
      });
      setNow(Date.now());
      return devices;
    } catch (error) {
      if (revision !== devicesRequestRevision) return null;
      setPanels((state) => {
        const text = currentText();
        state.devices.error = text.errorMessage(error, text.t("settings.mobileConnect.error.loadDevices"));
      });
      return null;
    } finally {
      if (revision === devicesRequestRevision)
        setPanels((state) => {
          state.devices.loading = false;
        });
    }
  }

  async function revokeDevice(device: MobileConnectedDevice): Promise<void> {
    if (!props.onRevokeMobileConnectedDevice || panels.devices.revokingSessionId) return;
    devicesRequestRevision += 1;
    setPanels((state) => {
      state.devices.loading = false;
      state.devices.revokingSessionId = device.sessionId;
      state.devices.error = null;
    });
    try {
      await props.onRevokeMobileConnectedDevice(device.sessionId);
      setPanels((state) => {
        state.devices.devices = state.devices.devices.filter((candidate) => candidate.sessionId !== device.sessionId);
      });
    } catch (error) {
      setPanels((state) => {
        const text = currentText();
        state.devices.error = text.errorMessage(error, text.t("settings.mobileConnect.error.disconnect"));
      });
    } finally {
      setPanels((state) => {
        state.devices.revokingSessionId = null;
      });
    }
  }

  function deviceTimeLabel(timestamp: number): string {
    const { t, format } = currentText();
    const elapsedSeconds = Math.max(0, Math.floor((now() - timestamp) / 1_000));
    if (elapsedSeconds < 60) return t("settings.mobileConnect.time.justNow");
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) return t("settings.mobileConnect.time.minutesAgo", { minutes: elapsedMinutes });
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) return t("settings.mobileConnect.time.hoursAgo", { hours: elapsedHours });
    return format.date(timestamp, { dateStyle: "medium" });
  }

  return {
    deviceTimeLabel,
    revokeDevice,
    setRoute,
    state: panels,
  };
}

export type SettingsMobileConnectStore = ReturnType<typeof createSettingsMobileConnectStore>;
