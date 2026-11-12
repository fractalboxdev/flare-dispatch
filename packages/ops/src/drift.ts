// The drift check: a rendered configuration against the template's invariants, the environment schema, the pool
// caps and mameko's profile validator; the deployed Workers against the record of the last deploy; and the GitHub
// App's registration against the committed manifest (specs/operability.md § Drift check). Every check here is a pure
// function of what it compares; `fd deploy` and `fd doctor` read the inputs through the ports of deploy.ts.
import {
  checkRegistry,
  validateDeclaration,
  type RegistryEntry,
} from "@fractalboxdev/flare-dispatch-agentic";
import {
  loadProfile,
  poolAdmissionCaps,
  profileLoader,
  type ValidationContext,
} from "@fractalboxdev/flare-dispatch-profile";
import type { ProfileDocument } from "@fractalboxdev/mameko-ports";
import { Effect, Schema } from "effect";
import {
  accessChanges,
  accessShape,
  type CommittedAccess,
  type DeployedAccessApplication,
} from "./access-application.ts";
import { placeholdersOf, type WorkerConfig } from "./render.ts";

/** One finding of the drift check. A `warning` is reported and does not fail the check (FD-OPS-023). */
export const Finding = Schema.Struct({
  check: Schema.String,
  path: Schema.String,
  detail: Schema.String,
  severity: Schema.Literals(["failure", "warning"]),
});
export type Finding = typeof Finding.Type;

const fail = (check: string, path: string, detail: string): Finding => ({
  check,
  path,
  detail,
  severity: "failure",
});

const isPlaceholder = (v: unknown): boolean => typeof v === "string" && /^\{\{[^}]+\}\}$/.test(v);

const arr = (v: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

/** The account-specific fields of a Worker template, each of which must be a placeholder (FD-OPS-001). */
const accountSpecific = (c: WorkerConfig): readonly { path: string; value: unknown }[] => [
  ...("account_id" in c ? [{ path: "account_id", value: c["account_id"] }] : []),
  ...arr(c["d1_databases"]).map((d, i) => ({
    path: `d1_databases[${i}].database_id`,
    value: d["database_id"],
  })),
  ...arr(c["kv_namespaces"]).map((k, i) => ({ path: `kv_namespaces[${i}].id`, value: k["id"] })),
  ...arr(c["r2_buckets"]).map((b, i) => ({
    path: `r2_buckets[${i}].bucket_name`,
    value: b["bucket_name"],
  })),
  ...arr(c["routes"]).map((r, i) => ({ path: `routes[${i}].pattern`, value: r["pattern"] })),
];

/** The cron set every template with a Worker script declares: the single minute tick (FD-INT-050). */
export const MINUTE_TICK = "* * * * *";

const cronsOf = (c: WorkerConfig): readonly string[] => {
  const triggers = c["triggers"];
  return typeof triggers === "object" &&
    triggers !== null &&
    Array.isArray((triggers as { crons?: unknown }).crons)
    ? (triggers as { crons: string[] }).crons
    : [];
};

/**
 * The template's own invariants (FD-OPS-001, FD-OPS-012, FD-INT-050). The minute-tick check applies to every template
 * but a static-assets one (`assets` and no `main`): that Worker, such as the documentation site, runs no scheduled
 * handler, so any cron trigger on it fails the check.
 */
export const templateInvariants = (worker: string, template: WorkerConfig): readonly Finding[] => [
  ...accountSpecific(template)
    .filter((f) => !isPlaceholder(f.value))
    .map((f) =>
      fail("placeholder", `${worker}.${f.path}`, "an account-specific value is not a placeholder"),
    ),
  ...(template["keep_vars"] === false
    ? []
    : [fail("keep_vars", `${worker}.keep_vars`, "every template sets keep_vars to false")]),
  ...(isStaticAssets(template)
    ? staticCronCheck(worker, cronsOf(template))
    : cronCheck(worker, cronsOf(template))),
];

/** A Worker that serves static assets with no Worker script. */
const isStaticAssets = (c: WorkerConfig): boolean =>
  c["main"] === undefined && c["assets"] !== undefined;

/** A cron trigger on a Worker with no script, which has no scheduled handler to run. */
const staticCronCheck = (worker: string, crons: readonly string[]): readonly Finding[] =>
  crons.length === 0
    ? []
    : [
        fail(
          "cron",
          `${worker}.triggers.crons`,
          `cron set ${JSON.stringify(crons)} on a Worker with no script`,
        ),
      ];

/** A cron set other than the single minute tick (FD-INT-050). */
export const cronCheck = (worker: string, crons: readonly string[]): readonly Finding[] =>
  crons.length === 1 && crons[0] === MINUTE_TICK
    ? []
    : [
        fail(
          "cron",
          `${worker}.triggers.crons`,
          `cron set ${JSON.stringify(crons)} is not ["${MINUTE_TICK}"]`,
        ),
      ];

/** Every binding name a configuration declares. */
export const bindingsOf = (c: WorkerConfig): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const key of [
    "d1_databases",
    "kv_namespaces",
    "r2_buckets",
    "services",
    "queues",
    "send_email",
  ])
    for (const b of arr(c[key]))
      if (typeof b["binding"] === "string") names.add(b["binding"]);
      else if (typeof b["name"] === "string") names.add(b["name"]);
  const dobs = (c["durable_objects"] as { bindings?: unknown } | undefined)?.bindings;
  for (const b of arr(dobs)) if (typeof b["name"] === "string") names.add(b["name"]);
  const vars = c["vars"];
  if (typeof vars === "object" && vars !== null) for (const k of Object.keys(vars)) names.add(k);
  return names;
};

