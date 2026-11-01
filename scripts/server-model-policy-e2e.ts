// Checks the model policy of a server end to end, on the real drivers, `ProviderRuntime` and policy
// file loader, with a fake bundled Builders CLI and a fake Hub gateway.
//
// The production server "CB marketing" offered the free models of OpenCode and no Cultura Builder
// model. The policy lets the administrator of a server choose what its picker offers:
//
// 1. With no policy (no path, or no file at the path), nothing changes: OpenCode offers its free
//    models, Cultura Builder offers its built-in models, and the gateway catalog is not read.
// 2. With `{ "cultura-builder": "*" }`, OpenCode is off and cannot be turned on, its free models are
//    not offered and cannot start an agent, and the Cultura Builder models are the gateway catalog of
//    the signed-in account. An account that the Hub granted a restricted model sees it; another
//    account does not.
// 3. When the gateway does not answer the catalog, only the built-in Cultura Builder models are
//    offered, never a restricted one.
// 4. `"*"` for OpenCode offers its paid models and not its free ones, unless the policy names one.
// 5. A policy file that is not valid offers only the Cultura Builder gateway.
//
// `bun run test:server-model-policy`. Writes .openbot-build/server-model-policy-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentModelOption } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result } from "effect";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { creationModel } from "../src/backend/agent/model-choice";
import { ProviderRuntime } from "../src/backend/agent/provider-runtime";
import { loadServerModelPolicy, type ServerModelPolicy } from "../src/backend/agent/server-model-policy";
import { AgentStore } from "../src/backend/agent-store";
import {
  CULTURA_BUILDER_GATEWAY,
  CulturaBuilderCatalog,
  serializeCulturaBuilderSession,
} from "../src/backend/cultura-builder-auth";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { BuildersBotDatabase } from "../src/backend/openbot-database";
import { BUILT_IN_PROVIDER_DRIVERS, NO_PROVIDER_CREDENTIALS } from "../src/backend/provider-drivers";
import { installFakeAgent } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/server-model-policy-e2e");
const SESSION_URL = `${CULTURA_BUILDER_GATEWAY}/session`;
const MODELS_URL = `${CULTURA_BUILDER_GATEWAY}/models`;
const COMPANY = "CB marketing";

/** The access tokens of the fake Hub. */
const ACCESS = {
  /** An account that the Hub granted the restricted DeepSeek model. */
  granted: "access-granted",
  /** An account with the LLM and no restricted model. */
  plain: "access-plain",
} as const;

/** What the gateway lists for each account: `/v1/models` filters the catalog per account. */
const GATEWAY_MODELS = new Map<string, ReturnType<typeof gatewayModel>[]>([
  [
    ACCESS.granted,
    [
      gatewayModel("builder-auto", "Cultura Builder LLM", true),
      gatewayModel("builder-deepseek-uncensored", "DeepSeek V4.1 Flash (sem censura)", false),
    ],
  ],
  [ACCESS.plain, [gatewayModel("builder-auto", "Cultura Builder LLM", true)]],
]);

const BUILT_IN_CULTURA = [
  "cultura-builder/builder-auto",
  "cultura-builder/builder-plan",
  "cultura-builder/builder-code",
  "cultura-builder/builder-fast",
  "cultura-builder/builder-review",
];
const OPENCODE_FREE = ["opencode/flint-40b-free", "opencode/glm-5.3-flash-free", "opencode/big-pickle"];
const OPENCODE_PAID = "opencode-go/kimi-k2.6";

function gatewayModel(id: string, name: string, vision: boolean) {
  return {
    id,
    object: "model",
    owned_by: "cultura-builder",
    name,
    context_length: 1_048_576,
    max_output_tokens: 32_768,
    capabilities: { vision, native_vision: vision, tools: true, reasoning: true, streaming: true },
  };
}

interface CaseReport {
  models: string[];
  opencodeRow?: { state: string | undefined; off: boolean | undefined };
  culturaRow?: { state: string | undefined };
  catalogCalls: number;
  refusals?: Record<string, string>;
}

interface Report {
  passed: boolean;
  noPolicy?: CaseReport;
  missingPolicyFile?: CaseReport;
  policyGranted?: CaseReport;
  policyPlainAccount?: CaseReport;
  policyGatewayDown?: CaseReport;
  policyOpencodeStar?: CaseReport;
  policyOpencodeNamedFree?: CaseReport;
  invalidPolicy?: CaseReport;
}

