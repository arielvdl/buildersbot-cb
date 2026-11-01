import {
  type AgentLimitPreference,
  type AutoRecoveryPreference,
  type LoadLanePreference,
  type LoadSnapshot,
  type RunningWork,
  STOPPED_WORK_UNDO_MS,
  type StoppedWorkEntry,
  type StoppedWorkFailure,
  type StoppedWorkOrphan,
  type TaskWatchPreference,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Badge,
  Button,
  buttonVariants,
  Checkbox,
  ChevronDown,
  ConfirmDialog,
  Cpu,
  Input,
  Play,
  Search,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
  Trash2,
  Undo2,
  X,
} from "@openbot/ui";
import { AgentPicker } from "@openbot/ui/features/agents/AgentPicker";
import { LoadOverview, StoppedState, WorkRequest, WorkTab } from "@openbot/ui/features/window/LoadRing";
import { toggledKey } from "@openbot/ui/features/window/load-view";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { type GuardModelRow, guardModelName, type SettingsGuardStore } from "./settings-guard-store";
import type { SettingsLoadStore } from "./settings-load-store";
import {
  EMPTY_STOPPED_WORK_FILTER,
  filterActive,
  modelOwners,
  reassignChoices,
  type StoppedWorkFilter,
  stoppedWorkChoices,
  stoppedWorkCounts,
  stoppedWorkKey,
} from "./stopped-work-filter";

/** What the load page reads and changes: the load of this computer, the same store as the ring of the rail. */
export interface SettingsLoad {
  snapshot: () => LoadSnapshot | null;
  setLane: (preference: LoadLanePreference) => Promise<void>;
  runNow: (channelId: string) => Promise<void>;
  stop: (work: RunningWork) => Promise<void>;
  setRecovery: (preference: AutoRecoveryPreference) => Promise<void>;
  setAgentLimit: (preference: AgentLimitPreference) => Promise<void>;
  setTaskWatch: (preference: TaskWatchPreference) => Promise<void>;
}

/** The reasons of a failed row, in the order of the report. */
const FAILURE_ORDER: readonly StoppedWorkFailure[] = ["gone", "running", "not-member", "no-agent", "expired", "failed"];

const FAILURE_TEXT = {
  gone: "settings.load.report.reason.gone",
  running: "settings.load.report.reason.running",
  "not-member": "settings.load.report.reason.not-member",
  "no-agent": "settings.load.report.reason.no-agent",
  expired: "settings.load.report.reason.expired",
  failed: "settings.load.report.reason.failed",
} as const satisfies Record<StoppedWorkFailure, AppTextKey>;

const ORPHAN_TEXT = {
  "routine-deleted": ["settings.load.orphan.routine-deleted", "settings.load.orphanHint.routine-deleted"],
  duplicate: ["settings.load.orphan.duplicate", "settings.load.orphanHint.duplicate"],
  "agent-deleted": ["settings.load.orphan.agent-deleted", "settings.load.orphanHint.agent-deleted"],
  "topic-deleted": ["settings.load.orphan.topic-deleted", "settings.load.orphanHint.topic-deleted"],
} as const satisfies Record<StoppedWorkOrphan, readonly [AppTextKey, AppTextKey]>;

const STATE_TEXT = {
  all: "settings.load.filter.state.all",
  paused: "settings.load.filter.state.paused",
  failed: "settings.load.filter.state.failed",
} as const satisfies Record<StoppedWorkFilter["state"], AppTextKey>;

const ORIGIN_TEXT = {
  all: "settings.load.filter.origin.all",
  routine: "settings.load.filter.origin.routine",
  request: "settings.load.filter.origin.request",
} as const satisfies Record<StoppedWorkFilter["origin"], AppTextKey>;

const SOURCE_TEXT = {
  all: "settings.load.filter.orphan.all",
  orphan: "settings.load.filter.orphan.orphan",
  kept: "settings.load.filter.orphan.kept",
} as const satisfies Record<StoppedWorkFilter["orphan"], AppTextKey>;

/**
 * Settings › Load ("Carga" in Portuguese), which the ring of the rail opens. First the stopped work: the
 * counts, a search and filters, and the rows with a box each. Marked rows get one bar of actions:
 * Resume, Reassign to one agent, Change model (of the agents that had them), and Remove with an undo.
 * Space marks a row, Shift with Space or a click marks a range, and the arrows move between rows. Then
 * what runs now and the switches of the load, as the panel of the ring had them.
 */
