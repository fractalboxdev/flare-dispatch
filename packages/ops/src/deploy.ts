// `fd deploy` and `fd doctor`: overlay decode, render, drift check, D1 migrations, Worker deploys in service-binding
// order and the committed Access applications, post-deploy probes and the floor canary, then the record of the deploy
// (specs/operability.md § Deploy pipeline). The stages run in that order and stop at the first that fails
// (FD-OPS-009); the Cloudflare and GitHub reads and writes go through the `DeployTarget` port, so `fd doctor` runs the
// same checks with no write (FD-OPS-024).
import { Context, Effect, Schema } from "effect";
import {
  accessChanges,
  type AccessApplication,
  type AccessChanges,
  type CommittedAccess,
  type DeployedAccessApplication,
} from "./access-application.ts";
import {
  accessAudCheck,
  accessDrift,
  appRegistrationCheck,
  awsBudgetCheck,
  awsBudgetUnset,
  failed,
  modelRegistryCheck,
  policyRulesCheck,
  rulesetCheck,
  settingsDrift,
  templateInvariants,
  unrenderedCheck,
  withProfileStep,
  type AppPermissions,
  type AwsBudgets,
  type DeployedSettings,
  type Finding,
} from "./drift.ts";
import {
  decodeOverlay,
  modelRegistryOf,
  policyRulesOf,
  type OverlayRejected,
  type OverlayValues,
} from "./overlay.ts";
import { parseJsonc, renderTemplate, type RenderFailed, type WorkerConfig } from "./render.ts";

/** One Worker the deploy carries: its name, committed template and the overlay hostname key it serves on. */
export interface WorkerTemplate {
  readonly worker: string;
  readonly template: string;
  /** The `hostnames.<key>` of the overlay the post-deploy probe reads; none for a Worker with no hostname. */
  readonly hostKey?: string;
  /** The template's path relative to the repository root, beside which wrangler resolves the Worker's files. */
  readonly templatePath?: string;
  /** The path the post-deploy probe requests; `/health` by default. */
  readonly probePath?: string;
}

/** One rendered Worker configuration. */
export interface RenderedWorker {
  readonly worker: string;
  readonly text: string;
  readonly config: WorkerConfig;
  readonly hostKey?: string;
  readonly templatePath?: string;
  readonly probePath?: string;
}

/** The stages of FD-OPS-009, in order. */
export const STAGES = [
  "decode",
  "render",
  "drift",
  "migrations",
  "deploy",
  "probes",
  "record",
] as const;
export type Stage = (typeof STAGES)[number];

/** What a Worker deploy reports: the new version, the previous one and the migrations it carried. */
export interface Deployed {
  readonly worker: string;
  readonly version: string;
  readonly previousVersion: string | null;
  /** Durable Object migration tags this deploy applied. */
  readonly durableObjectMigrations: readonly string[];
}