const root = await mkdtemp(join(tmpdir(), "openbot-server-model-policy-e2e-"));
const report: Report = { passed: false };
let stored: string | null = null;
let gatewayDown = false;
let catalogCalls = 0;
process.env.FAKE_LOG = join(root, "builders.jsonl");

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The Hub gateway. A request to any other address fails, so the test never reaches the network. */
async function fakeHub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /u, "") ?? "";
  const listed = GATEWAY_MODELS.get(bearer);
  if (url === SESSION_URL) return listed ? json(200, { active: true, empresa: COMPANY }) : json(401, {});
  if (url === MODELS_URL) {
    catalogCalls += 1;
    if (gatewayDown) return json(503, { error: { code: "identity_unavailable" } });
    return listed ? json(200, { object: "list", data: listed }) : json(401, {});
  }
  throw new Error(`The test reached the network: ${url}`);
}

globalThis.fetch = Object.assign(fakeHub, { preconnect: () => undefined });

/** The two providers that run the Builders CLI are on, as on the server; the others stay off. */
const OTHERS_OFF = BUILT_IN_PROVIDER_DRIVERS.map((driver) => driver.id).filter(
  (id) => id !== "cultura-builder" && id !== "opencode",
);

function runtime(executable: string, policy: ServerModelPolicy | null): ProviderRuntime {
  const store = new AgentStore(
    join(root, "profile"),
    join(root, "home"),
    new BuildersBotDatabase(join(root, "profile")),
  );
  return new ProviderRuntime({
    offProviders: OTHERS_OFF,
    modelPolicy: policy,
    conversation: new ConversationRuntime(
      store,
      () => undefined,
      () => store.list(),
    ),
    hooks: {
      bindClient: () => undefined,
      onProvidersReady: () => Effect.void,
      onProviderLost: () => undefined,
      onClientStopped: () => Effect.void,
      isStopping: () => false,
      isProviderBusy: () => false,
      isAgentBusy: () => false,
      isProviderAssigned: () => false,
      onAgentClientLost: () => Effect.void,
      sharedRoot: () => join(root, "shared"),
      onProviderResumed: () => undefined,
      onProviderActivated: () => Effect.void,
      captureConfigRevision: () => 0,
    },
    emit: () => undefined,
    emitError: () => undefined,
    requestTimeoutMs: 10_000,
    preferredProvider: "cultura-builder",
    clientFactory: null,
    bundledExecutables: { opencode: executable },
    credentials: {
      ...NO_PROVIDER_CREDENTIALS,
      apiKey: (provider) => (provider === "cultura-builder" ? stored : null),
      saveApiKey: (provider, value) =>
        Effect.sync(() => {
          if (provider === "cultura-builder") stored = value;
        }),
      // As main does: the catalog of the account only on a server with a policy.
      ...(policy ? { culturaBuilderCatalog: new CulturaBuilderCatalog() } : {}),
    },
    redactMcp: (text) => text,
  });
}

async function stopAll(providers: ProviderRuntime): Promise<void> {
  for (const client of await runCauseEffect(providers.dispose())) await runCauseEffect(client.stop());
}

const ids = (models: readonly AgentModelOption[]) => models.map((model) => model.id).sort();

/** The text of the error that `effect` fails with, or "no refusal" when it succeeds. */
async function refusal(effect: Effect.Effect<unknown, { readonly cause?: unknown }>): Promise<string> {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isSuccess(result)) return "no refusal";
  const cause = result.failure.cause;
  return cause instanceof Error ? cause.message : String(cause);
}

