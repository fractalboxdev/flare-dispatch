// The composition checks of specs/architecture.md: the components a control plane's configuration declares
// (FD-ARCH-001), the application ports each phase requires a Layer for (FD-ARCH-039, MAMEKO-HOST-046), the credentials
// no executor holds or receives (FD-ARCH-004, FD-ARCH-005) and when each class's workflow starts (FD-ARCH-019).
import {
  deploymentOf,
  poolAdmissionCaps,
  type Deployment,
  type Phase,
  type Profile,
} from "@fractalboxdev/flare-dispatch-profile";
import { Message } from "@fractalboxdev/mameko-protocol";
import { containerClassOf, type Finding } from "./drift.ts";
import type { WorkerConfig } from "./render.ts";

const fail = (check: string, path: string, detail: string): Finding => ({
  check,
  path,
  detail,
  severity: "failure",
});

/** The Durable Object classes of § Components, `TransparencyLog` from phase 4. */
export const durableObjectClasses = (phase: Phase): readonly string[] => [
  "ExecutionEngine",
  "ExecutorChannel",
  "EpochAnchor",
  "PoolController",
  "LivenessMonitor",
  "InstallationQuota",
  "IntakeUnits",
  "CacheLedger",
  ...(phase >= 4 ? ["TransparencyLog"] : []),
];

const arr = (v: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

/**
 * The dispatcher Worker's configuration against § Components: each Durable Object class bound, one Container class
 * per cloud pool, one D1 database, a KV namespace and the R2 buckets (FD-ARCH-001).
 */
export const architectureFindings = (
  worker: string,
  config: WorkerConfig,
  phase: Phase,
): readonly Finding[] => {
  const bound = new Set(
    arr((config["durable_objects"] as { bindings?: unknown } | undefined)?.bindings).map(
      (b) => b["class_name"],
    ),
  );
  const containers = new Set(arr(config["containers"]).map((c) => c["class_name"]));
  return [
    ...durableObjectClasses(phase)
      .filter((c) => !bound.has(c))
      .map((c) =>
        fail(
          "components",
          `${worker}.durable_objects.${c}`,
          `Durable Object class ${c} is not bound`,
        ),
      ),
    ...Object.keys(poolAdmissionCaps)
      .map(containerClassOf)
      .filter((c) => !containers.has(c))
      .map((c) =>
        fail("components", `${worker}.containers.${c}`, `Container class ${c} is not declared`),
      ),
    ...(arr(config["d1_databases"]).length === 1
      ? []
      : [
          fail(
            "components",
            `${worker}.d1_databases`,
            "the control plane has exactly one D1 database",
          ),
        ]),
    ...(arr(config["kv_namespaces"]).length >= 1
      ? []
      : [
          fail(
            "components",
            `${worker}.kv_namespaces`,
            "the profile document and runtime configuration need a KV namespace",
          ),
        ]),
    ...(["CACHE", "ARTIFACTS"] as const)
      .filter((b) => !arr(config["r2_buckets"]).some((r) => r["binding"] === b))
      .map((b) => fail("components", `${worker}.r2_buckets.${b}`, `R2 bucket ${b} is not bound`)),
  ];
};

/**
 * The application ports § Composition requires a Layer for in a phase. A `development` deployment supplies no
 * attestation verifier. The credential minter is required where a grant names an application credential, and no grant
 * of the profile does.
 */
export const requiredPorts = (
  phase: Phase,
  deployment: Deployment = "production",
): readonly string[] => [
  "actuator",
  "gate-decision-source",
  "configuration-source",
  "alarm-port",
  "actuator-rate-limit",
  "object-store-presigner",
  ...(phase >= 1 ? ["posture-source", "local-registration"] : []),
  ...(phase >= 1 && deployment === "production" ? ["attestation-verifier"] : []),
  ...(phase >= 2 ? ["writeback-gate", "reuse-policy"] : []),
  ...(phase >= 4 ? ["launcher:gha", "result-acceptance-check"] : []),
];

/** Each port the phase requires that the composition supplies no Layer for (FD-ARCH-039, MAMEKO-HOST-046). */
export const compositionFindings = (
  phase: Phase,
  supplied: readonly string[],
  deployment: Deployment = "production",
): readonly Finding[] =>
  requiredPorts(phase, deployment)
    .filter((p) => !supplied.includes(p))
    .map((p) => fail("composition", p, `phase ${phase} requires a Layer for ${p}`));

/** The bindings the App's appliers sign with: the App id var and the App key secret. */
export const APP_BINDINGS = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"] as const;

/** The bindings the object-store presigner signs with: two vars and the presign token's two secrets (FD-CACHE-091). */
export const PRESIGNER_BINDINGS = [
  "R2_ACCOUNT_ID",
  "CACHE_BUCKET_NAME",
  "R2_PRESIGN_ACCESS_KEY_ID",
  "R2_PRESIGN_SECRET_ACCESS_KEY",
] as const;

/**
 * The bindings of `names` the env leaves unset or empty. The Worker's `appOptionsOf` and `presignerConfigOf` decide
 * with it over the same constants, so the deploy check and the Worker's composition read one condition.
 */
export const unsetBindings = (env: object, names: readonly string[]): readonly string[] =>
  names.filter((n) => {
    const value: unknown = (env as Readonly<Record<string, unknown>>)[n];
    return value === undefined || value === null || value === "";
  });

const allSet = (env: object, names: readonly string[]) => unsetBindings(env, names).length === 0;

/**
 * The application ports the dispatcher's composition (`apps/control-plane/src/composition.ts`) supplies a Layer for
 * over an env of vars and secrets, by mameko port id, which configuration validation reads (MAMEKO-HOST-046). The
 * Worker reads its own env through it, and the deploy stage reads the rendered vars and the Worker's secrets.
 */
export const composedPorts = (env: object): readonly string[] => [
  // `ConfigurationSourceLive` and `GateDecisionSourceLive` from the profile package.
  "configuration-source",
  "gate-decision-source",
  // `alarmPortFromEnv` from this package.
  "alarm-port",
  // `githubLiveLayer`'s applier of every GitHub kind and its rate limit over the `InstallationQuota` objects.
  ...(allSet(env, APP_BINDINGS) ? ["actuator", "actuator-rate-limit"] : []),
  // `presignerLayer`: the cache package's `R2PresignerLive` under `ObjectStorePresignerLive`.
  ...(allSet(env, PRESIGNER_BINDINGS) ? ["object-store-presigner"] : []),
  // `PostureSource` and the agentic package's `localPortsLayer`.
  "posture-source",
  "local-registration",
  "writeback-gate",
  "reuse-policy",
  // `resultAcceptanceLayer`: the cache package's check over the D1 statement records.
  "result-acceptance-check",
];

/**
 * The env a deployed Worker runs with: the rendered configuration's vars and each secret the account holds for the
 * Worker, by name; a secret's value is write-only to the deploy, so each stands as a non-empty marker.
 */
export const renderedEnv = (
  config: WorkerConfig,
  secrets: readonly string[],
): Readonly<Record<string, unknown>> => ({
  ...(typeof config["vars"] === "object" && config["vars"] !== null
    ? (config["vars"] as Record<string, unknown>)
    : {}),
  ...Object.fromEntries(secrets.map((name) => [name, "secret"])),
});

/**
 * The deploy stage's composition check (FD-ARCH-039): each port the phase requires that the rendered env's
 * composition supplies no Layer for. The deployment is the rendered `DEPLOYMENT` var.
 */
export const deployedCompositionFindings = (
  worker: string,
  config: WorkerConfig,
  secrets: readonly string[],
  phase: Phase,
): readonly Finding[] => {
  const env = renderedEnv(config, secrets);
  const rendered = env["DEPLOYMENT"];
  const deployment = deploymentOf(typeof rendered === "string" ? rendered : undefined);
  const needs: Readonly<Record<string, readonly string[]>> = {
    actuator: APP_BINDINGS,
    "actuator-rate-limit": APP_BINDINGS,
    "object-store-presigner": PRESIGNER_BINDINGS,
  };
  return compositionFindings(phase, composedPorts(env), deployment).map((f) => {
    const unset = unsetBindings(env, needs[f.path] ?? []);
    return {
      ...f,
      path: `${worker}.ports.${f.path}`,
      detail: unset.length === 0 ? f.detail : `${f.detail}; unset: ${unset.join(", ")}`,
    };
  });
};

/** The Layers this package and `packages/profile` supply, by mameko port id. */
export const SUPPLIED_HERE: Readonly<Record<string, string>> = {
  "alarm-port": "@fractalboxdev/flare-dispatch-ops alarmPortLayer",
  "configuration-source": "@fractalboxdev/flare-dispatch-profile ConfigurationSourceLive",
  "gate-decision-source": "@fractalboxdev/flare-dispatch-profile GateDecisionSourceLive",
};

/** Field names that would carry a control-plane secret over the executor wire (FD-ARCH-005). */
export const SECRET_FIELD =
  /private[_-]?key|app[_-]?key|provider[_-]?key|provenance[_-]?key|launcher[_-]?credential|\bpem\b|client[_-]?secret|webhook[_-]?secret/i;

/** Every property name a schema's AST declares, at any depth. */
export const propertyNames = (ast: unknown): ReadonlySet<string> => {
  const names = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (node: unknown) => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (Array.isArray(record["propertySignatures"]))
      for (const p of record["propertySignatures"] as { name?: unknown }[])
        if (typeof p.name === "string") names.add(p.name);
    for (const value of Object.values(record)) walk(value);
  };
  walk(ast);
  return names;
};