export function SettingsLoadTab(props: {
  store: SettingsLoadStore;
  load: SettingsLoad;
  guard: SettingsGuardStore;
  channelName: (channelId: string) => string;
  menuMount: HTMLElement | undefined;
  onOpenTaskReviewer: () => void;
}) {
  const { t } = useText();
  const store = props.store;
  const list = () => store.state.list;
  const counts = () => {
    const current = list();
    return current ? stoppedWorkCounts(current) : null;
  };
  const choices = createMemo(() => stoppedWorkChoices(list()?.items ?? []));
  const selectedCount = () => store.selectedRows().length;
  const busy = () => store.state.busy !== null;
  // The requests that the person opened. They close again with the page.
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = createSignal<"remove" | "model" | null>(null);
  const [model, setModel] = createSignal<string | null>(null);
  let listElement: HTMLUListElement | undefined;
  const selectAllId = `settings-load-select-all-${createUniqueId()}`;

  const change = <Key extends keyof StoppedWorkFilter>(key: Key, value: StoppedWorkFilter[Key]) =>
    store.setFilter((draft) => {
      draft[key] = value;
    });

  const reassignAgents = () => {
    const current = list();
    return current ? reassignChoices(current, store.selectedRows()) : [];
  };
  const owners = () => {
    const current = list();
    return current ? modelOwners(current, store.selectedRows()) : { agents: [], withoutAgent: 0 };
  };
  const modelRows = (): GuardModelRow[] => props.guard.rows().filter((row) => row.choice !== null);
  const modelRow = (key: string | null) => modelRows().find((row) => row.key === key);

  /** ArrowDown and ArrowUp move between the boxes of the rows, as in a list. */
  const moveFocus = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const boxes = [...(listElement?.querySelectorAll<HTMLInputElement>("input[type='checkbox']") ?? [])];
    const index = boxes.findIndex((box) => box === document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    boxes[event.key === "ArrowDown" ? Math.min(boxes.length - 1, index + 1) : Math.max(0, index - 1)]?.focus();
  };

  const reportText = () => {
    const report = store.state.report;
    if (!report) return "";
    const count = report.done;
    switch (report.action) {
      case "resume":
        return t("settings.load.report.resume", { count });
      case "reassign":
        return t("settings.load.report.reassign", { count, agent: report.agentName ?? "" });
      case "model":
        return t("settings.load.report.model", { count, agents: report.agents.join(", ") });
      case "remove":
        return t("settings.load.report.remove", { count });
      case "undo":
        return t("settings.load.report.undo", { count });
    }
  };
  const failureLines = () => {
    const failed = store.state.report?.failed ?? [];
    return FAILURE_ORDER.flatMap((reason) => {
      const count = failed.filter((item) => item.reason === reason).length;
      return count ? [t("settings.load.report.reason", { reason: t(FAILURE_TEXT[reason]), count })] : [];
    });
  };

  return (
    <>
      <SettingsSection
        data-settings-row="settings.load.stopped.title"
        title={t("settings.load.stopped.title")}
        description={t("settings.load.stopped.description")}
      >
        <div class="settings-load">
          <Show when={counts()}>
            {(value) => (
              <dl class="settings-load-counts" aria-label={t("settings.load.count.label")}>
                <div>
                  <dt>{t("settings.load.count.stopped")}</dt>
                  <dd>{value().stopped}</dd>
                </div>
                <div data-tone="danger">
                  <dt>{t("settings.load.count.failed")}</dt>
                  <dd>{value().failed}</dd>
                </div>
                <div data-tone="warning">
                  <dt>{t("settings.load.count.paused")}</dt>
                  <dd>{value().paused}</dd>
                </div>
                <div data-tone="muted">
                  <dt>{t("settings.load.count.orphans")}</dt>
                  <dd>{value().orphans}</dd>
                </div>
              </dl>
            )}
          </Show>
          <Show when={list() && (list()?.total ?? 0) > (list()?.items.length ?? 0)}>
            <p class="settings-load-note">
              {t("settings.load.limitNote", { shown: list()?.items.length ?? 0, total: list()?.total ?? 0 })}
            </p>
          </Show>

          <div class="settings-load-filters">
            <label class="server-settings-search settings-load-search">
              <Search aria-hidden="true" />
              <span class="sr-only">{t("settings.load.search.label")}</span>
              <Input
                size="sm"
                type="search"
                placeholder={t("settings.load.search.placeholder")}
                value={store.filter.search}
                onValueChange={(value) => change("search", value)}
              />
            </label>
            <FilterSelect
              label={t("settings.load.filter.state")}
              value={store.filter.state}
              options={["all", "paused", "failed"] as const}
              text={(value) => t(STATE_TEXT[value])}
              mount={props.menuMount}
              onChange={(value) => change("state", value)}
            />
            <FilterSelect
              label={t("settings.load.filter.agent")}
              value={store.filter.agent}
              options={["all", ...(choices().noAgent ? ["none"] : []), ...choices().agents.map((agent) => agent.id)]}
              text={(value) =>
                value === "all"
                  ? t("settings.load.filter.agent.all")
                  : value === "none"
                    ? t("settings.load.filter.agent.none")
                    : (choices().agents.find((agent) => agent.id === value)?.name ?? value)
              }
              mount={props.menuMount}
              onChange={(value) => change("agent", value)}
            />
            <FilterSelect
              label={t("settings.load.filter.place")}
              value={store.filter.place}
              options={["all", ...choices().places.map((place) => place.key)]}
              text={(value) => {
                if (value === "all") return t("settings.load.filter.place.all");
                const place = choices().places.find((entry) => entry.key === value);
                if (!place) return value;
                return place.topicName === null
                  ? place.channelName
                  : t("settings.load.filter.place.tab", { channel: place.channelName, tab: place.topicName });
              }}
              mount={props.menuMount}
              onChange={(value) => change("place", value)}
            />
            <FilterSelect
              label={t("settings.load.filter.origin")}
              value={store.filter.origin}
              options={["all", "routine", "request"] as const}
              text={(value) => t(ORIGIN_TEXT[value])}
              mount={props.menuMount}
              onChange={(value) => change("origin", value)}
            />
            <FilterSelect
              label={t("settings.load.filter.orphan")}
              value={store.filter.orphan}
              options={["all", "orphan", "kept"] as const}
              text={(value) => t(SOURCE_TEXT[value])}
              mount={props.menuMount}
              onChange={(value) => change("orphan", value)}
            />
            <Show when={filterActive(store.filter)}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  store.setFilter((draft) => {
                    Object.assign(draft, EMPTY_STOPPED_WORK_FILTER);
                  })
                }
              >
                {t("settings.load.filter.clear")}
              </Button>
            </Show>
          </div>

          <div class="settings-load-toolbar">
            <div class="settings-load-select-all">
              <Checkbox
                id={selectAllId}
                checked={store.allShownMarked()}
                disabled={store.shown().length === 0 || busy()}
                onChange={(event) => store.markShown(event.currentTarget.checked)}
              />
              <label for={selectAllId}>{t("settings.load.selectAll", { count: store.shown().length })}</label>
            </div>
            <Show when={selectedCount() > 0}>
              <div class="settings-load-actions" role="toolbar" aria-label={t("settings.load.actions.label")}>
                <span class="settings-load-selected" aria-live="polite">
                  {t("settings.load.selected", { count: selectedCount() })}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy()}
                  onClick={() => void store.resume()}
                >
                  <Play aria-hidden="true" />
                  {t("settings.load.action.resume")}
                </Button>
                <Show
                  when={reassignAgents().length > 0}
                  fallback={
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled
                      title={t("settings.load.reassign.none")}
                    >
                      {t("settings.load.action.reassign")}
                    </Button>
                  }
                >
                  <AgentPicker
                    agents={reassignAgents()}
                    label={t("settings.load.action.reassignLabel")}
                    triggerClass={buttonVariants({ variant: "secondary", size: "sm" })}
                    mount={props.menuMount}
                    onChoose={(agent) => {
                      if (!busy()) void store.reassign(agent.id, agent.name);
                    }}
                  >
                    {t("settings.load.action.reassign")}
                    <ChevronDown aria-hidden="true" />
                  </AgentPicker>
                </Show>
                {/* The models that the Guard page lists. A choice asks first, with the agents that change. */}
                <Select<string>
                  class="settings-load-model"
                  options={modelRows().map((row) => row.key)}
                  value={null}
                  disabled={busy()}
                  onChange={(key) => {
                    if (!key) return;
                    setModel(key);
                    setConfirm("model");
                  }}
                  placement="bottom-start"
                  itemComponent={(itemProps) => (
                    <SelectItem item={itemProps.item}>
                      {guardModelName(modelRow(itemProps.item.rawValue), t)}
                    </SelectItem>
                  )}
                >
                  <SelectTrigger size="sm" aria-label={t("settings.load.action.model")}>
                    <Cpu aria-hidden="true" />
                    <span>{t("settings.load.action.model")}</span>
                  </SelectTrigger>
                  <SelectContent mount={props.menuMount} />
                </Select>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={busy()}
                  onClick={() => setConfirm("remove")}
                >
                  <Trash2 aria-hidden="true" />
                  {t("settings.load.action.remove")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy()}
                  onClick={() => store.clearSelection()}
                >
                  {t("settings.load.clearSelection")}
                </Button>
              </div>
            </Show>
          </div>

          <Show when={store.state.busy}>
            {(work) => (
              <p class="settings-load-status" role="status">
                {t("settings.load.working", { count: work().count })}
              </p>
            )}
          </Show>
          <Show when={store.state.report}>
            {(report) => (
              <div class="settings-load-report" role="status" aria-label={t("settings.load.report.label")}>
                <div class="settings-load-report-text">
                  <p>{reportText()}</p>
                  <Show when={report().failed.length > 0}>
                    <p data-tone="danger">{t("settings.load.report.failed", { count: report().failed.length })}</p>
                    <ul>
                      <For each={failureLines()}>{(line) => <li>{line}</li>}</For>
                    </ul>
                  </Show>
                </div>
                <Show when={report().undoId}>
                  <Button type="button" variant="secondary" size="sm" disabled={busy()} onClick={() => store.undo()}>
                    <Undo2 aria-hidden="true" />
                    {t("settings.load.report.undoAction")}
                  </Button>
                </Show>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("common.close")}
                  onClick={() => store.dismissReport()}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
            )}
          </Show>

          <Show
            when={list()}
            fallback={
              <p class="window-rail-load-empty">
                {store.state.loadFailed ? t("settings.load.loadFailed") : t("settings.load.loading")}
              </p>
            }
          >
            <Show
              when={store.shown().length > 0}
              fallback={
                <p class="window-rail-load-empty">
                  {(list()?.items.length ?? 0) === 0 ? t("settings.load.empty") : t("settings.load.noMatch")}
                </p>
              }
            >
              <ul
                class="window-rail-load-list settings-load-list window-load-page"
                ref={(element) => {
                  listElement = element;
                }}
                onKeyDown={moveFocus}
              >
                <For each={store.shown()} keyed={stoppedWorkKey}>
                  {(row) => (
                    <StoppedWorkRow
                      row={row()}
                      checked={store.selected().has(stoppedWorkKey(row()))}
                      disabled={busy()}
                      expanded={expanded().has(stoppedWorkKey(row()))}
                      onToggle={() => setExpanded((keys) => toggledKey(keys, stoppedWorkKey(row())))}
                      onMark={(checked, range) => store.mark(stoppedWorkKey(row()), checked, range)}
                    />
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </div>
      </SettingsSection>

      <SettingsSection
        data-settings-row="settings.load.overview.title"
        title={t("settings.load.overview.title")}
        description={t("settings.load.overview.description")}
      >
        <Show
          when={props.load.snapshot()}
          fallback={<p class="window-rail-load-empty">{t("settings.load.loading")}</p>}
        >
          {(snapshot) => (
            <div class="window-load-page">
              <LoadOverview
                snapshot={snapshot()}
                channelName={props.channelName}
                onLaneChange={(preference) => void props.load.setLane(preference)}
                onRunNow={(channelId) => void props.load.runNow(channelId)}
                onStop={(work) => void props.load.stop(work)}
                onRecoveryChange={(preference) => void props.load.setRecovery(preference)}
                onAgentLimitChange={(preference) => void props.load.setAgentLimit(preference)}
                onTaskWatchChange={(preference) => void props.load.setTaskWatch(preference)}
                onOpenTaskReviewerSettings={props.onOpenTaskReviewer}
              />
            </div>
          )}
        </Show>
      </SettingsSection>

      <ConfirmDialog
        open={confirm() === "remove"}
        tone="destructive"
        title={t("settings.load.remove.title", { count: selectedCount() })}
        description={t("settings.load.remove.description", { seconds: Math.round(STOPPED_WORK_UNDO_MS / 1000) })}
        confirmLabel={t("settings.load.remove.confirm")}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          await store.remove();
        }}
      >
        <Show when={store.selectedRows().filter((row) => row.orphan !== null).length}>
          {(orphans) => <p class="settings-load-note">{t("settings.load.remove.orphans", { count: orphans() })}</p>}
        </Show>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm() === "model"}
        tone="default"
        title={t("settings.load.model.title", { count: owners().agents.length })}
        description={
          owners().agents.length > 0
            ? t("settings.load.model.description", {
                agents: owners()
                  .agents.map((agent) => agent.name)
                  .join(", "),
              })
            : t("settings.load.model.none")
        }
        confirmLabel={t("settings.load.model.confirm")}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const choice = modelRow(model())?.choice;
          setConfirm(null);
          if (choice && owners().agents.length > 0) await store.changeModel(choice.provider, choice.model);
        }}
      >
        <Show when={owners().withoutAgent > 0}>
          <p class="settings-load-note">{t("settings.load.model.noAgent", { count: owners().withoutAgent })}</p>
        </Show>
        <Show when={owners().agents.length > 0 && modelRow(model())}>
          {(row) => (
            <p class="settings-load-note">{t("settings.load.model.target", { model: guardModelName(row(), t) })}</p>
          )}
        </Show>
      </ConfirmDialog>
    </>
  );
}