/** A binding the control plane's environment schema declares and the rendered configuration lacks (FD-OPS-019). */
export const bindingCheck = (
  worker: string,
  rendered: WorkerConfig,
  declared: readonly string[],
): readonly Finding[] => {
  const present = bindingsOf(rendered);
  return declared
    .filter((b) => !present.has(b))
    .map((b) => fail("binding", `${worker}.${b}`, `binding ${b} is absent`));
};

/** The Container class that backs a pool: `<Pool>Pool`, as `lean` → `LeanPool`. */
export const containerClassOf = (pool: string): string =>
  `${pool.charAt(0).toUpperCase()}${pool.slice(1)}Pool`;

/**
 * Each pool's admission cap must be strictly below its Container class's `max_instances` (FD-OPS-020, FD-PROF-033,
 * MAMEKO-ADM-046); a pool with no Container class fails too (FD-ARCH-001).
 */
export const admissionCapCheck = (
  worker: string,
  rendered: WorkerConfig,
  caps: Readonly<Record<string, { readonly admission_cap: number }>> = poolAdmissionCaps,
): readonly Finding[] => {
  const containers = arr(rendered["containers"]);
  return Object.entries(caps).flatMap(([pool, { admission_cap }]) => {
    const cls = containerClassOf(pool);
    const c = containers.find((x) => x["class_name"] === cls);
    if (c === undefined)
      return [
        fail(
          "admission-cap",
          `${worker}.containers.${cls}`,
          `pool ${pool} has no Container class ${cls}`,
        ),
      ];
    const max = c["max_instances"];
    return typeof max === "number" && admission_cap < max
      ? []
      : [
          fail(
            "admission-cap",
            `${worker}.containers.${cls}.max_instances`,
            `pool ${pool}: admission cap ${admission_cap} is not below max_instances ${String(max)}`,
          ),
        ];
  });
};

/** A placeholder left in rendered configuration. */
export const unrenderedCheck = (worker: string, rendered: string): readonly Finding[] =>
  placeholdersOf(rendered).map((p) =>
    fail("render", `${worker}.${p}`, "placeholder left unrendered"),
  );

/**
 * The provider registry the overlay holds, against the route kinds configuration validation accepts (FD-MDL-020) and
 * each `workers-ai` entry's per-token rate against its Neurons price (FD-MDL-022): one failure per rejected entry.
 */
export const modelRegistryCheck = (entries: readonly RegistryEntry[]): readonly Finding[] =>
  checkRegistry(entries).map((r) => fail("model-registry", `models.registry.${r.entry}`, r.reason));

/** The agentic recipes of the run catalogue a deploy carries, each by run name with its declaration. */
export type AgenticRegistry = Readonly<Record<string, { readonly declaration: unknown }>>;

/**
 * The registry validator over the agentic recipes' declarations (specs/runs/agentic.md § Declaration and catalog): one
 * failure per rejection of `validateDeclaration`, among them a call site without its tier, a declaration without its
 * data classes or its intent kinds (FD-AGT-002), and one that sets `privateData`, `untrustedInput` and `outbound`
 * together (FD-AGT-004).
 */
export const agenticRegistryCheck = (registry: AgenticRegistry): readonly Finding[] =>
  Object.entries(registry).flatMap(([run, entry]) =>
    validateDeclaration(run, entry.declaration).map((r) =>
      fail("agentic-registry", `runs.${r.run}.declaration`, r.reason),
    ),
  );

