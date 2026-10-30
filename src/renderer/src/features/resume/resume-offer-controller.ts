import type { InterruptedWorkOffer, ResumeInterruptedWorkInput } from "@openbot/contracts/ipc";
import { createStore, onSettled } from "solid-js";
import type { AppPort } from "../../app-port";

export type ResumeOfferPort = Pick<AppPort, "getResumeOffer" | "resumeInterruptedWork" | "dismissResumeOffer">;

interface ResumeOfferState {
  /** The work that the restart stopped. Null closes the modal. */
  offer: InterruptedWorkOffer | null;
  channelIds: string[];
  agentIds: string[];
  pending: boolean;
  /** The text of the failure; empty when only some work did not start. Null when nothing failed. */
  error: string | null;
}

function toggled(ids: readonly string[], id: string, checked: boolean): string[] {
  const rest = ids.filter((item) => item !== id);
  return checked ? [...rest, id] : rest;
}

/**
 * The resume modal of the main window. It reads the offer once, when the window starts: main answers
 * when boot recovery has settled the stopped work. Nothing is selected first, and nothing is sent
 * until the user clicks. A failed request keeps the modal open with the work that did not start.
 */
export function createResumeOfferController(port: () => ResumeOfferPort) {
  const [state, setState] = createStore<ResumeOfferState>({
    offer: null,
    channelIds: [],
    agentIds: [],
    pending: false,
    error: null,
  });
  let disposed = false;
  // Not in the store: a store write shows only after the next flush, and a second click can come first.
  let busy = false;

  onSettled(() => {
    port()
      .getResumeOffer()
      .then((offer) => {
        if (!disposed)
          setState((current) => {
            current.offer = offer;
          });
      })
      // No offer to read means nothing to ask. The work stays stopped, as after Not now.
      .catch(() => {});
    return () => {
      disposed = true;
    };
  });

  async function resume(input: ResumeInterruptedWorkInput): Promise<void> {
    if (busy || !state.offer) return;
    busy = true;
    setState((current) => {
      current.pending = true;
      current.error = null;
    });
    try {
      const result = await port().resumeInterruptedWork(input);
      if (disposed) return;
      setState((current) => {
        current.pending = false;
        current.offer = result.offer;
        current.error = result.failed > 0 ? "" : null;
        // Only the work that is still in the offer can stay selected.
        current.channelIds = current.channelIds.filter((id) => result.offer?.channels.some((item) => item.id === id));
        current.agentIds = current.agentIds.filter((id) => result.offer?.agents.some((item) => item.id === id));
      });
    } catch (error) {
      if (disposed) return;
      setState((current) => {
        current.pending = false;
        current.error = error instanceof Error ? error.message : "";
      });
    } finally {
      busy = false;
    }
  }

  const canResumeSelected = () => !state.pending && (state.channelIds.length > 0 || state.agentIds.length > 0);

  return {
    state,
    open: () => state.offer !== null,
    canResumeSelected,
    toggleChannel(id: string, checked: boolean) {
      setState((current) => {
        current.channelIds = toggled(current.channelIds, id, checked);
      });
    },
    toggleAgent(id: string, checked: boolean) {
      setState((current) => {
        current.agentIds = toggled(current.agentIds, id, checked);
      });
    },
    resumeAll: () => resume({ all: true }),
    // An empty choice would drop all the work, which is what Not now is for.
    resumeSelected: () =>
      canResumeSelected()
        ? resume({ channelIds: [...state.channelIds], agentIds: [...state.agentIds] })
        : Promise.resolve(),
    /** Not now: main drops the offer, so the modal does not show again in this run. */
    async dismiss(): Promise<void> {
      if (busy || !state.offer) return;
      setState((current) => {
        current.offer = null;
      });
      await port()
        .dismissResumeOffer()
        // The offer lives only in memory, so a failed dismiss only means the next window asks again.
        .catch(() => {});
    },
  };
}
