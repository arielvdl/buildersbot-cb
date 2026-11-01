import { createEffect, createSignal, untrack } from "solid-js";
import { appPort } from "../../app-port";
import { createSimpleContext } from "../../simple-context";
import { useServers } from "../servers/servers-context";
import { createLoadController, type LoadPort } from "./load-controller";

/**
 * The load of this computer, one reading for the window. The ring of the rail and its panel, the Team
 * view and the Fiscal page of Settings read and change the same snapshot through the same calls, so a
 * switch that changes in one place shows in the others at once.
 *
 * `railShown` is true while the rail shows the ring: the load is that of this computer, so a joined
 * server does not show it. A page that shows the load for another reason, such as Settings, calls
 * `watch`: the store then reads the load while that page is on screen.
 */
export function createLoadStore(port: () => LoadPort, railShown: () => boolean) {
  const [watchers, setWatchers] = createSignal(0);
  const controller = createLoadController(port, () => railShown() || watchers() > 0);
  const [panelOpen, setPanelOpenSignal] = createSignal(false);
  createEffect(railShown, (shown, was) => {
    if (shown) {
      // The ring comes back, such as on a switch back from a joined server: read at once, so that it
      // does not show the load of the moment the person left until the next timed read.
      if (was === false) void controller.read();
      return;
    }
    // A ring that leaves the rail takes its open panel with it: it must not open by itself when it
    // comes back.
    if (!untrack(panelOpen)) return;
    setPanelOpenSignal(false);
    controller.setOpen(false);
  });
  return {
    ...controller,
    railShown,
    /** Whether the panel of the ring is open. A page outside the rail can open it. */
    panelOpen,
    /** Opens or closes the panel of the ring. The load reads faster while the panel is open. */
    setPanelOpen(open: boolean) {
      setPanelOpenSignal(open);
      controller.setOpen(open);
    },
    /**
     * Reads the load while `visible` is true, also when the rail does not show it. Call it once where
     * the page is made; it stops when the page is gone.
     */
    watch(visible: () => boolean) {
      createEffect(visible, (shown) => {
        if (!shown) return;
        setWatchers((count) => count + 1);
        void controller.read();
        return () => setWatchers((count) => count - 1);
      });
    },
  };
}

export type LoadStore = ReturnType<typeof createLoadStore>;

const context = createSimpleContext({
  name: "Load",
  init: (): LoadStore => {
    const { activeServer } = useServers();
    return createLoadStore(appPort, () => activeServer()?.kind === "local");
  },
});

export const LoadProvider = context.provider;
export const useLoad = context.use;