/** A Cloudflare or GitHub call the pipeline made failed; the stage that made it stops the pipeline. */
export class TargetFailed extends Schema.TaggedError<TargetFailed>()("TargetFailed", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** The result of the floor canary: passed, failed with the stage it reached, or not applicable to this deploy. */
export type CanaryResult =
  | { readonly status: "passed"; readonly digest: string }
  | { readonly status: "failed"; readonly detail: string }
  | { readonly status: "not-applicable"; readonly detail: string };

/** The Cloudflare and GitHub operations the pipeline uses; `fd doctor` calls only the reads. */
export class DeployTarget extends Context.Service<
  DeployTarget,
  {
    readonly deployedSettings: (
      worker: RenderedWorker,
    ) => Effect.Effect<DeployedSettings | null, TargetFailed>;
    /** The record of the last deploy, from the artifacts bucket (FD-OPS-015). */
    readonly lastRecord: (
      worker: RenderedWorker,
    ) => Effect.Effect<DeployedSettings | null, TargetFailed>;
    readonly appRegistration: Effect.Effect<AppPermissions, TargetFailed>;
    /** The status checks the default branch's ruleset requires (FD-VER-023, FD-OPS-028). */
    readonly requiredChecks: Effect.Effect<readonly string[], TargetFailed>;
    /** The deploying organization's AWS account's budgets and Budgets actions (FD-EXEC-083). */
    readonly awsBudgets: Effect.Effect<AwsBudgets, TargetFailed>;
    /** Applies each Worker's pending D1 migrations, in order; answers the migrations applied. */
    readonly applyD1Migrations: (
      rendered: readonly RenderedWorker[],
    ) => Effect.Effect<readonly string[], TargetFailed>;
    readonly deployWorker: (worker: RenderedWorker) => Effect.Effect<Deployed, TargetFailed>;
    /** `GET /health` on the deployed Worker. */
    readonly probe: (worker: RenderedWorker) => Effect.Effect<boolean, TargetFailed>;
    /** The container floor canary, once, on the deployed image digest (FD-OPS-050). */
    readonly floorCanary: (
      rendered: readonly RenderedWorker[],
    ) => Effect.Effect<CanaryResult, TargetFailed>;
    readonly writeRecord: (worker: RenderedWorker) => Effect.Effect<void, TargetFailed>;
    /** Sends one alarm of specs/operability.md § Liveness and alerts to the overlay's alert sink. */
    readonly raiseAlarm: (
      name: string,
      detail: string,
      severity: "page" | "notify",
    ) => Effect.Effect<void>;
    /** Every Access application of the account (FD-OPS-088). */
    readonly accessApplications: Effect.Effect<readonly DeployedAccessApplication[], TargetFailed>;
    /** Creates an Access application, or replaces the one `id` names. */
    readonly putAccessApplication: (
      application: AccessApplication,
      id: string | null,
    ) => Effect.Effect<void, TargetFailed>;
    readonly deleteAccessApplication: (id: string) => Effect.Effect<void, TargetFailed>;
  }
>()("@fractalboxdev/flare-dispatch-ops/DeployTarget") {}

/** The pipeline stopped at a stage; `findings` and `rollback` say why and what the operator runs next. */
export class DeployFailed extends Schema.TaggedError<DeployFailed>()("DeployFailed", {
  stage: Schema.Literals(STAGES),
  findings: Schema.Array(Schema.Struct({ path: Schema.String, detail: Schema.String })),
  /** One line per Worker: its `wrangler rollback` command, or why none applies (FD-OPS-013). */
  rollback: Schema.Array(Schema.String),
}) {}

const serviceTargets = (c: WorkerConfig): readonly string[] =>
  (Array.isArray(c["services"]) ? (c["services"] as { service?: unknown }[]) : [])
    .map((s) => s.service)
    .filter((s): s is string => typeof s === "string");

/** The script name a rendered configuration deploys as: its `name`, else the Worker's own name. */
export const scriptName = (r: {
  readonly worker: string;
  readonly config: WorkerConfig;
}): string => (typeof r.config["name"] === "string" ? r.config["name"] : r.worker);

/**
 * The Workers in deploy order: each after every Worker it binds as a service (FD-OPS-010). A service binding names the
 * bound Worker's script, so it matches a Worker of the set by script name. A service outside the set is already
 * deployed; a cycle keeps the remaining Workers in their given order.
 */
export const deployOrder = (
  configs: readonly { worker: string; config: WorkerConfig }[],
): readonly string[] => {
  const byScript = new Map(configs.map((c) => [scriptName(c), c.worker]));
  const order: string[] = [];
  const visiting = new Set<string>();
  const visit = (w: string) => {
    if (order.includes(w) || visiting.has(w)) return;
    visiting.add(w);
    const c = configs.find((x) => x.worker === w);
    for (const service of c === undefined ? [] : serviceTargets(c.config)) {
      const dep = byScript.get(service);
      if (dep !== undefined) visit(dep);
    }
    visiting.delete(w);
    order.push(w);
  };
  for (const c of configs) visit(c.worker);
  return order;
};

/**
 * The line `fd deploy` prints per Worker after a failed probe (FD-OPS-013); it never runs the rollback (FD-OPS-014).
 * `script` is the script name `wrangler rollback --name` takes, which a rendered configuration's `name` sets.
 */
export const rollbackLine = (
  d: Deployed,
  d1Migrations: readonly string[],
  script: string = d.worker,
): string => {
  const blocking = [...d.durableObjectMigrations, ...d1Migrations];
  if (blocking.length > 0)
    return `${d.worker}: fix forward: rollback blocked by migration ${blocking[0]}`;
  return d.previousVersion === null
    ? `${d.worker}: fix forward: no previous version`
    : `wrangler rollback ${d.previousVersion} --name ${script}`;
};

const findingsOf = (fs: readonly Finding[]) =>
  fs.filter((f) => f.severity === "failure").map((f) => ({ path: f.path, detail: f.detail }));

const stageFailed = (stage: Stage) => (e: TargetFailed) =>
  new DeployFailed({ stage, findings: [{ path: e.operation, detail: e.message }], rollback: [] });

/** Render and the static checks over the rendered configuration; shared by `fd deploy`, `fd doctor` and CI. */
export const renderAll = (overlayText: string, workers: readonly WorkerTemplate[]) =>
  Effect.gen(function* () {
    const overlay: OverlayValues = yield* decodeOverlay(overlayText).pipe(
      Effect.mapError(
        (e: OverlayRejected) =>
          new DeployFailed({
            stage: "decode",
            findings: e.issues.map((i) => ({ path: i.path, detail: i.message })),
            rollback: [],
          }),
      ),
    );
    const rendered: RenderedWorker[] = [];
    for (const w of workers) {
      const text = yield* renderTemplate(w.worker, w.template, overlay).pipe(
        Effect.mapError(
          (e: RenderFailed) =>
            new DeployFailed({
              stage: "render",
              findings: e.paths.map((p) => ({
                path: `${e.worker}.${p}`,
                detail: "the overlay holds no value",
              })),
              rollback: [],
            }),
        ),
      );
      rendered.push({
        worker: w.worker,
        text,
        config: parseJsonc(text),
        ...(w.hostKey === undefined ? {} : { hostKey: w.hostKey }),
        ...(w.templatePath === undefined ? {} : { templatePath: w.templatePath }),
        ...(w.probePath === undefined ? {} : { probePath: w.probePath }),
      });
    }
    return { overlay, rendered };
  });

/**
 * The profile step over a decoded overlay (FD-OPS-021): the overlay delivers the spend configuration the profile's
 * spend lines are validated against (FD-PROF-054).
 */
export type ProfileStep = (overlay: OverlayValues) => Effect.Effect<readonly Finding[]>;

/** The Access applications a deploy carries, from its decoded overlay; none for a deploy without the dispatcher. */
export type AccessFor = (overlay: OverlayValues) => CommittedAccess | null;

/**
 * Every drift finding: the overlay's provider registry (FD-MDL-020, FD-MDL-022), policy sync over the overlay's
 * policy rules (FD-PROF-025), the templates' invariants, the
 * rendered configuration, the deployed Workers against the record of the last deploy, the GitHub App's registration,
 * the default branch's ruleset, the AWS account's Budgets actions where the overlay carries the `aws` kind, and, given
 * `access`, the Access applications on the dispatcher's hostname, then the
 * profile step's findings over the decoded overlay from `more` (`withProfileStep`, the composition the pull-request
 * drift check shares). `fd deploy` passes no `access`: it checks only the hostname
 * application's AUD tag, then applies the committed applications and reports each one it changed, where `fd doctor`
 * fails on each difference.
 */
export const driftFindings = (
  overlay: OverlayValues,
  workers: readonly WorkerTemplate[],
  rendered: readonly RenderedWorker[],
  manifest: AppPermissions,
  extra: (worker: string, config: WorkerConfig) => readonly Finding[] = () => [],
  more: ProfileStep = () => Effect.succeed([]),
  access: CommittedAccess | null = null,
) =>
  Effect.gen(function* () {
    const target = yield* DeployTarget;
    const findings: Finding[] = [
      ...modelRegistryCheck(modelRegistryOf(overlay)),
      ...policyRulesCheck(policyRulesOf(overlay)),
    ];
    for (const w of workers) findings.push(...templateInvariants(w.worker, parseJsonc(w.template)));
    for (const r of rendered) {
      findings.push(...unrenderedCheck(r.worker, r.text), ...extra(r.worker, r.config));
      const deployed = yield* target.deployedSettings(r);
      const record = yield* target.lastRecord(r);
      if (deployed !== null && record !== null)
        findings.push(...settingsDrift(r.worker, record, deployed));
    }
    findings.push(...appRegistrationCheck(manifest, yield* target.appRegistration));
    findings.push(...rulesetCheck(yield* target.requiredChecks));
    if (overlay.aws !== undefined) {
      const limitUsd = overlay.aws.budgetUsd;
      if (limitUsd === undefined) findings.push(awsBudgetUnset);
      else
        findings.push(
          ...awsBudgetCheck(limitUsd, yield* target.awsBudgets, overlay.aws.launcherRoleArn),
        );
    }
    if (access !== null) findings.push(...accessDrift(access, yield* target.accessApplications));
    return yield* withProfileStep(findings, more(overlay));
  }).pipe(Effect.mapError(stageFailed("drift")));

/** `fd doctor`: every drift check, no Cloudflare or GitHub write (FD-OPS-024). */
export const fdDoctor = (
  overlayText: string,
  workers: readonly WorkerTemplate[],
  manifest: AppPermissions,
  extra?: (worker: string, config: WorkerConfig) => readonly Finding[],
  more?: ProfileStep,
  access?: AccessFor,
) =>
  Effect.gen(function* () {
    const { overlay, rendered } = yield* renderAll(overlayText, workers);
    return yield* driftFindings(
      overlay,
      workers,
      rendered,
      manifest,
      extra,
      more,
      access?.(overlay) ?? null,
    );
  });

/**
 * Makes the account's Access applications on the dispatcher's hostname the committed ones (FD-OPS-088): creates each
 * absent one, replaces each that differs and removes each the commit does not hold. It runs after the Worker deploys,
 * so a newly bypassed path is served by a Worker that runs its own identity check, and before the probes, which reach
 * `/health` through Access.
 */
export const applyAccess = (committed: CommittedAccess) =>
  Effect.gen(function* () {
    const target = yield* DeployTarget;
    const changes = accessChanges(committed, yield* target.accessApplications);
    for (const a of changes.create) yield* target.putAccessApplication(a, null);
    for (const u of changes.update) yield* target.putAccessApplication(u.application, u.id);
    for (const r of changes.remove) yield* target.deleteAccessApplication(r.id);
    return changes;
  });

/**
 * `fd deploy`: the stages of FD-OPS-009 in order, stopping at the first that fails. A failed probe or floor canary
 * exits non-zero, raises `deploy-probe-failed` and prints each Worker's rollback line; nothing rolls back by itself.
 *
 * With Access to apply, the drift stage reads the account's Access applications, so a token that cannot read them
 * stops the deploy before any write, and fails on a hostname application whose AUD tag is not the overlay's
 * `access.aud`. Cloudflare gives a created application a new AUD tag, so a deploy that creates the hostname
 * application fails the deploy stage with that tag: the dispatcher checks Access JWTs against `access.aud`, and would
 * reject every one.
 */
export const fdDeploy = (
  overlayText: string,
  workers: readonly WorkerTemplate[],
  manifest: AppPermissions,
  extra?: (worker: string, config: WorkerConfig) => readonly Finding[],
  more?: ProfileStep,
  access?: AccessFor,
) =>
  Effect.gen(function* () {
    const target = yield* DeployTarget;
    const { overlay, rendered } = yield* renderAll(overlayText, workers);
    const committed = access?.(overlay) ?? null;
    const drift = [...(yield* driftFindings(overlay, workers, rendered, manifest, extra, more))];
    if (committed !== null)
      drift.push(
        ...accessAudCheck(
          committed,
          yield* target.accessApplications.pipe(Effect.mapError(stageFailed("drift"))),
        ),
      );
    if (failed(drift))
      return yield* new DeployFailed({ stage: "drift", findings: findingsOf(drift), rollback: [] });
    const d1 = yield* target
      .applyD1Migrations(rendered)
      .pipe(Effect.mapError(stageFailed("migrations")));
    const deployed: Deployed[] = [];
    const rollbackOf = (d: Deployed) => {
      const r = rendered.find((x) => x.worker === d.worker);
      return rollbackLine(d, d1, r === undefined ? d.worker : scriptName(r));
    };
    for (const worker of deployOrder(rendered)) {
      const r = rendered.find((x) => x.worker === worker)!;
      deployed.push(
        yield* target.deployWorker(r).pipe(
          Effect.mapError(
            (e) =>
              new DeployFailed({
                stage: "deploy",
                findings: [{ path: e.operation, detail: e.message }],
                rollback: deployed.map(rollbackOf),
              }),
          ),
        ),
      );
    }
    const deployStageFailed = (e: TargetFailed) =>
      new DeployFailed({
        stage: "deploy",
        findings: [{ path: e.operation, detail: e.message }],
        rollback: deployed.map(rollbackOf),
      });
    const accessApplied: AccessChanges | null =
      committed === null
        ? null
        : yield* applyAccess(committed).pipe(Effect.mapError(deployStageFailed));
    if (committed !== null && accessApplied?.create.some((a) => a.domain === committed.hostname)) {
      const aud = accessAudCheck(
        committed,
        yield* target.accessApplications.pipe(Effect.mapError(deployStageFailed)),
      );
      if (failed(aud))
        return yield* new DeployFailed({
          stage: "deploy",
          findings: findingsOf(aud),
          rollback: deployed.map(rollbackOf),
        });
    }
    const probes: { path: string; detail: string }[] = [];
    for (const d of deployed) {
      const r = rendered.find((x) => x.worker === d.worker)!;
      const ok = yield* target.probe(r).pipe(Effect.orElseSucceed(() => false));
      if (!ok) probes.push({ path: r.worker, detail: "GET /health failed" });
    }
    let canary: CanaryResult | null = null;
    if (probes.length === 0) {
      canary = yield* target
        .floorCanary(rendered)
        .pipe(
          Effect.catchTag("TargetFailed", (e) =>
            Effect.succeed<CanaryResult>({ status: "failed", detail: e.message }),
          ),
        );
      if (canary.status === "failed") probes.push({ path: "floor-canary", detail: canary.detail });
    }
    if (probes.length > 0) {
      yield* target.raiseAlarm(
        "deploy-probe-failed",
        probes.map((p) => `${p.path}: ${p.detail}`).join("; "),
        "page",
      );
      return yield* new DeployFailed({
        stage: "probes",
        findings: probes,
        rollback: deployed.map(rollbackOf),
      });
    }
    for (const r of rendered)
      yield* target.writeRecord(r).pipe(Effect.mapError(stageFailed("record")));
    return {
      deployed,
      migrations: d1,
      access: accessApplied,
      canary,
      warnings: drift.filter((f) => f.severity === "warning"),
    };
  });

/** One stage of a deploy or a drift check, in the order it ran: the shape `fd` prints. */
export interface StageReport {
  readonly stage: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** The stages that ran, from a deploy's result or the stage it failed at. */
export const stageReport = (
  outcome:
    | { readonly ok: true; readonly last: Stage; readonly details?: Partial<Record<Stage, string>> }
    | { readonly ok: false; readonly failed: DeployFailed },
): readonly StageReport[] => {
  const last = outcome.ok ? outcome.last : outcome.failed.stage;
  const ran = STAGES.slice(0, STAGES.indexOf(last) + 1);
  return ran.map((stage) => {
    if (!outcome.ok) {
      if (stage !== last) return { stage, ok: true, detail: "" };
      const f = outcome.failed;
      return {
        stage,
        ok: false,
        detail: [...f.findings.map((x) => `${x.path}: ${x.detail}`), ...f.rollback].join("\n"),
      };
    }
    return { stage, ok: true, detail: outcome.details?.[stage] ?? "" };
  });
};
