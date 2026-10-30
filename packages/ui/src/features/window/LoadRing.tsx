import type { LoadLanePreference, LoadSnapshot } from "@openbot/contracts/ipc";
import { Button, Popover, SwitchField } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For, Show } from "solid-js";
import {
  formatGigabytes,
  type LoadTone,
  loadLaneRows,
  loadMemoryPercent,
  loadTone,
  withChannelFirst,
} from "./load-view";

/** Two tracks do not fit here: one ring in the 34px box the usage rings use. */
const RING = { size: 34, stroke: 2.5 };

export interface LoadRailProps {
  /** The last reading, or null before the first one. */
  snapshot: LoadSnapshot | null;
  channelName: (channelId: string) => string;
  /** The panel opened or closed, so the window reads the load faster while it is open. */
  onOpenChange: (open: boolean) => void;
  onLaneChange: (preference: LoadLanePreference) => void;
  onRunNow: (channelId: string) => void;
}

/**
 * The load of this computer as one ring in the rail: the share of memory in use is the arc, and the
 * number inside is how many agents run now. A click opens the panel with the details and the
 * one-channel-at-a-time mode. Nothing opens on hover, because a card under the pointer covers the
 * buttons it sits beside.
 */
export function LoadRing(props: LoadRailProps) {
  const { t } = useText();
  const percent = () => (props.snapshot ? loadMemoryPercent(props.snapshot) : null);
  const tone = (): LoadTone => loadTone(percent());
  const agents = () => props.snapshot?.activeAgents ?? 0;
  const radius = (RING.size - RING.stroke) / 2;
  const label = () => {
    const snapshot = props.snapshot;
    if (!snapshot || snapshot.memory.usedMb === null) return t("app.rail.load.ringUnmeasured", { agents: agents() });
    return t("app.rail.load.ring", {
      agents: agents(),
      used: formatGigabytes(snapshot.memory.usedMb),
      total: formatGigabytes(snapshot.memory.totalMb),
    });
  };
  return (
    <Popover.Root placement="right-end" gutter={8} onOpenChange={props.onOpenChange}>
      <Popover.Trigger
        as={Button}
        variant="ghost"
        type="button"
        class="window-rail-button window-rail-usage window-rail-load"
        aria-label={label()}
      >
        <svg class="window-rail-usage-ring" viewBox={`0 0 ${RING.size} ${RING.size}`} fill="none" aria-hidden="true">
          <circle
            class="window-rail-usage-track"
            cx={RING.size / 2}
            cy={RING.size / 2}
            r={radius}
            stroke-width={RING.stroke}
          />
          <Show when={percent() !== null && (percent() ?? 0) > 0}>
            <circle
              class="window-rail-usage-arc"
              data-load-tone={tone()}
              cx={RING.size / 2}
              cy={RING.size / 2}
              r={radius}
              stroke-width={RING.stroke}
              stroke-linecap="round"
              pathLength={100}
              stroke-dasharray={`${percent()} 100`}
            />
          </Show>
        </svg>
        <span class="window-rail-load-count" aria-hidden="true">
          {agents()}
        </span>
      </Popover.Trigger>
      <Popover.Content class="ui-popover-menu-surface window-rail-load-panel">
        <Popover.Title class="account-usage-popover-title">{t("app.rail.load.title")}</Popover.Title>
        <Show when={props.snapshot}>{(snapshot) => <LoadPanel {...props} snapshot={snapshot()} />}</Show>
      </Popover.Content>
    </Popover.Root>
  );
}

function LoadPanel(props: LoadRailProps & { snapshot: LoadSnapshot }) {
  const { t } = useText();
  const memory = () => props.snapshot.memory;
  const rows = () => loadLaneRows(props.snapshot);
  const queued = () => rows().filter((row) => row.status === "queued");
  return (
    <div class="window-rail-load-body">
      <dl class="window-rail-load-stats">
        <dt>{t("app.rail.load.agents")}</dt>
        <dd>{props.snapshot.activeAgents}</dd>
        <dt>{t("app.rail.load.memory")}</dt>
        <dd>
          <Show when={memory().usedMb !== null} fallback={t("app.rail.load.unmeasured")}>
            {t("app.rail.load.memoryValue", {
              used: formatGigabytes(memory().usedMb ?? 0),
              total: formatGigabytes(memory().totalMb),
              percent: loadMemoryPercent(props.snapshot) ?? 0,
            })}
          </Show>
        </dd>
        <Show when={memory().agentsMb !== null}>
          <dt>{t("app.rail.load.agentsMemory")}</dt>
          <dd>{formatGigabytes(memory().agentsMb ?? 0)}</dd>
          <dt>{t("app.rail.load.processes")}</dt>
          <dd>{props.snapshot.providerProcesses}</dd>
        </Show>
      </dl>
      <SwitchField
        checked={props.snapshot.lane.enabled}
        onChange={(enabled) => props.onLaneChange({ enabled, order: props.snapshot.lane.order })}
        label={t("app.rail.load.lane")}
        description={t("app.rail.load.laneHint")}
      />
      <Show when={props.snapshot.lane.enabled}>
        <ul class="window-rail-load-lane">
          <For each={rows()} keyed={(row) => row.id}>
            {(row) => (
              <li class="window-rail-load-channel" data-status={row().status}>
                <span class="window-rail-load-channel-name">{props.channelName(row().id)}</span>
                <Show
                  when={row().status === "queued"}
                  fallback={<span class="window-rail-load-channel-state">{t("app.rail.load.running")}</span>}
                >
                  <span class="window-rail-load-channel-state">
                    {t("app.rail.load.waiting", { position: row().position ?? 0 })}
                  </span>
                  <span class="window-rail-load-channel-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={row().position === 1}
                      onClick={() => props.onLaneChange(withChannelFirst(props.snapshot, row().id))}
                    >
                      {t("app.rail.load.first")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title={t("app.rail.load.nowHint")}
                      onClick={() => props.onRunNow(row().id)}
                    >
                      {t("app.rail.load.now")}
                    </Button>
                  </span>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={rows().length === 0}>
          <p class="window-rail-load-empty">{t("app.rail.load.noneRunning")}</p>
        </Show>
        <Show when={rows().length > 0 && queued().length === 0}>
          <p class="window-rail-load-empty">{t("app.rail.load.noneWaiting")}</p>
        </Show>
      </Show>
    </div>
  );
}