/** mameko's profile validator over the document the deploy carries, every rejection listed (FD-OPS-021). */
export const profileCheck = (document: ProfileDocument, context: ValidationContext) =>
  loadProfile(profileLoader(context), document).pipe(
    Effect.as([] as readonly Finding[]),
    Effect.catchTag("ProfileRejected", (rejected) =>
      Effect.succeed(
        rejected.rejections.map((r) => fail("profile", r.path === "" ? r.item : r.path, r.reason)),
      ),
    ),
  );

/**
 * The drift check's composition: the configuration checks' findings, then the profile step's (FD-OPS-021,
 * `FdFormal.Drift.driftFindings`). The pull-request drift check, `fd deploy` and `fd doctor` all compose through it.
 */
export const withProfileStep = <E, R>(
  configFindings: readonly Finding[],
  profile: Effect.Effect<readonly Finding[], E, R>,
) => profile.pipe(Effect.map((p): readonly Finding[] => [...configFindings, ...p]));

/** The drift check's findings over one deploy, the profile step over the document the deploy carries (FD-OPS-021). */
export const driftCheckFindings = (
  configFindings: readonly Finding[],
  document: ProfileDocument,
  context: ValidationContext,
) => withProfileStep(configFindings, profileCheck(document, context));

/** The deployed settings of one Worker the drift check compares; secrets by name only. */
export const DeployedSettings = Schema.Struct({
  bindings: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      target: Schema.optional(Schema.String),
    }),
  ),
  vars: Schema.Record(Schema.String, Schema.String),
  secrets: Schema.Array(Schema.String),
  crons: Schema.Array(Schema.String),
  routes: Schema.Array(Schema.String),
  compatibility_date: Schema.String,
  compatibility_flags: Schema.Array(Schema.String),
  containers: Schema.Array(
    Schema.Struct({
      class_name: Schema.String,
      max_instances: Schema.Number,
      image: Schema.String,
    }),
  ),
});
export type DeployedSettings = typeof DeployedSettings.Type;

const keyed = <T>(xs: readonly T[], key: (x: T) => string): Map<string, T> =>
  new Map(xs.map((x) => [key(x), x]));

const show = (v: unknown): string => (v === undefined ? "absent" : JSON.stringify(v));

/**
 * Each deployed setting that differs from the record of the last deploy, with both values; a secret shows by name
 * only (FD-OPS-016, FD-OPS-017).
 */
export const settingsDrift = (
  worker: string,
  recorded: DeployedSettings,
  deployed: DeployedSettings,
): readonly Finding[] => {
  const out: Finding[] = [];
  const diff = (path: string, rec: unknown, dep: unknown) => {
    if (show(rec) !== show(dep))
      out.push(
        fail("settings", `${worker}.${path}`, `deployed ${show(dep)}, recorded ${show(rec)}`),
      );
  };
  const rb = keyed(recorded.bindings, (b) => b.name);
  const db = keyed(deployed.bindings, (b) => b.name);
  for (const name of new Set([...rb.keys(), ...db.keys()]))
    diff(`bindings.${name}`, rb.get(name), db.get(name));
  for (const name of new Set([...Object.keys(recorded.vars), ...Object.keys(deployed.vars)]))
    diff(`vars.${name}`, recorded.vars[name], deployed.vars[name]);
  const rs = new Set(recorded.secrets);
  const ds = new Set(deployed.secrets);
  for (const name of new Set([...rs, ...ds]))
    if (rs.has(name) !== ds.has(name))
      out.push(
        fail(
          "settings",
          `${worker}.secrets.${name}`,
          `secret ${name} ${ds.has(name) ? "present" : "absent"} on the deployed Worker, ${rs.has(name) ? "present" : "absent"} in the record`,
        ),
      );
  diff("crons", [...recorded.crons].sort(), [...deployed.crons].sort());
  diff("routes", [...recorded.routes].sort(), [...deployed.routes].sort());
  diff("compatibility_date", recorded.compatibility_date, deployed.compatibility_date);
  diff(
    "compatibility_flags",
    [...recorded.compatibility_flags].sort(),
    [...deployed.compatibility_flags].sort(),
  );
  const rc = keyed(recorded.containers, (c) => c.class_name);
  const dc = keyed(deployed.containers, (c) => c.class_name);
  for (const name of new Set([...rc.keys(), ...dc.keys()]))
    diff(`containers.${name}`, rc.get(name), dc.get(name));
  return out;
};

