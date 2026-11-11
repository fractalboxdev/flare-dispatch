// The `Operability` service `fd deploy` and `fd doctor` run (specs/interfaces.md FD-IFC-070, specs/operability.md
// FD-OPS-003 to FD-OPS-025): the deploy pipeline and the drift check over the live Cloudflare and GitHub target, as
// the stage report `fd` prints. A stage that fails is a report with `ok: false`; only a defect is the caller's error.
import { AGENTIC_CATALOG } from "@fractalboxdev/flare-dispatch-agentic";
import {
  CURRENT_PHASE,
  profileDocumentFor,
  validationContext,
  type SpendConfig,
} from "@fractalboxdev/flare-dispatch-profile";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProfileDocument } from "@fractalboxdev/mameko-ports";
import { Cause, Effect, Layer } from "effect";
import { committedAccess, type AccessChanges } from "../access-application.ts";
import { APP_PERMISSIONS } from "../app-manifest.ts";
import { architectureFindings } from "../architecture.ts";
import {
  DeployFailed,
  DeployTarget,
  fdDeploy,
  fdDoctor,
  stageReport,
  type StageReport,
  type WorkerTemplate,
} from "../deploy.ts";
import {
  admissionCapCheck,
  agenticRegistryCheck,
  bindingCheck,
  failed,
  profileCheck,
  templateInvariants,
  unrenderedCheck,
  type AgenticRegistry,
  type Finding,
} from "../drift.ts";
import { decodeOverlay, spendConfigOf, type OverlayValues } from "../overlay.ts";
import { parseJsonc, renderTemplate, type WorkerConfig } from "../render.ts";
import { cloudflareClient, githubClient, nodeRunner, type CommandRunner } from "./clients.ts";
import { liveDeployTarget } from "./live-target.ts";

/** The report `fd` prints and turns into an exit code. */
export interface OperabilityReport {
  readonly ok: boolean;
  readonly stages: readonly StageReport[];
}

/** One v2 Worker the deploy carries: its template, hostname key, probe path and the bindings its env declares. */
export interface WorkerSpec {
  readonly worker: string;
  readonly templatePath: string;
  readonly hostKey?: string;
  readonly probePath?: string;
  readonly bindings?: readonly string[];
  /** The dispatcher Worker carries the components of specs/architecture.md § Components. */
  readonly dispatcher?: boolean;
}

/**
 * The Workers of specs/architecture.md: the dispatcher (the v2 control plane) and the documentation Worker. The
 * dispatcher declares `ALERT_SINK`, the sink its alarm port sends to, so no deploy goes out without one (FD-OPS-053),
 * and `SPEND`, the spend configuration the coordinator reads (FD-PROF-054).
 */
export const V2_WORKERS: readonly WorkerSpec[] = [
  {
    worker: "control-plane",
    templatePath: "apps/control-plane/wrangler.jsonc",
    hostKey: "dispatcher",
    bindings: [
      "DB",
      "CHANNEL",
      "EXECUTION",
      "EPOCH_ANCHOR",
      "MONITOR",
      "PLANE_ID",
      "DEPLOYMENT",
      "ALERT_SINK",
      "SPEND",
    ],
    dispatcher: true,
  },
  { worker: "docs", templatePath: "apps/docs/wrangler.jsonc", hostKey: "docs", probePath: "/" },
];

/** One line per Access application a deploy created, replaced or removed. */
const accessLines = (changes: AccessChanges | null): readonly string[] =>
  changes === null
    ? []
    : [
        ...changes.create.map((a) => `access created ${a.domain}`),
        ...changes.update.map((u) => `access replaced ${u.application.domain}`),
        ...changes.remove.map((r) => `access removed ${r.domain}`),
      ];

/** What the service runs with; every field has the live default. */
export interface OperabilityOptions<E> {
  /** Builds the caller's error from a defect's message. */
  readonly fail: (message: string) => E;
  readonly root?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly workers?: readonly WorkerSpec[];
  readonly fetch?: typeof fetch;
  readonly runner?: CommandRunner;
  /** Replaces the live target, for tests. */
  readonly target?: (overlay: OverlayValues) => Layer.Layer<DeployTarget>;
  /** The profile document the deploy carries; the production document at the current phase by default (FD-OPS-021). */
  readonly profile?: ProfileDocument;
  /** The agentic recipes the run catalogue carries; `AGENTIC_CATALOG` by default (FD-AGT-002, FD-AGT-004). */
  readonly agenticRegistry?: AgenticRegistry;
}

/** What `fd doctor` does beyond the drift check. */
export interface DoctorOptions {
  /** Raise the notify alarm `drift` when a check fails (FD-OPS-025). */
  readonly alarmOnDrift?: boolean;
}

/** The repository root: the nearest directory above `from` that holds `pnpm-workspace.yaml`. */
export const repositoryRoot = (from: string = process.cwd()): string => {
  let dir = from;
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const up = dirname(dir);
    if (up === dir) return from;
    dir = up;
  }
  return dir;
};

