import type {
  AutoRecoveryPreference,
  LoadLanePreference,
  LoadSnapshot,
  RecoveryEvent,
  RunningWork,
  StoppedWork,
} from "@openbot/contracts/ipc";
import { Button, Popover, SwitchField } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, For, Show } from "solid-js";
import {
  clampRecoveryMinutes,
  elapsedMinutes,
  formatGigabytes,
  type LoadTone,
  loadLaneRows,
  loadMemoryPercent,
  loadTone,
  stoppedCount,
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
  onStop: (work: RunningWork) => void;
  onResumeAll: () => void;
  onResume: (work: StoppedWork) => void;
  onReassign: (work: StoppedWork, agentId: string) => void;
  onRecoveryChange: (preference: AutoRecoveryPreference) => void;
}

/**
 * The load of this computer as one ring in the rail: the share of memory in use is the arc, and the
 * number inside is how many agents run now. A red mark on the ring counts the work that stopped. The
 * pointer over the ring gives a one-line summary; a click opens the panel, where the person can stop
 * what runs, start stopped work again or give it to another agent, and let the app do it by itself.
 *
 * The rail is a drag region of the window and clips what is drawn inside it, so the panel is drawn in a
 * portal and takes no drag.
 */
export function LoadRing(props: LoadRailProps) {
  const { t } = useText();
  const percent = () => (props.snapshot ? loadMemoryPercent(props.snapshot) : null);
  const tone = (): LoadTone => loadTone(percent());
  const agents = () => props.snapshot?.activeAgents ?? 0;
  const stopped = () => (props.snapshot ? stoppedCount(props.snapshot) : 0);
  const radius = (RING.size - RING.stroke) / 2;
  const memory = () => {
    const snapshot = props.snapshot;
    if (!snapshot || snapshot.memory.usedMb === null) return null;
    return { used: formatGigabytes(snapshot.memory.usedMb), total: formatGigabytes(snapshot.memory.totalMb) };
  };
  const label = () => {
    const used = memory();
    const base = used
      ? t("app.rail.load.ring", { agents: agents(), used: used.used, total: used.total })
      : t("app.rail.load.ringUnmeasured", { agents: agents() });
    return stopped() > 0 ? `${base} ${t("app.rail.load.stoppedAlert", { count: stopped() })}` : base;
  };
  /** The line that shows when the pointer rests on the ring. */
  const summary = () => {
    const used = memory();
    if (!used) return label();
    return stopped() > 0
      ? t("app.rail.load.summary", { agents: agents(), stopped: stopped(), used: used.used, total: used.total })
      : t("app.rail.load.summaryQuiet", { agents: agents(), used: used.used, total: used.total });
  };
  return (
    <Popover.Root placement="right-end" gutter={8} onOpenChange={props.onOpenChange}>
      <Popover.Trigger
        as={Button}
        variant="ghost"
        type="button"
        class="window-rail-button window-rail-usage window-rail-load"
        aria-label={label()}
        title={summary()}
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
        <Show when={stopped() > 0}>
          <span class="window-rail-load-alert" aria-hidden="true">
            {Math.min(stopped(), 9)}
            {stopped() > 9 ? "+" : ""}
          </span>
        </Show>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="ui-popover-menu-surface window-rail-load-panel">
          <Popover.Title class="account-usage-popover-title">{t("app.rail.load.title")}</Popover.Title>
          <Show when={props.snapshot}>{(snapshot) => <LoadPanel {...props} snapshot={snapshot()} />}</Show>
        </Popover.Content>
      </Popover.Portal>
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
      <Show when={props.snapshot.memory.pressure}>
        {(pressure) => (
          <Show when={pressure().level !== "ok"}>
            <p class="window-rail-load-pressure" data-level={pressure().level} role="status">
              {t(pressure().level === "critical" ? "app.rail.load.pressureCritical" : "app.rail.load.pressureLow", {
                percent: pressure().freePercent,
              })}
            </p>
          </Show>
        )}
      </Show>
      <Show when={props.snapshot.stopped.length > 0}>
        <section class="window-rail-load-section" data-alert="">
          <header class="window-rail-load-section-head">
            <h3>{t("app.rail.load.stoppedCount", { count: props.snapshot.stopped.length })}</h3>
            <Button variant="ghost" size="sm" onClick={() => props.onResumeAll()}>
              {t("app.rail.load.resumeAll")}
            </Button>
          </header>
          <ul class="window-rail-load-stopped">
            <For each={props.snapshot.stopped} keyed={(row) => `${row.channelId}:${row.taskId}`}>
              {(row) => <StoppedRow work={row()} {...props} />}
            </For>
          </ul>
        </section>
      </Show>
      <section class="window-rail-load-section">
        <header class="window-rail-load-section-head">
          <h3>{t("app.rail.load.runningTitle")}</h3>
        </header>
        <Show
          when={props.snapshot.running.length > 0}
          fallback={<p class="window-rail-load-empty">{t("app.rail.load.nothingRuns")}</p>}
        >
          <ul class="window-rail-load-running">
            <For each={props.snapshot.running} keyed={(work) => work.turnId}>
              {(work) => (
                <li class="window-rail-load-run">
                  <span class="window-rail-load-run-copy">
                    <strong>{work().agentName}</strong>
                    <span>
                      {work().channelName
                        ? work().title
                          ? `${work().channelName} · ${work().title}`
                          : work().channelName
                        : t("app.rail.load.inChat")}
                    </span>
                  </span>
                  <span class="window-rail-load-run-time">
                    {t("app.rail.load.minutes", { minutes: elapsedMinutes(work().startedAt, Date.now()) })}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("app.rail.load.stopLabel", { agent: work().agentName })}
                    onClick={() => props.onStop(work())}
                  >
                    {t("app.rail.load.stop")}
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
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
      <RecoverySettings recovery={props.snapshot.recovery} onChange={props.onRecoveryChange} />
    </div>
  );
}

function StoppedRow(props: LoadRailProps & { work: StoppedWork }) {
  const { t } = useText();
  return (
    <li class="window-rail-load-stopped-row">
      <div class="window-rail-load-stopped-head">
        <strong>{props.work.channelName}</strong>
        <Show when={props.work.auto === "waiting"}>
          <span class="window-rail-load-chip">{t("app.rail.load.autoWaiting")}</span>
        </Show>
        <Show when={props.work.auto === "gave-up"}>
          <span class="window-rail-load-chip" data-tone="danger">
            {t("app.rail.load.autoGaveUp")}
          </span>
        </Show>
      </div>
      <p class="window-rail-load-stopped-title">{props.work.title}</p>
      <p class="window-rail-load-stopped-reason">{props.work.reason}</p>
      <Show when={props.work.agentName}>
        {(agent) => <p class="window-rail-load-stopped-by">{t("app.rail.load.stoppedBy", { agent: agent() })}</p>}
      </Show>
      <div class="window-rail-load-stopped-actions">
        <Button variant="ghost" size="sm" onClick={() => props.onResume(props.work)}>
          {t("app.rail.load.resume")}
        </Button>
        <Show when={props.work.candidates.length > 0}>
          <select
            class="window-rail-load-select"
            aria-label={t("app.rail.load.reassignLabel")}
            onChange={(event) => {
              const agentId = event.currentTarget.value;
              event.currentTarget.value = "";
              if (agentId) props.onReassign(props.work, agentId);
            }}
          >
            <option value="">{t("app.rail.load.reassign")}</option>
            <For each={props.work.candidates} keyed={(candidate) => candidate.agentId}>
              {(candidate) => (
                <option value={candidate().agentId}>
                  {candidate().sameModel ? t("app.rail.load.sameModel", { name: candidate().name }) : candidate().name}
                </option>
              )}
            </For>
          </select>
        </Show>
      </div>
    </li>
  );
}

/** The switches and the interval of the automatic recovery, and what it did lately. */
function RecoverySettings(props: {
  recovery: LoadSnapshot["recovery"];
  onChange: (preference: AutoRecoveryPreference) => void;
}) {
  const { t } = useText();
  const [draft, setDraft] = createSignal<string | null>(null);
  const change = (patch: Partial<AutoRecoveryPreference>) =>
    props.onChange({
      enabled: props.recovery.enabled,
      intervalMinutes: props.recovery.intervalMinutes,
      reassign: props.recovery.reassign,
      ...patch,
    });
  return (
    <section class="window-rail-load-section">
      <SwitchField
        checked={props.recovery.enabled}
        onChange={(enabled) => change({ enabled })}
        label={t("app.rail.load.recoveryTitle")}
        description={t("app.rail.load.recoveryHint")}
      />
      <Show when={props.recovery.enabled}>
        <label class="window-rail-load-interval">
          <span>{t("app.rail.load.recoveryEvery")}</span>
          <input
            class="window-rail-load-number"
            type="number"
            min="5"
            max="1440"
            step="5"
            inputmode="numeric"
            value={draft() ?? String(props.recovery.intervalMinutes)}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onChange={(event) => {
              const minutes = clampRecoveryMinutes(Number(event.currentTarget.value));
              setDraft(null);
              event.currentTarget.value = String(minutes);
              change({ intervalMinutes: minutes });
            }}
          />
          <span>{t("app.rail.load.recoveryUnit")}</span>
        </label>
        <SwitchField
          checked={props.recovery.reassign}
          onChange={(reassign) => change({ reassign })}
          label={t("app.rail.load.recoveryReassign")}
          description={t("app.rail.load.recoveryReassignHint")}
        />
        <Show when={props.recovery.recent.length > 0}>
          <h3 class="window-rail-load-subhead">{t("app.rail.load.recoveryRecent")}</h3>
          <ul class="window-rail-load-recent">
            <For each={props.recovery.recent} keyed={(event) => `${event.at}:${event.action}:${event.channelName}`}>
              {(event) => <li>{recoveryEventText(event(), t)}</li>}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}

function recoveryEventText(event: RecoveryEvent, t: ReturnType<typeof useText>["t"]): string {
  if (event.action === "resumed") return t("app.rail.load.eventResumed", { channel: event.channelName });
  if (event.action === "reassigned")
    return t("app.rail.load.eventReassigned", { channel: event.channelName, agent: event.agentName ?? "" });
  return t("app.rail.load.eventGaveUp", { channel: event.channelName });
}
