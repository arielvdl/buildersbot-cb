import type {
  AgentLimitPreference,
  AutoRecoveryPreference,
  LoadLanePreference,
  LoadSnapshot,
  RunningWork,
  StoppedWork,
  TaskWatchPreference,
} from "@openbot/contracts/ipc";
import { createSignal, onSettled } from "solid-js";
import type { AppPort } from "../../app-port";

/** How often the window reads the load while the panel is closed, and while it is open. */
export const LOAD_POLL_MS = 15_000;
export const LOAD_POLL_OPEN_MS = 3_000;

type LoadPort = Pick<
  AppPort,
  | "getLoad"
  | "setLoadLane"
  | "runChannelNow"
  | "stopWork"
  | "resumeStoppedWork"
  | "reassignStoppedWork"
  | "setAutoRecovery"
  | "setTaskWatch"
  | "setAgentLimit"
>;

/**
 * The load of this computer for the rail. It reads on a timer, faster while the panel is open, and
 * keeps the last reading when a read fails: a ring that went blank on one slow answer would look
 * like the load fell to nothing. Only the answer of the newest request is used, so a read that was
 * slow cannot put an older lane over the one the user just chose.
 */
export function createLoadController(port: () => LoadPort, enabled: () => boolean) {
  const [snapshot, setSnapshot] = createSignal<LoadSnapshot | null>(null);
  let open = false;
  let latest = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Runs `request` and shows its answer, unless a newer request has started since. */
  async function apply(request: () => Promise<LoadSnapshot>): Promise<void> {
    const id = ++latest;
    try {
      const next = await request();
      if (!disposed && id === latest) setSnapshot(next);
    } catch {
      // The next read tries again. The last reading stays.
    }
  }

  async function refresh(): Promise<void> {
    if (enabled()) await apply(() => port().getLoad());
  }

  function schedule() {
    if (disposed) return;
    timer = setTimeout(
      async () => {
        await refresh();
        schedule();
      },
      open ? LOAD_POLL_OPEN_MS : LOAD_POLL_MS,
    );
  }

  onSettled(() => {
    void refresh();
    schedule();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  });

  return {
    snapshot,
    refresh,
    /** The panel opened or closed. Opening reads at once. */
    setOpen(next: boolean) {
      open = next;
      if (next) void refresh();
    },
    async setLane(preference: LoadLanePreference): Promise<void> {
      const current = snapshot();
      // The switch and the order answer at once, and the host's answer replaces them.
      if (current) setSnapshot({ ...current, lane: { ...current.lane, ...preference } });
      await apply(() => port().setLoadLane(preference));
      // A refused change shows the host's lane again, not the one that was drawn.
      if (snapshot()?.lane.enabled !== preference.enabled) await refresh();
    },
    async runNow(channelId: string): Promise<void> {
      await apply(() => port().runChannelNow({ channelId }));
    },
    async stop(work: RunningWork): Promise<void> {
      await apply(() =>
        port().stopWork({ turnId: work.turnId, agentId: work.agentId, channelId: work.channelId, taskId: work.taskId }),
      );
    },
    async resumeAll(): Promise<void> {
      await apply(() => port().resumeStoppedWork({ all: true }));
    },
    async resume(work: StoppedWork): Promise<void> {
      await apply(() => port().resumeStoppedWork({ items: [{ channelId: work.channelId, taskId: work.taskId }] }));
    },
    async reassign(work: StoppedWork, recipientAgentId: string): Promise<void> {
      await apply(() =>
        port().reassignStoppedWork({ channelId: work.channelId, taskId: work.taskId, recipientAgentId }),
      );
    },
    async setAgentLimit(preference: AgentLimitPreference): Promise<void> {
      const current = snapshot();
      // The switch and the number answer at once, and the host's answer replaces them.
      if (current) setSnapshot({ ...current, agentLimit: { ...preference } });
      await apply(() => port().setAgentLimit(preference));
      if (snapshot()?.agentLimit.enabled !== preference.enabled) await refresh();
    },
    async setRecovery(preference: AutoRecoveryPreference): Promise<void> {
      const current = snapshot();
      // The switch and the number answer at once, and the host's answer replaces them.
      if (current) setSnapshot({ ...current, recovery: { ...current.recovery, ...preference } });
      await apply(() => port().setAutoRecovery(preference));
      if (snapshot()?.recovery.enabled !== preference.enabled) await refresh();
    },
    async setTaskWatch(preference: TaskWatchPreference): Promise<void> {
      const current = snapshot();
      // The switch and the number answer at once, and the host's answer replaces them.
      if (current) setSnapshot({ ...current, taskWatch: { ...current.taskWatch, ...preference } });
      await apply(() => port().setTaskWatch(preference));
      if (snapshot()?.taskWatch.enabled !== preference.enabled) await refresh();
    },
  };
}