function creationRefusal(providers: ProviderRuntime, provider: "opencode" | "cultura-builder", model: string): string {
  try {
    creationModel({ provider, model }, providers.listModels(), providers.status().providers ?? []);
    return "no refusal";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Starts a runtime as the server does, signed in with `access`, and reads what it offers. */
async function run(
  executable: string,
  policy: ServerModelPolicy | null,
  access: string,
  check?: (providers: ProviderRuntime, entry: CaseReport) => Promise<void>,
): Promise<CaseReport> {
  stored = serializeCulturaBuilderSession({ access, refresh: "", expires: Date.now() + 3_600_000, empresa: COMPANY });
  catalogCalls = 0;
  const providers = runtime(executable, policy);
  try {
    await runCauseEffect(providers.start());
    const rows = providers.status().providers ?? [];
    const opencode = rows.find((row) => row.id === "opencode");
    const cultura = rows.find((row) => row.id === "cultura-builder");
    const entry: CaseReport = {
      models: ids(providers.listModels()),
      opencodeRow: { state: opencode?.state, off: opencode?.off },
      culturaRow: { state: cultura?.state },
      catalogCalls,
    };
    await check?.(providers, entry);
    return entry;
  } finally {
    await stopAll(providers);
  }
}

async function policyFile(name: string, body: unknown): Promise<string> {
  const path = join(root, name);
  await writeFile(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

const load = (path: string | undefined) => runCauseEffect(loadServerModelPolicy(path));

try {
  const executable = join(root, "builders", "bin", "opencode");
  await mkdir(join(root, "profile"), { recursive: true });
  await installFakeAgent(executable, "model-policy");
  const offByPolicy = sourceText("error.provider.offByServerPolicy", { provider: "Builders" });

  // 1. No policy: what the server offers today.
  report.noPolicy = await run(executable, await load(undefined), ACCESS.granted);
  assert.deepEqual(report.noPolicy.models, [...BUILT_IN_CULTURA, OPENCODE_PAID, ...OPENCODE_FREE].sort());
  assert.equal(report.noPolicy.catalogCalls, 0, "with no policy, the gateway catalog is not read");
  assert.equal(report.noPolicy.culturaRow?.state, "available");
  assert.equal(report.noPolicy.opencodeRow?.state, "available");

  // A path with no file is no policy, so an image with the mount and no file changes nothing.
  const missing = await load(join(root, "no-such-policy.json"));
  assert.equal(missing, null, "a path with no file is no policy");
  report.missingPolicyFile = await run(executable, missing, ACCESS.granted);
  assert.deepEqual(report.missingPolicyFile.models, report.noPolicy.models);

  // 2. The policy of a company server: the Cultura Builder gateway only.
  const companyPolicy = await load(
    await policyFile("company.json", { version: 1, providers: { "cultura-builder": "*" } }),
  );
  assert.ok(companyPolicy, "the policy file is read");
  report.policyGranted = await run(executable, companyPolicy, ACCESS.granted, async (providers, entry) => {
    entry.refusals = {
      turnOnOpencode: await refusal(providers.setProviderOn("opencode", true)),
      createOnFreeModel: creationRefusal(providers, "opencode", "opencode/flint-40b-free"),
      createOnGrantedModel: creationRefusal(
        providers,
        "cultura-builder",
        "cultura-builder/builder-deepseek-uncensored",
      ),
    };
  });
  assert.deepEqual(report.policyGranted.models, [
    "cultura-builder/builder-auto",
    "cultura-builder/builder-deepseek-uncensored",
  ]);
  assert.equal(report.policyGranted.opencodeRow?.off, true, "a provider that the policy does not name is off");
  assert.equal(report.policyGranted.refusals?.turnOnOpencode, offByPolicy, "and a person cannot turn it on");
  assert.notEqual(report.policyGranted.refusals?.createOnFreeModel, "no refusal", "a free model starts no agent");
  assert.equal(report.policyGranted.refusals?.createOnGrantedModel, "no refusal", "a granted model starts an agent");
  assert.ok(report.policyGranted.catalogCalls >= 1, "the gateway catalog of the account is read");

  // The same server, signed in with an account that has no restricted model.
  report.policyPlainAccount = await run(executable, companyPolicy, ACCESS.plain, async (providers, entry) => {
    entry.refusals = {
      createOnRestricted: creationRefusal(providers, "cultura-builder", "cultura-builder/builder-deepseek-uncensored"),
    };
  });
  assert.deepEqual(report.policyPlainAccount.models, ["cultura-builder/builder-auto"]);
  assert.notEqual(report.policyPlainAccount.refusals?.createOnRestricted, "no refusal");

  // 3. The gateway does not answer the catalog: the built-in models only, never a restricted one.
  gatewayDown = true;
  report.policyGatewayDown = await run(executable, companyPolicy, ACCESS.granted);
  gatewayDown = false;
  assert.deepEqual(report.policyGatewayDown.models, [...BUILT_IN_CULTURA].sort());

  // 4. OpenCode with "*": its paid models, not its free ones. A free model that the policy names is offered.
  report.policyOpencodeStar = await run(
    executable,
    await load(await policyFile("star.json", { version: 1, providers: { "cultura-builder": "*", opencode: "*" } })),
    ACCESS.plain,
  );
  assert.deepEqual(report.policyOpencodeStar.models, ["cultura-builder/builder-auto", OPENCODE_PAID]);
  report.policyOpencodeNamedFree = await run(
    executable,
    await load(await policyFile("named.json", { version: 1, providers: { opencode: ["opencode/flint-40b-free"] } })),
    ACCESS.plain,
  );
  assert.deepEqual(report.policyOpencodeNamedFree.models, ["opencode/flint-40b-free"]);

  // 5. A policy file that is not valid offers the Cultura Builder gateway only.
  const invalid = await load(await policyFile("invalid.json", { version: 1, providers: { "no-such-provider": "*" } }));
  assert.equal(invalid?.source, "safe-default");
  report.invalidPolicy = await run(executable, invalid, ACCESS.plain);
  assert.deepEqual(report.invalidPolicy.models, ["cultura-builder/builder-auto"]);
  assert.equal(report.invalidPolicy.opencodeRow?.off, true);

  report.passed = true;
} finally {
  await rm(root, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
