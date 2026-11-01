import {
  type AgentLimitPreference,
  type AutoRecoveryPreference,
  DEFAULT_AGENT_TABS,
  type LoadLanePreference,
  type LoadSnapshot,
  type RunningWork,
  type StoppedWork,
  type TaskWatchPreference,
  type TaskWatchState,
} from "@openbot/contracts/ipc";
import {
  Button,
  ChevronDown,
  CircleAlert,
  Clock3,
  IconButton,
  Input,
  MessageSquare,
  PanelTop,
  SlidersHorizontal,
  Square,
  SwitchField,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import {
  activeAgentLimit,
  clampAgentLimit,
  clampAgentTabs,
  clampRecoveryMinutes,
  clampWatchMinutes,
  elapsedMinutes,
  formatGigabytes,
  type LoadRecentEvent,
  type LoadTone,
  loadAgentArc,
  loadLaneRows,
  loadMemoryPercent,
  loadRecentEvents,
  loadRingTone,
  recoveryEventText,
  requestText,
  stoppedCount,
  stoppedTone,
  taskWatchEventText,
  toggledKey,
  withChannelFirst,
} from "./load-view";

/** Two tracks do not fit here: one ring in the 34px box the usage rings use. */
const RING = { size: 34, stroke: 2.5 };

export interface LoadRailProps {
  /** The last reading, or null before the first one. */
  snapshot: LoadSnapshot | null;
  /**
   * Opens the load page of Settings, where the person acts on the work. `ring` is the button of the
   * ring: it takes the focus back when Settings closes.
   */
  onOpen: (ring: HTMLElement) => void;
}

/**
 * The load of this computer as one ring in the rail: the number inside is how many agents run now, and
 * the arc is that count of ten (more can run, and the arc stays full), or of the cap when the person set
 * one, so a full circle is the cap reached. The memory is the colour of the
 * ring, and the tooltip gives it. A red mark on the ring counts the work that stopped. The pointer over
 * the ring gives a one-line summary; a click opens the load page of Settings, where the person can stop
 * what runs, act on many stopped runs at once, and let the app recover work by itself.
 */
export function LoadRing(props: LoadRailProps) {
  const { t } = useText();
  const tone = (): LoadTone => (props.snapshot ? loadRingTone(props.snapshot) : "ok");
  const agents = () => props.snapshot?.activeAgents ?? 0;
  const limit = () => (props.snapshot ? activeAgentLimit(props.snapshot) : null);
  const arc = () => loadAgentArc(agents(), limit());
  /** The count, or the count of the cap: "3" or "3 of 10". */
  const agentsText = () => {
    const cap = limit();
    return cap === null ? String(agents()) : t("app.rail.load.agentsOfLimit", { agents: agents(), limit: cap });
  };
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
      ? t("app.rail.load.ring", { agents: agentsText(), used: used.used, total: used.total })
      : t("app.rail.load.ringUnmeasured", { agents: agentsText() });
    return stopped() > 0 ? `${base} ${t("app.rail.load.stoppedAlert", { count: stopped() })}` : base;
  };
  /** The line that shows when the pointer rests on the ring. */
  const summary = () => {
    const used = memory();
    if (!used) return label();
    return stopped() > 0
      ? t("app.rail.load.summary", { agents: agentsText(), stopped: stopped(), used: used.used, total: used.total })
      : t("app.rail.load.summaryQuiet", { agents: agentsText(), used: used.used, total: used.total });
  };
  return (
    <Button
      variant="ghost"
      type="button"
      class="window-rail-button window-rail-usage window-rail-load"
      aria-label={label()}
      title={summary()}
      onClick={(event) => props.onOpen(event.currentTarget)}
    >
      <svg class="window-rail-usage-ring" viewBox={`0 0 ${RING.size} ${RING.size}`} fill="none" aria-hidden="true">
        <circle
          class="window-rail-usage-track"
          cx={RING.size / 2}
          cy={RING.size / 2}
          r={radius}
          stroke-width={RING.stroke}
        />
        <Show when={arc() > 0}>
          <circle
            class="window-rail-usage-arc"
            data-load-tone={tone()}
            cx={RING.size / 2}
            cy={RING.size / 2}
            r={radius}
            stroke-width={RING.stroke}
            stroke-linecap="round"
            pathLength={100}
            stroke-dasharray={`${arc()} 100`}
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
    </Button>
  );
}