/**
 * The checks over one rendered configuration: the bindings its env declares (FD-OPS-019) and, on the dispatcher, the
 * pool caps (FD-OPS-020, FD-PROF-033), the components (FD-ARCH-001) and the registry validator over the agentic
 * recipes of the run catalogue it serves (FD-AGT-002, FD-AGT-004).
 */
export const renderedChecks =
  (specs: readonly WorkerSpec[], registry: AgenticRegistry = AGENTIC_CATALOG) =>
  (worker: string, config: WorkerConfig): readonly Finding[] => {
    const spec = specs.find((s) => s.worker === worker);
    if (spec === undefined) return [];
    return [
      ...(spec.bindings === undefined ? [] : bindingCheck(worker, config, spec.bindings)),
      ...(spec.dispatcher === true
        ? [
            ...admissionCapCheck(worker, config),
            ...architectureFindings(worker, config, CURRENT_PHASE),
            ...agenticRegistryCheck(registry),
          ]
        : []),
    ];
  };

/**
 * The check `fd deploy` adds to its drift stage: a Worker's `assets.directory`, resolved beside its template, exists.
 * The directory is a build output (the documentation site's is `pnpm --filter @fractalboxdev/flare-dispatch-docs run
 * build`), so a deploy without it stops before its first write, where wrangler would fail on it after the migrations
 * and the deploys ahead of it in service-binding order. `fd doctor` and the pull-request drift check build nothing and
 * leave it out.
 */
export const assetsDirectoryCheck =
  (root: string, specs: readonly WorkerSpec[]) =>
  (worker: string, config: WorkerConfig): readonly Finding[] => {
    const spec = specs.find((s) => s.worker === worker);
    const assets = config["assets"];
    const directory =
      typeof assets === "object" && assets !== null
        ? (assets as { directory?: unknown }).directory
        : undefined;
    if (spec === undefined || typeof directory !== "string") return [];
    return existsSync(join(root, dirname(spec.templatePath), directory))
      ? []
      : [
          {
            check: "assets",
            path: `${worker}.assets.directory`,
            detail: `${join(dirname(spec.templatePath), directory)} does not exist; build the Worker's assets before fd deploy`,
            severity: "failure",
          },
        ];
  };

/**
 * mameko's profile validator over a profile document at the current phase, with its spend lines at the spend
 * configuration the overlay delivers; the deploy carries the production document (FD-OPS-021, FD-PROF-054,
 * FD-PROF-064).
 */
export const profileDriftFindings = (document: ProfileDocument, spend: SpendConfig) =>
  profileCheck(document, { ...validationContext, spend });

/**
 * The pull-request part of the drift check (FD-OPS-019 to FD-OPS-021, FD-OPS-026): one Worker's template rendered
 * from `overlay`, against the template's invariants and `renderedChecks`. Answers the rendered text with the findings.
 */
export const staticDrift = (
  spec: WorkerSpec,
  template: string,
  overlay: OverlayValues,
  registry: AgenticRegistry = AGENTIC_CATALOG,
) =>
  renderTemplate(spec.worker, template, overlay).pipe(
    Effect.map((rendered) => ({
      rendered,
      findings: [
        ...templateInvariants(spec.worker, parseJsonc(template)),
        ...unrenderedCheck(spec.worker, rendered),
        ...renderedChecks([spec], registry)(spec.worker, parseJsonc(rendered)),
      ],
    })),
  );

/**
 * The `Operability` service's two operations. `fd`'s Layer is
 * `Layer.succeed(Operability)(makeOperability({ fail: (message) => new OperabilityFailed({ message }) }))`.
 */
