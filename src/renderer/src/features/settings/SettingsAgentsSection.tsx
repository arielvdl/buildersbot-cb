import {
  type BackgroundProcess,
  type ClientAgentModelOption,
  type ClientAgentSummary,
  LOCAL_SERVER_ID,
  type StartRetrySettings,
  type StartRetryState,
  type UpdateAgentInput,
} from "@openbot/contracts/ipc";
import type { GeneralSettingsValue } from "@openbot/ui/features/settings/app-settings";
import { BackgroundProcessesSection } from "@openbot/ui/features/settings/BackgroundProcessesSection";
import {
  type AgentDefaultChoice,
  type AgentDefaultSetting,
  type AgentDefaultsAgent,
  agentDefaultSettingTitle,
  SettingsAgentsTab,
} from "@openbot/ui/features/settings/SettingsAgentsTab";
import { StartRetrySettingsSection } from "@openbot/ui/features/settings/StartRetrySettings";
import { currentText, useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createEffect, createStore, Show } from "solid-js";
import { actionToast } from "../../action-toast";
import { settingsPort } from "./settings-port";

interface AgentsSectionState {
  agents: AgentDefaultsAgent[];
  loadFailed: boolean;
  setting: AgentDefaultSetting | null;
  /** Null until the first answer, and where this computer cannot list them (Windows). */
  processes: BackgroundProcess[] | null;
  processesFailed: boolean;
  stopping: string[];
  /** The retries and backup model of a start that fails. Null until the first answer. */
  startRetry: StartRetryState | null;
  models: ClientAgentModelOption[];
  /** The backup models of the local agents, for the list of the start retry section. */
  backups: Pick<ClientAgentSummary, "id" | "name" | "backupModels">[];
}

export interface SettingsAgentsSection {
  Panel: (props: { menuMount: HTMLElement | undefined }) => JSX.Element;
  /** The setting page, for the dialog header `Agents › Local scripts`. */
  crumb: () => { title: string; back: () => void } | null;
  /** Closes the setting page, so that a requested tab, such as a search result, opens on the list. */
  showList: () => void;
}

function updateFor(agentId: string, setting: AgentDefaultSetting, choice: AgentDefaultChoice): UpdateAgentInput {
  if (setting === "busyMessageMode") {
    return { agentId, busyMessageMode: choice === "default" ? null : choice === "on" ? "steer" : "queue" };
  }
  return { agentId, [setting]: choice === "default" ? null : choice === "on" };
}

function showAgentSaveFailure(error: unknown): void {
  const { t, errorMessage } = currentText();
  actionToast.error(errorMessage(error, t("agent.error.settingsFailed")), {
    id: "settings-agent-defaults-save-failed",
    report: { operation: "settings", source: "action", cause_code: "unknown" },
  });
}

/**
 * Settings › Agents: the defaults of the agents on this computer, and each agent's own value. The
 * tab reads the local agents each time it shows, whichever server is open.
 */
