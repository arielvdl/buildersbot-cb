import { DEFAULT_START_RETRY_SETTINGS, isStartRetrySettings, type StartRetrySettings } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { isStoredStartBreaker, type StoredStartBreaker } from "../backend/agent/start-retry";
import { PreferenceStore } from "./preference-file";

/** The start retry settings of the agents. */
export const START_RETRY_PREFERENCE_FILE = "openbot-agent-start-retry-v1.json";
/** The breakers of the agents' own models: ids, models and times, never text. */
export const START_BREAKERS_FILE = "openbot-agent-start-breakers-v1.json";
const BREAKER_LIMIT = 200;

/**
 * The start retry settings (`docs/architecture/agents.md#start-retry`). A file that is missing,
 * damaged, of another version or with a value out of range reads as the default: 3 tries again, a
 * usage limit tried again, no default backup.
 */
export function createStartRetryPreferenceStore(path: string): PreferenceStore<StartRetrySettings> {
  return new PreferenceStore<StartRetrySettings>({
    path,
    defaultValue: DEFAULT_START_RETRY_SETTINGS,
    decode: (parsed) =>
      isDynamicRecord(parsed) && parsed.version === 1 && isStartRetrySettings(parsed)
        ? startRetrySettings(parsed)
        : null,
  });
}

/** Only the known fields, so the file keeps no other value. */
export function startRetrySettings(value: StartRetrySettings): StartRetrySettings {
  return {
    retries: value.retries,
    firstDelaySeconds: value.firstDelaySeconds,
    maxDelaySeconds: value.maxDelaySeconds,
    retryAfterUsageLimit: value.retryAfterUsageLimit,
    defaultFallback: value.defaultFallback
      ? {
          provider: value.defaultFallback.provider,
          model: value.defaultFallback.model,
          ...(value.defaultFallback.providerAccountId
            ? { providerAccountId: value.defaultFallback.providerAccountId }
            : {}),
          ...(value.defaultFallback.reasoningEffort ? { reasoningEffort: value.defaultFallback.reasoningEffort } : {}),
        }
      : null,
    breakerMinutes: [...value.breakerMinutes],
    resumeUncertainActions: value.resumeUncertainActions === true,
  };
}

/** The breakers that a restart keeps. An entry that does not decode is left out. */
export function createStartBreakerStore(path: string): PreferenceStore<{ breakers: StoredStartBreaker[] }> {
  return new PreferenceStore<{ breakers: StoredStartBreaker[] }>({
    path,
    defaultValue: { breakers: [] },
    decode: (parsed) =>
      isDynamicRecord(parsed) && parsed.version === 1 && Array.isArray(parsed.breakers)
        ? { breakers: parsed.breakers.filter(isStoredStartBreaker).slice(0, BREAKER_LIMIT) }
        : null,
  });
}