/** The executor wire messages' fields that look like a control-plane secret; empty means none (FD-ARCH-005). */
export const secretWireFields = (schemaAst: unknown = Message.ast): readonly string[] =>
  [...propertyNames(schemaAst)].filter((n) => SECRET_FIELD.test(n)).sort();

/** The permissions of the one installation token an executor holds: read-only (FD-ARCH-004, FD-GH-002). */
export const LEASE_TOKEN_PERMISSIONS = {
  metadata: "read",
  contents: "read",
  pull_requests: "read",
  issues: "read",
  checks: "read",
  actions: "read",
} as const;

/** Whether an installation-token request for a lease asks for read access only, to one repository. */
export const leaseTokenRequestIsReadOnly = (request: {
  readonly repositories: readonly string[];
  readonly permissions: Readonly<Record<string, string>>;
}): boolean =>
  request.repositories.length === 1 &&
  Object.entries(request.permissions).every(
    ([perm, level]) => level === "read" && perm in LEASE_TOKEN_PERMISSIONS,
  );

/**
 * When each class's `Execution` workflow starts: at admission for a class whose deadline outcome is not `deferred`,
 * and at the winning device claim or at `stale_at` for a `deferred` class (FD-ARCH-019, MAMEKO-ARCH-037,
 * MAMEKO-ARCH-038).
 */
export const workflowStarts = (
  profile: Profile,
): Readonly<Record<string, "admission" | "claim-or-stale">> =>
  Object.fromEntries(
    profile.classes.map((c) => [
      c.name,
      c.terminal_outcome === "deferred" ? "claim-or-stale" : "admission",
    ]),
  );