/** A GitHub App's permissions and events, as the App manifest and the registration both state them. */
export const AppPermissions = Schema.Struct({
  default_permissions: Schema.Record(Schema.String, Schema.Literals(["read", "write", "admin"])),
  default_events: Schema.Array(Schema.String),
});
export type AppPermissions = typeof AppPermissions.Type;

const LEVEL = { read: 1, write: 2, admin: 3 } as const;

/**
 * The registration fails where it lacks a manifest permission, grants it at a lower level or lacks a manifest event
 * (FD-OPS-022), and warns where it subscribes to an event the manifest does not list (FD-OPS-023).
 */
export const appRegistrationCheck = (
  manifest: AppPermissions,
  registered: AppPermissions,
): readonly Finding[] => [
  ...Object.entries(manifest.default_permissions).flatMap(([perm, level]) => {
    const got = registered.default_permissions[perm];
    return got !== undefined && LEVEL[got] >= LEVEL[level]
      ? []
      : [
          fail(
            "github-app",
            `permissions.${perm}`,
            `manifest ${level}, registered ${got ?? "absent"}`,
          ),
        ];
  }),
  ...manifest.default_events
    .filter((e) => !registered.default_events.includes(e))
    .map((e) =>
      fail("github-app", `events.${e}`, "a manifest event the registration does not subscribe to"),
    ),
  ...registered.default_events
    .filter((e) => !manifest.default_events.includes(e))
    .map((e): Finding => ({
      check: "github-app",
      path: `events.${e}`,
      detail: "the registration subscribes to an event the manifest does not list",
      severity: "warning",
    })),
];

/** The merge gate's checks, which the default branch's ruleset requires (FD-VER-023). */
export const MERGE_GATE_CHECKS = [
  "lint",
  "typecheck",
  "spec-tags",
  "unit",
  "conf",
  "sim",
  "replay",
  "e2e-local",
  "deploy-dry-run",
  "profile-reference",
  "formal",
  "diff",
] as const;

/** A merge-gate check the ruleset does not require, and `flare-dispatch/check:ci` (FD-VER-023, FD-OPS-028). */
export const rulesetCheck = (required: readonly string[]): readonly Finding[] =>
  [...MERGE_GATE_CHECKS, "flare-dispatch/check:ci"]
    .filter((c) => !required.includes(c))
    .map((c) =>
      fail("ruleset", `required_status_checks.${c}`, `the ruleset does not require ${c}`),
    );

/**
 * The hostname application's AUD tag against the overlay's `access.aud` (FD-OPS-064, FD-OPS-088). The dispatcher checks
 * every Access JWT against `access.aud`, so on a mismatch it rejects each request Access lets through. No finding when
 * the account holds no application on the hostname.
 */
export const accessAudCheck = (
  committed: CommittedAccess,
  deployed: readonly DeployedAccessApplication[],
): readonly Finding[] => {
  const app = deployed.find((d) => d.domain === committed.hostname);
  if (app === undefined || app.aud === committed.aud) return [];
  return [
    fail(
      "access",
      `access.${committed.hostname}.aud`,
      `the hostname's Access application has AUD ${show(app.aud)}, the overlay's access.aud is ${JSON.stringify(committed.aud)}: set access.aud to the application's AUD and deploy again`,
    ),
  ];
};

/**
 * Each difference between the Access applications on the dispatcher's hostname and the committed ones (FD-OPS-088): a
 * committed application absent, one whose name, domain, session or policies differ, one the commit does not hold, and
 * a hostname application whose AUD tag is not the overlay's `access.aud`.
 */
export const accessDrift = (
  committed: CommittedAccess,
  deployed: readonly DeployedAccessApplication[],
): readonly Finding[] => {
  const changes = accessChanges(committed, deployed);
  const live = new Map(deployed.map((d) => [d.id, d]));
  return [
    ...changes.create.map((a) =>
      fail("access", `access.${a.domain}`, "a committed Access application is absent"),
    ),
    ...changes.update.map((u) =>
      fail(
        "access",
        `access.${u.application.domain}`,
        `deployed ${JSON.stringify(accessShape(live.get(u.id)!))}, committed ${JSON.stringify(accessShape(u.application))}`,
      ),
    ),
    ...changes.remove.map((r) =>
      fail(
        "access",
        `access.${r.domain}`,
        "an Access application on the dispatcher's hostname the committed configuration does not hold",
      ),
    ),
    ...accessAudCheck(committed, deployed),
  ];
};

/** Whether any finding fails the check; warnings alone pass. */
export const failed = (findings: readonly Finding[]): boolean =>
  findings.some((f) => f.severity === "failure");
