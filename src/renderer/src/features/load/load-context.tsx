import { createEffect, createSignal } from "solid-js";
import { appPort } from "../../app-port";
import { createSimpleContext } from "../../simple-context";
import { useServers } from "../servers/servers-context";
import { createLoadController, type LoadPort } from "./load-controller";

/**
 * The load of this computer, one reading for the window. The ring of the rail, the Team view, and the
 * load page and the Fiscal page of Settings read and change the same snapshot through the same calls,
 * so a switch that changes in one place shows in the others at once.
 *
 * `railShown` is true while the rail shows the ring: the load is that of this computer, so a joined
 * server does not show it. A page that shows the load for another reason, such as Settings, calls
 * `watch`: the store then reads the load while that page is on screen.
 */
export function createLoadStore(port: () => LoadPort, railShown: () => boolean) {
  const [watchers, setWatchers] = createSignal(0);
  const controller = createLoadController(port, () => railShown() || watchers() > 0);
  /** The pages that show the load and want it often, such as the load page of Settings. */
  let fastWatchers = 0;
  createEffect(railShown, (shown, was) => {
    // The ring comes back, such as on a switch back from a joined server: read at once, so that it
    // does not show the load of the moment the person left until the next timed read.
    if (shown && was === false) void controller.read();
  });
  return {
    ...controller,
    railShown,
    /**
     * Reads the load while `visible` is true, also when the rail does not show it. Call it once where
     * the page is made; it stops when the page is gone. `fast` reads it often while it shows, as for a
     * page where the person acts on the work.
     */
    watch(visible: () => boolean, options: { fast?: boolean } = {}) {
      createEffect(visible, (shown) => {
        if (!shown) return;
        setWatchers((count) => count + 1);
        if (options.fast) {
          fastWatchers += 1;
          controller.setOpen(true);
        }
        void controller.read();
        return () => {
          setWatchers((count) => count - 1);
          if (!options.fast) return;
          fastWatchers -= 1;
          if (fastWatchers === 0) controller.setOpen(false);
        };
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
