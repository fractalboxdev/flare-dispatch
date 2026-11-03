// `fd deploy` and `fd doctor`: overlay decode, render, drift check, D1 migrations, Worker deploys in service-binding
// order, post-deploy probes and the floor canary, then the record of the deploy (specs/operability.md § Deploy
// pipeline). The stages run in that order and stop at the first that fails (FD-OPS-009); the Cloudflare and GitHub
// reads and writes go through the `DeployTarget` port, so `fd doctor` runs the same checks with no write (FD-OPS-024).
import { Context, Effect, Schema } from "effect";
import {
  appRegistrationCheck,
  failed,
  settingsDrift,
  templateInvariants,
  unrenderedCheck,
  type AppPermissions,
  type DeployedSettings,
  type Finding,
} from "./drift.ts";
import { decodeOverlay, type OverlayRejected } from "./overlay.ts";
import { parseJsonc, renderTemplate, type RenderFailed, type WorkerConfig } from "./render.ts";

/** One Worker the deploy carries: its name, committed template and the Workers it binds as services. */
export interface WorkerTemplate {
  readonly worker: string;
  readonly template: string;
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

/** The Cloudflare and GitHub operations the pipeline uses; `fd doctor` calls only the reads. */
export class DeployTarget extends Context.Service<
  DeployTarget,
  {
    readonly deployedSettings: (worker: string) => Effect.Effect<DeployedSettings | null>;
    /** The record of the last deploy, from the artifacts bucket (FD-OPS-015). */
    readonly lastRecord: (worker: string) => Effect.Effect<DeployedSettings | null>;
    readonly appRegistration: Effect.Effect<AppPermissions>;
    /** Pending D1 migration tags, applied in order; answers the tags applied. */
    readonly applyD1Migrations: Effect.Effect<readonly string[]>;
    readonly deployWorker: (worker: string, rendered: string) => Effect.Effect<Deployed>;
    /** `GET /health` on the deployed Worker. */
    readonly probe: (worker: string) => Effect.Effect<boolean>;
    /** The container floor canary on the deployed image digest (FD-OPS-050). */
    readonly floorCanary: Effect.Effect<boolean>;
    readonly writeRecord: (worker: string, rendered: string) => Effect.Effect<void>;
    readonly raiseAlarm: (name: string, detail: string) => Effect.Effect<void>;
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

/**
 * The Workers in deploy order: each after every Worker it binds as a service (FD-OPS-010). A service outside the set
 * is already deployed; a cycle keeps the remaining Workers in their given order.
 */
export const deployOrder = (
  configs: readonly { worker: string; config: WorkerConfig }[],
): readonly string[] => {
  const names = new Set(configs.map((c) => c.worker));
  const order: string[] = [];
  const visiting = new Set<string>();
  const visit = (w: string) => {
    if (order.includes(w) || visiting.has(w)) return;
    visiting.add(w);
    const c = configs.find((x) => x.worker === w);
    for (const dep of c === undefined ? [] : serviceTargets(c.config))
      if (names.has(dep)) visit(dep);
    visiting.delete(w);
    order.push(w);
  };
  for (const c of configs) visit(c.worker);
  return order;
};

/** The line `fd deploy` prints per Worker after a failed probe (FD-OPS-013); it never runs the rollback (FD-OPS-014). */
export const rollbackLine = (d: Deployed, d1Migrations: readonly string[]): string => {
  const blocking = [...d.durableObjectMigrations, ...d1Migrations];
  if (blocking.length > 0)
    return `${d.worker}: fix forward: rollback blocked by migration ${blocking[0]}`;
  return d.previousVersion === null
    ? `${d.worker}: fix forward: no previous version`
    : `wrangler rollback ${d.previousVersion} --name ${d.worker}`;
};

const findingsOf = (fs: readonly Finding[]) =>
  fs.filter((f) => f.severity === "failure").map((f) => ({ path: f.path, detail: f.detail }));

/** Render and the static checks over the rendered configuration; shared by `fd deploy`, `fd doctor` and CI. */
export const renderAll = (overlayText: string, workers: readonly WorkerTemplate[]) =>
  Effect.gen(function* () {
    const overlay = yield* decodeOverlay(overlayText).pipe(
      Effect.mapError(
        (e: OverlayRejected) =>
          new DeployFailed({
            stage: "decode",
            findings: e.issues.map((i) => ({ path: i.path, detail: i.message })),
            rollback: [],
          }),
      ),
    );
    const rendered: { worker: string; text: string; config: WorkerConfig }[] = [];
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
      rendered.push({ worker: w.worker, text, config: parseJsonc(text) });
    }
    return { overlay, rendered };
  });

/** Every drift finding for the rendered Workers against the deployed ones, the record and the App registration. */
export const driftFindings = (
  workers: readonly WorkerTemplate[],
  rendered: readonly { worker: string; text: string }[],
  manifest: AppPermissions,
  extra: (worker: string, config: WorkerConfig) => readonly Finding[] = () => [],
) =>
  Effect.gen(function* () {
    const target = yield* DeployTarget;
    const findings: Finding[] = [];
    for (const w of workers) findings.push(...templateInvariants(w.worker, parseJsonc(w.template)));
    for (const r of rendered) {
      findings.push(...unrenderedCheck(r.worker, r.text), ...extra(r.worker, parseJsonc(r.text)));
      const deployed = yield* target.deployedSettings(r.worker);
      const record = yield* target.lastRecord(r.worker);
      if (deployed !== null && record !== null)
        findings.push(...settingsDrift(r.worker, record, deployed));
    }
    findings.push(...appRegistrationCheck(manifest, yield* target.appRegistration));
    return findings;
  });

/** `fd doctor`: every drift check, no Cloudflare or GitHub write (FD-OPS-024). */
export const fdDoctor = (
  overlayText: string,
  workers: readonly WorkerTemplate[],
  manifest: AppPermissions,
  extra?: (worker: string, config: WorkerConfig) => readonly Finding[],
) =>
  Effect.gen(function* () {
    const { rendered } = yield* renderAll(overlayText, workers);
    return yield* driftFindings(workers, rendered, manifest, extra);
  });

/**
 * `fd deploy`: the stages of FD-OPS-009 in order, stopping at the first that fails. A failed probe or floor canary
 * exits non-zero, raises `deploy-probe-failed` and prints each Worker's rollback line; nothing rolls back by itself.
 */
export const fdDeploy = (
  overlayText: string,
  workers: readonly WorkerTemplate[],
  manifest: AppPermissions,
  extra?: (worker: string, config: WorkerConfig) => readonly Finding[],
) =>
  Effect.gen(function* () {
    const target = yield* DeployTarget;
    const { rendered } = yield* renderAll(overlayText, workers);
    const drift = yield* driftFindings(workers, rendered, manifest, extra);
    if (failed(drift))
      return yield* new DeployFailed({ stage: "drift", findings: findingsOf(drift), rollback: [] });
    const d1 = yield* target.applyD1Migrations;
    const deployed: Deployed[] = [];
    for (const worker of deployOrder(rendered)) {
      const r = rendered.find((x) => x.worker === worker)!;
      deployed.push(yield* target.deployWorker(worker, r.text));
    }
    const probes: { path: string; detail: string }[] = [];
    for (const d of deployed)
      if (!(yield* target.probe(d.worker)))
        probes.push({ path: d.worker, detail: "GET /health failed" });
    if (probes.length === 0 && !(yield* target.floorCanary))
      probes.push({
        path: "floor-canary",
        detail: "the container floor canary failed on the deployed digest",
      });
    if (probes.length > 0) {
      yield* target.raiseAlarm(
        "deploy-probe-failed",
        probes.map((p) => `${p.path}: ${p.detail}`).join("; "),
      );
      return yield* new DeployFailed({
        stage: "probes",
        findings: probes,
        rollback: deployed.map((d) => rollbackLine(d, d1)),
      });
    }
    for (const r of rendered) yield* target.writeRecord(r.worker, r.text);
    return { deployed, migrations: d1, warnings: drift.filter((f) => f.severity === "warning") };
  });