export const makeOperability = <E>(options: OperabilityOptions<E>) => {
  const root = options.root ?? repositoryRoot();
  const env = options.env ?? process.env;
  const specs = options.workers ?? V2_WORKERS;
  const checks = renderedChecks(specs, options.agenticRegistry ?? AGENTIC_CATALOG);
  const assetsBuilt = assetsDirectoryCheck(root, specs);
  const profileDocument = options.profile ?? profileDocumentFor("production");
  const profileFindings = (overlay: OverlayValues) =>
    profileDriftFindings(profileDocument, spendConfigOf(overlay));
  const workers = (): WorkerTemplate[] =>
    specs.map((s) => ({
      worker: s.worker,
      template: readFileSync(join(root, s.templatePath), "utf8"),
      templatePath: s.templatePath,
      ...(s.hostKey === undefined ? {} : { hostKey: s.hostKey }),
      ...(s.probePath === undefined ? {} : { probePath: s.probePath }),
    }));
  const targetFor = (overlayText: string) =>
    decodeOverlay(overlayText).pipe(
      Effect.map((overlay) =>
        options.target !== undefined
          ? options.target(overlay)
          : liveDeployTarget({
              overlay,
              cloudflare: cloudflareClient(env["CLOUDFLARE_API_TOKEN"] ?? "", options.fetch),
              github: githubClient(options.fetch),
              runner: options.runner ?? nodeRunner,
              root,
              apiToken: env["CLOUDFLARE_API_TOKEN"] ?? "",
              ...(env["GITHUB_APP_PRIVATE_KEY"] === undefined
                ? {}
                : { appPrivateKey: env["GITHUB_APP_PRIVATE_KEY"] }),
              ...(env["GITHUB_REPOSITORY"] === undefined
                ? {}
                : { repository: env["GITHUB_REPOSITORY"] }),
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            }),
      ),
      // An overlay that does not decode reaches the pipeline's own decode stage, which reports it.
      Effect.orElseSucceed(() => Layer.succeed(DeployTarget, {} as never)),
    );
  // The Access applications sit on the dispatcher's hostname: only a deploy that carries the dispatcher applies them.
  const access = specs.some((s) => s.dispatcher === true) ? committedAccess : undefined;
  const report =
    <A>(run: Effect.Effect<A, DeployFailed, DeployTarget>, done: (a: A) => OperabilityReport) =>
    (overlayText: string) =>
      Effect.gen(function* () {
        const layer = yield* targetFor(overlayText);
        return yield* run.pipe(
          Effect.map(done),
          Effect.catchTag("DeployFailed", (f) =>
            Effect.succeed<OperabilityReport>({
              ok: false,
              stages: stageReport({ ok: false, failed: f }),
            }),
          ),
          Effect.provide(layer),
        );
      }).pipe(Effect.catchCause((cause) => Effect.fail(options.fail(Cause.pretty(cause)))));

  const problemsOf = (findings: readonly Finding[]) =>
    findings.map((f) => `${f.severity} ${f.path}: ${f.detail}`).join("\n");

  /**
   * `fd doctor`. With `alarmOnDrift`, a check that fails raises the notify alarm `drift` at the overlay's alert sink
   * (FD-OPS-025); an overlay that does not decode names no sink to raise it at.
   */
  const doctor = (overlay: string, opts: DoctorOptions = {}) => {
    const drift = (detail: string) =>
      opts.alarmOnDrift === true
        ? Effect.flatMap(DeployTarget, (t) => t.raiseAlarm("drift", detail, "notify"))
        : Effect.void;
    return report(
      fdDoctor(overlay, workers(), APP_PERMISSIONS, checks, profileFindings, access).pipe(
        Effect.tap((findings) => (failed(findings) ? drift(problemsOf(findings)) : Effect.void)),
        Effect.tapError((f) =>
          f.stage === "decode"
            ? Effect.void
            : drift(f.findings.map((x) => `failure ${x.path}: ${x.detail}`).join("\n")),
        ),
      ),
      (findings) => {
        const problems = problemsOf(findings);
        const ok = !failed(findings);
        return {
          ok,
          stages: [
            { stage: "decode", ok: true, detail: "" },
            { stage: "render", ok: true, detail: "" },
            { stage: "drift", ok, detail: problems },
          ],
        };
      },
    )(overlay);
  };

  return {
    deploy: (request: { readonly overlay: string; readonly dryRun: boolean }) =>
      request.dryRun
        ? doctor(request.overlay)
        : report(
            fdDeploy(
              request.overlay,
              workers(),
              APP_PERMISSIONS,
              (worker, config) => [...checks(worker, config), ...assetsBuilt(worker, config)],
              profileFindings,
              access,
            ),
            (r) => ({
              ok: true,
              stages: stageReport({
                ok: true,
                last: "record",
                details: {
                  drift: r.warnings.map((w) => `warning ${w.path}: ${w.detail}`).join("\n"),
                  migrations: r.migrations.join(", "),
                  deploy: [
                    ...r.deployed.map((d) => `${d.worker} ${d.version}`),
                    ...accessLines(r.access),
                  ].join("\n"),
                  probes: r.canary === null ? "" : `floor canary ${r.canary.status}`,
                },
              }),
            }),
          )(request.overlay),
    doctor,
  };
};

/** The service `makeOperability` builds. */
export type OperabilityService<E> = ReturnType<typeof makeOperability<E>>;

/**
 * The command line of `packages/ops/scripts/fd-operability.ts`, which the deploy workflow and the deploy action run:
 * `deploy --overlay <json|@file> [--dry-run]` or `doctor --overlay <json|@file> [--alarm-on-drift]`, as the service call
 * it makes. `@file` names a file holding the overlay.
 */
export const operabilityCommand = <E>(
  service: OperabilityService<E>,
  argv: readonly string[],
  fail: (message: string) => E,
): Effect.Effect<OperabilityReport, E> => {
  const [command, ...rest] = argv;
  const at = rest.indexOf("--overlay");
  const raw = at === -1 ? "" : (rest[at + 1] ?? "");
  const overlay = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  if (command === "deploy") return service.deploy({ overlay, dryRun: rest.includes("--dry-run") });
  if (command === "doctor")
    return service.doctor(overlay, { alarmOnDrift: rest.includes("--alarm-on-drift") });
  return Effect.fail(fail(`unknown command ${command ?? ""}; use deploy or doctor`));
};
