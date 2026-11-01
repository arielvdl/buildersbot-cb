// The model policy of a server: the providers and models that its picker offers.
//
// A company server offers only what its administrator allowed. The administrator writes one JSON file
// on the host and gives the app its path in `OPENBOT_MODEL_POLICY_FILE`. On a container of
// `openbot-instance`, the file is in a read-only mount, so an agent of the server cannot change it.
// The app reads the file once, when it starts.
//
// With no path, or no file at the path, there is no policy, and every provider and model works as
// before. A file that is present but not valid does not open everything: the app then uses
// `SAFE_DEFAULT_POLICY`, which offers only the Cultura Builder gateway.
//
// The policy is not the security boundary of the Cultura Builder models. The gateway of the Hub
// decides which models an account can call, on each request. The policy decides what this server
// offers and which provider processes it starts.

import { readFile } from "node:fs/promises";
import {
  type AgentModelOption,
  type AgentProviderId,
  isAgentModel,
  isAgentProvider,
  isFreeOpencodeModel,
} from "@openbot/contracts/ipc";
import { createBuildersBotLogger } from "@openbot/logging";
import { Effect, Option, Schema } from "effect";
import { isMissingFileError } from "../file-errors";

const logger = createBuildersBotLogger("provider-runtime");

/** The environment variable that names the policy file. */
export const MODEL_POLICY_FILE_ENV = "OPENBOT_MODEL_POLICY_FILE";

/** A policy file is a few lines. A larger file is not a policy. */
const POLICY_LIMIT_BYTES = 64 * 1024;
/** More model ids than any provider lists. */
const MODELS_PER_PROVIDER_LIMIT = 200;

/** `"*"`: every model that the provider lists. A list: only these model ids. */
export type ProviderModelRule = "*" | readonly string[];

export interface ServerModelPolicy {
  /** The providers that the server runs, with the models it offers from each. */
  readonly providers: ReadonlyMap<AgentProviderId, ProviderModelRule>;
  /**
   * Whether `"*"` includes the free models of OpenCode. A model id that the policy names is offered
   * in all cases.
   */
  readonly freeModels: boolean;
  /** Why the app uses this policy, for the log. */
  readonly source: "file" | "safe-default";
}

/**
 * The policy of a policy file that is not valid: the Cultura Builder gateway only. The gateway
 * gives each account only the models that the Hub allows it, so this default opens nothing more.
 */
export const SAFE_DEFAULT_POLICY: ServerModelPolicy = {
  providers: new Map([["cultura-builder", "*"]]),
  freeModels: false,
  source: "safe-default",
};

const PolicyFile = Schema.Struct({
  version: Schema.Literal(1),
  providers: Schema.Record(Schema.String, Schema.Union([Schema.Literal("*"), Schema.Array(Schema.String)])),
  freeModels: Schema.optional(Schema.Boolean),
});

/**
 * The policy in `value`, or null when it is not a valid policy. An unknown provider id and a model id
 * that the contract refuses make the file not valid: a policy that the app reads in part is a policy
 * that the administrator did not write.
 */
export function decodeServerModelPolicy(value: unknown): ServerModelPolicy | null {
  const file = Option.getOrNull(Schema.decodeUnknownOption(PolicyFile)(value));
  if (!file) return null;
  const providers = new Map<AgentProviderId, ProviderModelRule>();
  for (const [provider, rule] of Object.entries(file.providers)) {
    if (!isAgentProvider(provider)) return null;
    if (rule === "*") {
      providers.set(provider, "*");
      continue;
    }
    if (rule.length > MODELS_PER_PROVIDER_LIMIT || !rule.every((id) => isAgentModel(id))) return null;
    providers.set(provider, [...new Set(rule)]);
  }
  return { providers, freeModels: file.freeModels ?? false, source: "file" };
}

/**
 * Reads the policy at `path`. No path, and no file at the path, are no policy. A file that cannot be
 * read or decoded is `SAFE_DEFAULT_POLICY`, and the log says why without quoting the file.
 */
export const loadServerModelPolicy = Effect.fn("ServerModelPolicy.load")(function* (path: string | undefined) {
  if (!path) return null;
  const text = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((value): string | null => value),
    Effect.catch((cause) => {
      if (isMissingFileError(cause)) return Effect.succeed(null);
      logger.warn("The model policy file could not be read. The server offers the Cultura Builder gateway only.", {
        error: cause instanceof Error ? cause.name : "unknown",
      });
      return Effect.succeed("");
    }),
  );
  if (text === null) {
    logger.info("No model policy file. Every provider is offered.");
    return null;
  }
  let policy: ServerModelPolicy | null = null;
  if (text.length > 0 && text.length <= POLICY_LIMIT_BYTES) {
    try {
      policy = decodeServerModelPolicy(JSON.parse(text));
    } catch {
      policy = null;
    }
  }
  if (!policy) {
    logger.warn("The model policy file is not valid. The server offers the Cultura Builder gateway only.");
    return SAFE_DEFAULT_POLICY;
  }
  logger.info("The server uses a model policy.", {
    providers: [...policy.providers.keys()],
    freeModels: policy.freeModels,
  });
  return policy;
});

/** The built-in providers that the policy does not name. The server does not start them. */
export function providersOffByPolicy(
  policy: ServerModelPolicy | null,
  providers: readonly AgentProviderId[],
): AgentProviderId[] {
  if (!policy) return [];
  return providers.filter((provider) => !policy.providers.has(provider));
}

/** Whether the server offers `model`. With no policy, it offers every model. */
export function policyAllowsModel(
  policy: ServerModelPolicy | null,
  model: Pick<AgentModelOption, "provider" | "id" | "name">,
): boolean {
  if (!policy) return true;
  const rule = isAgentProvider(model.provider) ? policy.providers.get(model.provider) : undefined;
  if (!rule) return false;
  if (rule !== "*") return rule.includes(model.id);
  if (model.provider === "opencode" && !policy.freeModels) return !isFreeOpencodeModel(model.id, model.name);
  return true;
}
