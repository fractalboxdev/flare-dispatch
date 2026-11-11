// The `Operability` service `fd deploy` and `fd doctor` run (specs/interfaces.md FD-IFC-070, specs/operability.md
// FD-OPS-003 to FD-OPS-025): the deploy pipeline and the drift check over the live Cloudflare and GitHub target, as
// the stage report `fd` prints. A stage that fails is a report with `ok: false`; only a defect is the caller's error.
import {
  CURRENT_PHASE,
  profileDocumentFor,
  validationContext,
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
  bindingCheck,
  failed,
  profileCheck,
  templateInvariants,
  unrenderedCheck,
  type Finding,
} from "../drift.ts";
import { decodeOverlay, type OverlayValues } from "../overlay.ts";
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
 * dispatcher declares `ALERT_SINK`, the sink its alarm port sends to, so no deploy goes out without one (FD-OPS-053).
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
 * pool caps (FD-OPS-020, FD-PROF-033) and the components (FD-ARCH-001).
 */
export const renderedChecks =
  (specs: readonly WorkerSpec[]) =>
  (worker: string, config: WorkerConfig): readonly Finding[] => {
    const spec = specs.find((s) => s.worker === worker);
    if (spec === undefined) return [];
    return [
      ...(spec.bindings === undefined ? [] : bindingCheck(worker, config, spec.bindings)),
      ...(spec.dispatcher === true
        ? [
            ...admissionCapCheck(worker, config),
            ...architectureFindings(worker, config, CURRENT_PHASE),
          ]
        : []),
    ];
  };

/**
 * mameko's profile validator over a profile document at the current phase; the deploy carries the production document
 * (FD-OPS-021, FD-PROF-064).
 */
export const profileDriftFindings = (
  document: ProfileDocument = profileDocumentFor("production"),
) => profileCheck(document, validationContext);

/**
 * The pull-request part of the drift check (FD-OPS-019 to FD-OPS-021, FD-OPS-026): one Worker's template rendered
 * from `overlay`, against the template's invariants and `renderedChecks`. Answers the rendered text with the findings.
 */
export const staticDrift = (spec: WorkerSpec, template: string, overlay: OverlayValues) =>
  renderTemplate(spec.worker, template, overlay).pipe(
    Effect.map((rendered) => ({
      rendered,
      findings: [
        ...templateInvariants(spec.worker, parseJsonc(template)),
        ...unrenderedCheck(spec.worker, rendered),
        ...renderedChecks([spec])(spec.worker, parseJsonc(rendered)),
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
  const profileFindings = profileDriftFindings(options.profile);
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

  const doctor = (overlay: string) =>
    report(
      fdDoctor(overlay, workers(), APP_PERMISSIONS, renderedChecks(specs), profileFindings, access),
      (findings) => {
        const problems = findings.map((f) => `${f.severity} ${f.path}: ${f.detail}`).join("\n");
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

  return {
    deploy: (request: { readonly overlay: string; readonly dryRun: boolean }) =>
      request.dryRun
        ? doctor(request.overlay)
        : report(
            fdDeploy(
              request.overlay,
              workers(),
              APP_PERMISSIONS,
              renderedChecks(specs),
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