export function createSettingsAgentsSection(options: {
  visible: () => boolean;
  value: () => GeneralSettingsValue;
  onValueChange: (value: GeneralSettingsValue) => void;
}): SettingsAgentsSection {
  const { t } = useText();
  const [state, setState] = createStore<AgentsSectionState>({
    agents: [],
    loadFailed: false,
    setting: null,
    processes: null,
    processesFailed: false,
    stopping: [],
    startRetry: null,
    models: [],
    backups: [],
  });
  /** Bumped for each read, so an answer of an earlier read is dropped. */
  let generation = 0;
  let processGeneration = 0;

  function applyAgent(agent: ClientAgentSummary): void {
    setState((draft) => {
      const index = draft.agents.findIndex((item) => item.id === agent.id);
      if (index !== -1) draft.agents[index] = agent;
    });
  }

  function load(): void {
    const current = ++generation;
    settingsPort()
      .agent.listAgents(LOCAL_SERVER_ID)
      .then((agents) => {
        if (current !== generation) return;
        setState((draft) => {
          draft.agents = agents;
          draft.backups = agents.map(({ id, name, backupModels }) => ({
            id,
            name,
            ...(backupModels ? { backupModels } : {}),
          }));
          draft.loadFailed = false;
        });
      })
      .catch(() => {
        if (current !== generation) return;
        setState((draft) => {
          draft.loadFailed = true;
        });
      });
  }

  function loadProcesses(): void {
    const current = ++processGeneration;
    settingsPort()
      .backgroundProcesses.list()
      .then((processes) => {
        if (current !== processGeneration) return;
        setState((draft) => {
          draft.processes = processes;
          draft.processesFailed = false;
        });
      })
      .catch(() => {
        if (current !== processGeneration) return;
        setState((draft) => {
          draft.processes = [];
          draft.processesFailed = true;
        });
      });
  }

  function stopProcess(id: string): void {
    setState((draft) => {
      draft.stopping.push(id);
    });
    settingsPort()
      .backgroundProcesses.stop(id)
      .catch((error: unknown) => {
        const { t, errorMessage } = currentText();
        actionToast.error(errorMessage(error, t("settings.backgroundProcesses.stopFailed")), {
          id: "settings-background-process-stop-failed",
          report: { operation: "settings", source: "action", cause_code: "unknown" },
        });
      })
      .finally(() => {
        setState((draft) => {
          draft.stopping = draft.stopping.filter((item) => item !== id);
        });
        loadProcesses();
      });
  }

  function loadStartRetry(): void {
    settingsPort()
      .getStartRetry()
      .then((startRetry) =>
        setState((draft) => {
          draft.startRetry = startRetry;
        }),
      )
      .catch(() => {});
    settingsPort()
      .agent.listModels(LOCAL_SERVER_ID)
      .then((models) =>
        setState((draft) => {
          draft.models = models;
        }),
      )
      .catch(() => {});
  }

  function changeStartRetry(settings: StartRetrySettings): void {
    settingsPort()
      .setStartRetry(settings)
      .then((startRetry) =>
        setState((draft) => {
          draft.startRetry = startRetry;
        }),
      )
      .catch((error: unknown) => {
        showAgentSaveFailure(error);
        loadStartRetry();
      });
  }

  function showList(): void {
    setState((draft) => {
      draft.setting = null;
    });
  }

  createEffect(options.visible, (visible) => {
    if (visible) {
      load();
      loadProcesses();
      loadStartRetry();
    } else showList();
  });

  function changeDefault(setting: AgentDefaultSetting, on: boolean): void {
    const value = options.value();
    if (setting === "busyMessageMode") {
      options.onValueChange({ ...value, busyMessageMode: on ? "steer" : "queue" });
      return;
    }
    options.onValueChange({ ...value, agentDefaults: { ...value.agentDefaults, [setting]: on } });
  }

  function changeChoice(agentIds: readonly string[], setting: AgentDefaultSetting, choice: AgentDefaultChoice): void {
    for (const agentId of agentIds) {
      settingsPort()
        .agent.updateAgent(updateFor(agentId, setting, choice), LOCAL_SERVER_ID)
        .then(applyAgent)
        .catch((error: unknown) => {
          showAgentSaveFailure(error);
          load();
        });
    }
  }

  return {
    Panel: (props) => (
      <>
        <SettingsAgentsTab
          agents={state.agents}
          loadFailed={state.loadFailed}
          defaults={options.value().agentDefaults}
          steer={options.value().busyMessageMode === "steer"}
          setting={state.setting}
          menuMount={props.menuMount}
          onOpen={(setting) =>
            setState((draft) => {
              draft.setting = setting;
            })
          }
          onDefaultChange={changeDefault}
          onChoiceChange={changeChoice}
        />
        <Show when={!state.setting}>
          <StartRetrySettingsSection
            state={state.startRetry}
            models={state.models}
            agents={state.backups}
            selectMount={props.menuMount}
            onChange={changeStartRetry}
          />
        </Show>
        <Show when={!state.setting && state.processes}>
          {(processes) => (
            <BackgroundProcessesSection
              processes={processes()}
              loadFailed={state.processesFailed}
              agents={state.agents}
              stopping={state.stopping}
              onStop={stopProcess}
            />
          )}
        </Show>
      </>
    ),
    crumb() {
      const setting = state.setting;
      if (!setting) return null;
      return { title: t(agentDefaultSettingTitle(setting)), back: showList };
    },
    showList,
  };
}