/** One select of the filter row. */
function FilterSelect<Value extends string>(props: {
  label: string;
  value: Value;
  options: readonly Value[];
  text: (value: Value) => string;
  mount: HTMLElement | undefined;
  onChange: (value: Value) => void;
}) {
  return (
    <Select<Value>
      class="settings-modal-select settings-load-filter"
      options={[...props.options]}
      value={props.value}
      onChange={(value) => {
        if (value !== null) props.onChange(value);
      }}
      placement="bottom-start"
      itemComponent={(itemProps) => (
        <SelectItem item={itemProps.item}>{props.text(itemProps.item.rawValue)}</SelectItem>
      )}
    >
      <SelectTrigger size="sm" aria-label={props.label}>
        <SelectValue<Value>>{(state) => props.text(state.selectedOption())}</SelectValue>
      </SelectTrigger>
      <SelectContent mount={props.mount} />
    </Select>
  );
}

/**
 * One stopped run, in the layout of the panel that the ring had: the channel with the icon of its reason,
 * what it belongs to, the tab, the request with its chevron, and who had it. A box marks it.
 */
function StoppedWorkRow(props: {
  row: StoppedWorkEntry;
  checked: boolean;
  disabled: boolean;
  expanded: boolean;
  onToggle: () => void;
  onMark: (checked: boolean, range: boolean) => void;
}) {
  const { t } = useText();
  return (
    <li class="window-rail-load-item settings-load-row" data-selected={props.checked ? "" : undefined}>
      <Checkbox
        class="settings-load-check"
        checked={props.checked}
        disabled={props.disabled}
        aria-label={t("settings.load.select.row", { title: props.row.title || props.row.channelName })}
        onClick={(event) => props.onMark(event.currentTarget.checked, event.shiftKey)}
        // Shift with Space marks a range. The box would toggle on its own on the key up; the key down
        // that is handled here keeps it from doing so, and the mark comes from the selection.
        onKeyDown={(event) => {
          if (event.key !== " " || !event.shiftKey) return;
          event.preventDefault();
          props.onMark(!props.checked, true);
        }}
      />
      <div class="settings-load-row-body">
        <div class="window-rail-load-item-head">
          <span class="window-rail-load-item-name">{props.row.channelName}</span>
          <StoppedState work={props.row} />
          <Show when={props.row.orphan}>
            {(orphan) => (
              <Badge variant="destructive-light" title={t(ORPHAN_TEXT[orphan()][1])}>
                {t(ORPHAN_TEXT[orphan()][0])}
              </Badge>
            )}
          </Show>
          <Badge variant="outline">
            {props.row.origin === "routine"
              ? t("settings.load.origin.routine", { name: props.row.routineName ?? "" })
              : t("settings.load.origin.request")}
          </Badge>
        </div>
        <WorkTab name={props.row.topicName} />
        <Show when={props.row.title}>
          <WorkRequest request={props.row.title} expanded={props.expanded} onToggle={props.onToggle} />
        </Show>
        <Show when={props.row.agentName || props.row.auto}>
          <p class="window-rail-load-item-meta">
            <Show when={props.row.agentName}>
              {(agent) => <span>{t("app.rail.load.stoppedBy", { agent: agent() })}</span>}
            </Show>
            <Show when={props.row.auto === "waiting"}>
              <span>{t("app.rail.load.autoWaiting")}</span>
            </Show>
            <Show when={props.row.auto === "gave-up"}>
              <span data-tone="danger">{t("app.rail.load.autoGaveUp")}</span>
            </Show>
          </p>
        </Show>
      </div>
    </li>
  );
}