/** What the load page of Settings shows besides the stopped work, and the changes it makes. */
export interface LoadOverviewProps {
  snapshot: LoadSnapshot;
  channelName: (channelId: string) => string;
  onLaneChange: (preference: LoadLanePreference) => void;
  onRunNow: (channelId: string) => void;
  onStop: (work: RunningWork) => void;
  onRecoveryChange: (preference: AutoRecoveryPreference) => void;
  onAgentLimitChange: (preference: AgentLimitPreference) => void;
  /** The task reviewer: its switch and its threshold. */
  onTaskWatchChange: (preference: TaskWatchPreference) => void;
  /** Opens the page of the task reviewer in Settings. */
  onOpenTaskReviewerSettings?: (() => void) | undefined;
}

/**
 * The load of this computer on the load page of Settings, below the stopped work: the memory, what waits
 * for a place and what runs (with Stop), the one-channel-at-a-time mode, the cap on agents, and the
 * automatic recovery with the task reviewer.
 */
export function LoadOverview(props: LoadOverviewProps) {
  const { t } = useText();
  const memory = () => props.snapshot.memory;
  const rows = () => loadLaneRows(props.snapshot);
  const queued = () => rows().filter((row) => row.status === "queued");
  // The requests that the person opened. They close again with the page.
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setExpanded((keys) => toggledKey(keys, key));
  const runningKey = (work: RunningWork) => `running:${work.turnId}`;
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
      <Show when={props.snapshot.waiting.length > 0}>
        <section class="window-rail-load-work">
          <header class="window-rail-load-section-head">
            <h3>{t("app.rail.load.waitingTitle")}</h3>
          </header>
          <ul class="window-rail-load-list">
            <For each={props.snapshot.waiting} keyed={(work) => work.agentId}>
              {(work) => (
                <li class="window-rail-load-item">
                  <div class="window-rail-load-item-head">
                    <span class="window-rail-load-item-name">{work().agentName}</span>
                  </div>
                  <p class="window-rail-load-item-meta">
                    <span>{t("app.rail.load.waitingReason", { count: props.snapshot.agentLimit.max })}</span>
                  </p>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <section class="window-rail-load-work">
        <header class="window-rail-load-section-head">
          <h3>{t("app.rail.load.runningTitle")}</h3>
        </header>
        <Show
          when={props.snapshot.running.length > 0}
          fallback={<p class="window-rail-load-empty">{t("app.rail.load.nothingRuns")}</p>}
        >
          <ul class="window-rail-load-list">
            <For each={props.snapshot.running} keyed={runningKey}>
              {(work) => (
                <RunningRow
                  work={work()}
                  expanded={expanded().has(runningKey(work()))}
                  onToggle={() => toggle(runningKey(work()))}
                  onStop={props.onStop}
                />
              )}
            </For>
          </ul>
        </Show>
      </section>
      <dl class="window-rail-load-stats">
        <dt>{t("app.rail.load.agents")}</dt>
        <dd>
          {activeAgentLimit(props.snapshot) === null
            ? props.snapshot.activeAgents
            : t("app.rail.load.agentsOfLimit", {
                agents: props.snapshot.activeAgents,
                limit: props.snapshot.agentLimit.max,
              })}
        </dd>
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
      <AgentLimitSettings limit={props.snapshot.agentLimit} onChange={props.onAgentLimitChange} />
      <RecoverySettings
        recovery={props.snapshot.recovery}
        taskWatch={props.snapshot.taskWatch}
        recent={loadRecentEvents(props.snapshot)}
        onChange={props.onRecoveryChange}
        onTaskWatchChange={props.onTaskWatchChange}
        onOpenTaskReviewerSettings={props.onOpenTaskReviewerSettings}
      />
    </div>
  );
}

export interface WorkRowProps {
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Why a task stopped, as the icon at the right of its channel: red for a failed task, amber for a paused
 * one. The reason is its tooltip and its accessible name, in the reader's language when it is the
 * English of a source key. The reason is in the tooltip only, because most tasks stop for the same
 * reason and the same sentence on each one hid the requests.
 */
export function StoppedState(props: { work: Pick<StoppedWork, "state" | "reason"> }) {
  const { sourceText } = useText();
  const tone = () => stoppedTone(props.work.state);
  return (
    <IconButton
      variant="ghost"
      size="icon-xs"
      class="window-rail-load-state"
      data-tone={tone()}
      label={sourceText(props.work.reason)}
    >
      <Show when={tone() === "danger"} fallback={<Clock3 aria-hidden="true" />}>
        <CircleAlert aria-hidden="true" />
      </Show>
    </IconButton>
  );
}

/** One turn that runs, in the layout of a stopped task: where it runs, the request, the agent, and Stop. */
function RunningRow(props: WorkRowProps & { work: RunningWork; onStop: (work: RunningWork) => void }) {
  const { t } = useText();
  return (
    <li class="window-rail-load-item">
      <div class="window-rail-load-item-head">
        <span class="window-rail-load-item-name">{props.work.channelName ?? props.work.agentName}</span>
        <span class="window-rail-load-item-time">
          {t("app.rail.load.minutes", { minutes: elapsedMinutes(props.work.startedAt, Date.now()) })}
        </span>
      </div>
      <Show
        when={props.work.channelName !== null}
        fallback={
          <p class="window-rail-load-item-place">
            <MessageSquare aria-hidden="true" />
            <span class="window-rail-load-item-place-name">{t("app.rail.load.inChat")}</span>
          </p>
        }
      >
        <WorkTab name={props.work.topicName} />
      </Show>
      <Show when={props.work.title}>
        <WorkRequest request={props.work.title} expanded={props.expanded} onToggle={props.onToggle} />
      </Show>
      <Show when={props.work.channelName !== null}>
        <p class="window-rail-load-item-meta">
          <span>{t("app.rail.load.runningWith", { agent: props.work.agentName })}</span>
          {/* The task reviewer finds this run slow or stalled: it says why. */}
          <Show when={props.work.quiet}>
            {(quiet) => (
              <span data-tone={quiet().state === "stalled" ? "danger" : undefined}>
                {quiet().state === "stalled"
                  ? t("app.rail.load.quietStalled", { minutes: quiet().minutes })
                  : t("app.rail.load.quietSlow", { minutes: quiet().minutes })}
              </span>
            )}
          </Show>
        </p>
      </Show>
      <div class="window-rail-load-item-actions">
        <Button
          variant="secondary"
          size="sm"
          class="window-rail-load-action"
          aria-label={t("app.rail.load.stopLabel", { agent: props.work.agentName })}
          onClick={() => props.onStop(props.work)}
        >
          <Square aria-hidden="true" />
          {t("app.rail.load.stop")}
        </Button>
      </div>
    </li>
  );
}

/** The tab of the channel that holds the work. No line when the tab is not known. */
export function WorkTab(props: { name: string | null }) {
  const { t } = useText();
  return (
    <Show when={props.name}>
      {(name) => (
        <p class="window-rail-load-item-place">
          <PanelTop aria-hidden="true" />
          <span class="sr-only">{`${t("app.rail.load.tab")} `}</span>
          <span class="window-rail-load-item-place-name">{name()}</span>
        </p>
      )}
    </Show>
  );
}

/**
 * The request on one line. The chevron shows the whole request, and a click on the line does the same:
 * the chevron's hit area covers the line while it is closed. Open, the text can be selected and scrolls
 * after eight lines.
 */
export function WorkRequest(props: WorkRowProps & { request: string }) {
  const { t } = useText();
  const id = `window-rail-load-request-${createUniqueId()}`;
  const request = () => requestText(props.request);
  const [clipped, setClipped] = createSignal(false);
  let line: HTMLParagraphElement | undefined;
  onSettled(() => {
    const element = line;
    if (!element || typeof ResizeObserver === "undefined") return;
    // A request that fits on its line has nothing to show. An open request wraps, so it is measured closed.
    const observer = new ResizeObserver(() => {
      if (!props.expanded) setClipped(element.scrollWidth > element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  });
  return (
    <div class="window-rail-load-request" data-expanded={props.expanded ? "" : undefined}>
      <p
        id={id}
        ref={(element) => {
          line = element;
        }}
        class="window-rail-load-request-text"
        data-empty={request().text ? undefined : ""}
      >
        {request().text || t("app.rail.load.attachmentOnly")}
      </p>
      <Show when={props.expanded || clipped()}>
        <Button
          variant="ghost"
          size="icon-xs"
          class="window-rail-load-request-toggle"
          aria-label={props.expanded ? t("app.rail.load.collapseRequest") : t("app.rail.load.expandRequest")}
          aria-expanded={props.expanded ? "true" : "false"}
          aria-controls={id}
          onClick={() => props.onToggle()}
        >
          <ChevronDown aria-hidden="true" />
        </Button>
      </Show>
    </div>
  );
}

/**
 * The switch and the number of the cap on the agents that run at the same time, and the number of
 * channel tabs of one agent that run at the same time, which applies with the cap on or off.
 */
function AgentLimitSettings(props: {
  limit: AgentLimitPreference;
  onChange: (preference: AgentLimitPreference) => void;
}) {
  const { t } = useText();
  const [draft, setDraft] = createSignal<string | null>(null);
  const [tabsDraft, setTabsDraft] = createSignal<string | null>(null);
  const tabsHintId = createUniqueId();
  return (
    <section class="window-rail-load-section">
      <SwitchField
        checked={props.limit.enabled}
        onChange={(enabled) => props.onChange({ ...props.limit, enabled })}
        label={t("app.rail.load.limitTitle")}
        description={t("app.rail.load.limitHint")}
      />
      <Show when={props.limit.enabled}>
        <label class="window-rail-load-interval">
          <span>{t("app.rail.load.limitMax")}</span>
          <Input
            class="window-rail-load-number"
            data-cuelume-type={undefined}
            type="number"
            min="1"
            max="64"
            step="1"
            inputmode="numeric"
            value={draft() ?? String(props.limit.max)}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onChange={(event) => {
              const max = clampAgentLimit(Number(event.currentTarget.value));
              setDraft(null);
              event.currentTarget.value = String(max);
              props.onChange({ ...props.limit, enabled: true, max });
            }}
          />
          <span>{t("app.rail.load.limitUnit")}</span>
        </label>
      </Show>
      <label class="window-rail-load-interval">
        <span>{t("app.rail.load.tabsTitle")}</span>
        <Input
          class="window-rail-load-number"
          data-cuelume-type={undefined}
          type="number"
          min="1"
          max="4"
          step="1"
          inputmode="numeric"
          aria-describedby={tabsHintId}
          value={tabsDraft() ?? String(props.limit.tabsPerAgent ?? DEFAULT_AGENT_TABS)}
          onInput={(event) => setTabsDraft(event.currentTarget.value)}
          onChange={(event) => {
            const tabsPerAgent = clampAgentTabs(Number(event.currentTarget.value));
            setTabsDraft(null);
            event.currentTarget.value = String(tabsPerAgent);
            props.onChange({ ...props.limit, tabsPerAgent });
          }}
        />
        <span>{t("app.rail.load.tabsUnit")}</span>
      </label>
      <p id={tabsHintId} class="window-rail-load-hint">
        {t("app.rail.load.tabsHint")}
      </p>
    </section>
  );
}

/**
 * The switches and the interval of the automatic recovery, the task reviewer that looks only while it is
 * on, and what both did lately. The switch of the task reviewer shows also while the recovery is off.
 */
function RecoverySettings(props: {
  recovery: LoadSnapshot["recovery"];
  taskWatch: TaskWatchState;
  recent: LoadRecentEvent[];
  onChange: (preference: AutoRecoveryPreference) => void;
  onTaskWatchChange: (preference: TaskWatchPreference) => void;
  onOpenTaskReviewerSettings: (() => void) | undefined;
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
          <Input
            class="window-rail-load-number"
            data-cuelume-type={undefined}
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
      </Show>
      {/* Always shown: the switch says that it acts only with "Resume by itself" on, and the Settings
          page can turn the reviewer on while "Resume by itself" is off. */}
      <TaskWatchSettings
        taskWatch={props.taskWatch}
        onChange={props.onTaskWatchChange}
        onOpenSettings={props.onOpenTaskReviewerSettings}
      />
      <Show when={props.recovery.enabled && props.recent.length > 0}>
        <h3 class="window-rail-load-subhead">{t("app.rail.load.recoveryRecent")}</h3>
        <ul class="window-rail-load-recent">
          <For
            each={props.recent}
            keyed={(item) => `${item.by}:${item.event.at}:${item.event.action}:${item.event.channelName}`}
          >
            {(item) => {
              const entry = item();
              return entry.by === "recovery" ? (
                <li>{recoveryEventText(entry.event, t)}</li>
              ) : (
                <li title={t(entry.event.by === "model" ? "app.rail.load.watchByModel" : "app.rail.load.watchByLocal")}>
                  {taskWatchEventText(entry.event, t)}
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** The switch of the task reviewer, which model decides, its threshold, and the way to its page in Settings. */
function TaskWatchSettings(props: {
  taskWatch: TaskWatchState;
  onChange: (preference: TaskWatchPreference) => void;
  onOpenSettings: (() => void) | undefined;
}) {
  const { t } = useText();
  const [draft, setDraft] = createSignal<string | null>(null);
  return (
    <>
      <SwitchField
        checked={props.taskWatch.enabled}
        onChange={(enabled) => props.onChange({ enabled, quietMinutes: props.taskWatch.quietMinutes })}
        label={t("app.rail.load.watchTitle")}
        description={t("app.rail.load.watchHint")}
      />
      <Show when={props.taskWatch.enabled}>
        <p class="window-rail-load-empty">
          {props.taskWatch.modelReady ? t("app.rail.load.watchModel") : t("app.rail.load.watchModelOff")}
        </p>
        <label class="window-rail-load-interval">
          <span>{t("app.rail.load.watchQuiet")}</span>
          <Input
            class="window-rail-load-number"
            data-cuelume-type={undefined}
            type="number"
            min="5"
            max="120"
            step="5"
            inputmode="numeric"
            value={draft() ?? String(props.taskWatch.quietMinutes)}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onChange={(event) => {
              const quietMinutes = clampWatchMinutes(Number(event.currentTarget.value));
              setDraft(null);
              event.currentTarget.value = String(quietMinutes);
              // A late change, sent on blur when the switch is clicked, must not turn the reviewer on again.
              props.onChange({ enabled: props.taskWatch.enabled, quietMinutes });
            }}
          />
          <span>{t("app.rail.load.watchQuietUnit")}</span>
        </label>
      </Show>
      <Show when={props.onOpenSettings}>
        {(open) => (
          <Button
            variant="secondary"
            size="sm"
            class="window-rail-load-action window-rail-load-link"
            onClick={() => open()()}
          >
            <SlidersHorizontal aria-hidden="true" />
            {t("app.rail.load.watchSettings")}
          </Button>
        )}
      </Show>
    </>
  );
}
