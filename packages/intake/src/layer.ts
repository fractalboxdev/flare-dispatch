// Intake's live Layers on the deployment's D1 and the GitHub services of
// `githubLiveLayer`, and class resolution through the profile's `resolveClass`
// binding (specs/profile.md § Class resolution). The Worker adds the two ports
// another area owns: the Access identity gate (specs/interfaces.md) and the
// execution cancel.
import {
  CLASS_ORDER,
  GATING_RUNS,
  resolveClassDetailed,
  type ClassName,
  type ClassRequest as ProfileRequest,
  type PolicyRule,
  type Resolved,
  type Trigger,
} from "@fractalboxdev/flare-dispatch-profile";
import { resolveRequestClass } from "@fractalboxdev/mameko-coordinator";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { AlarmPort } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import {
  ClassResolver,
  d1Admission,
  type AdmissionPorts,
  IntakeConfig,
  type ClassRequest,
  type IntakeSettings,
} from "./config.ts";
import { manifestSourceLayer } from "./manifest.ts";
import {
  heldCheckReporterLayer,
  installationEvictionLayer,
  manifestReporterLayer,
} from "./ports.ts";
import { isUnavailable, ProtectionSnapshots, protectionSnapshotsLayer } from "./protection.ts";
import { d1IntakeStore, d1ShedRecorder } from "./store.ts";

export interface IntakeLayerOptions {
  readonly db: D1Like;
  readonly settings: IntakeSettings;
  /** Runs after each queued admission, for the Worker to wake standing claims. */
  readonly queued?: (className: string) => Effect.Effect<void>;
  /** Starts an admitted execution's `Execution` workflow (MAMEKO-ADM-029). */
  readonly startExecution?: AdmissionPorts["startExecution"];
  /** Cancels a superseded or group-cancelled member's workflow and lease (MAMEKO-ADM-062, MAMEKO-ADM-066). */
  readonly cancelExecution?: AdmissionPorts["cancelExecution"];
  readonly alarms?: AdmissionPorts["alarms"];
}

/** Every intake service except `ClassResolver` and `AccessIdentity`; needs the GitHub services. */
export const intakeLayer = (options: IntakeLayerOptions) =>
  Layer.mergeAll(
    Layer.succeed(IntakeConfig, options.settings),
    d1Admission(options.db, options.settings.profile, {
      ...(options.queued === undefined ? {} : { queued: options.queued }),
      ...(options.startExecution === undefined ? {} : { startExecution: options.startExecution }),
      ...(options.cancelExecution === undefined
        ? {}
        : { cancelExecution: options.cancelExecution }),
      ...(options.alarms === undefined ? {} : { alarms: options.alarms }),
    }),
    d1IntakeStore(options.db),
    d1ShedRecorder(options.db),
    manifestSourceLayer,
    manifestReporterLayer,
    heldCheckReporterLayer,
    installationEvictionLayer,
    protectionSnapshotsLayer,
  );

/** The labels `resolveClass` may return (FD-PROF-018, FD-PROF-024). */
const BINDING_LABELS: readonly string[] = ["untrusted-input", "local-only"];

/**
 * The repository's policy rules, the `policy-rules` input. Neither the profile nor the deployment settings carry any,
 * so every request resolves under an empty rule set.
 */
const POLICY_RULES: readonly PolicyRule[] = [];

const CLASS_NAMES: ReadonlySet<string> = new Set(CLASS_ORDER);
const classOf = (name: string | null | undefined): ClassName | undefined =>
  name !== null && name !== undefined && CLASS_NAMES.has(name) ? (name as ClassName) : undefined;

const branchOf = (ref: string) =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;

/**
 * The binding's trigger. A push or tag push counts as protected only on a protection read that said so; a ref intake
 * did not read, or could not, is no release trigger (FD-PROF-012).
 */
export const triggerOf = (r: ClassRequest, callerProtected: boolean): Trigger => {
  const onDefault = r.defaultBranch !== null && r.ref === `refs/heads/${r.defaultBranch}`;
  switch (r.trigger) {
    case "fork-pr":
      return { kind: "fork-pr" };
    case "cron":
      return { kind: "cron" };
    case "local":
      return { kind: "local-submit" };
    case "mcp":
      return { kind: "mcp" };
    case "dispatch":
      return r.caller?.kind === "actions-oidc"
        ? {
            kind: "actions-dispatch",
            oidcRef: r.caller.ref ?? r.ref,
            protectedBranch: callerProtected,
          }
        : { kind: "local-submit" };
    case "webhook":
      switch (r.event) {
        case "pull_request":
          return { kind: "pull_request" };
        case "merge_group":
          return { kind: "merge_group" };
        case "check_suite":
        case "deployment_status":
          return { kind: r.event, defaultBranch: onDefault };
        case "push":
          return r.ref.startsWith("refs/tags/")
            ? { kind: "tag-push", protectedTag: r.refProtection === true }
            : {
                kind: "push",
                branch: branchOf(r.ref),
                protectedBranch: r.refProtection === true,
                defaultBranch: onDefault,
              };
        default:
          return { kind: "cron" };
      }
  }
};

/** The profile's request for intake's, with the run's class bounds from its definition. */
export const profileRequestOf = (r: ClassRequest, callerProtected: boolean): ProfileRequest => {
  const qosClass = classOf(r.run.defaultClass);
  const qosCeiling = classOf(r.run.qosCeiling);
  const classInput = classOf(r.classInput);
  const caller = r.caller;
  return {
    run: r.run.name,
    repository: r.repo,
    sha: r.sha,
    trigger: triggerOf(r, callerProtected),
    checkName: r.checkName,
    ...(qosClass === undefined ? {} : { qosClass }),
    ...(qosCeiling === undefined ? {} : { qosCeiling }),
    ...(classInput === undefined ? {} : { classInput }),
    ...(r.run.hostedModelCalls === true ? { hostedModelCalls: true } : {}),
    ...(caller?.kind === "actions-oidc" && caller.workflowRef !== undefined
      ? {
          caller: {
            identity: caller.id,
            repository: r.repo,
            workflowRef: caller.workflowRef,
            protectedBranch: callerProtected,
          },
        }
      : {}),
  };
};

/**
 * Class resolution through the profile's `resolveClass` binding, once per request through mameko's
 * `resolveRequestClass` (MAMEKO-ADM-005). A gating run on a pull-request trigger reads its target branch's required
 * set, the `protection-snapshot` input, through the 10 min cache; an unreadable set arrives as `Unavailable` with the
 * reason FD-PROF-015 and FD-PROF-016 act on. The alarm the binding returns is raised with the run and repository
 * (MAMEKO-ADM-093), and a clamped class input is logged (FD-PROF-020).
 */
export const profileClassResolver = Layer.effect(
  ClassResolver,
  Effect.gen(function* () {
    const { profile } = yield* IntakeConfig;
    const protection = yield* ProtectionSnapshots;
    const alarms = yield* AlarmPort;
    const catalogue = profile.classes.map((c) => ({ name: c.name, rank: c.rank }));

    const raise = (alarm: string, r: ClassRequest) =>
      alarms
        .deliver({
          name: alarm,
          severity: "notify",
          dedupeKey: `${alarm}:${r.repo}:${r.run.name}`,
          state: "raised",
          detail: { run: r.run.name, scopeId: r.repo, checkName: r.checkName },
        })
        .pipe(
          Effect.catchTag("AlarmDeliveryFailed", (e) =>
            Effect.logWarning("alarm not delivered", { alarm, reason: e.reason }),
          ),
        );

    return {
      resolve: (r) =>
        Effect.gen(function* () {
          const snapshot =
            GATING_RUNS.includes(r.run.name) && r.targetBranch !== null
              ? yield* protection.requiredSet(r.repo, r.targetBranch)
              : undefined;
          // Step 6 lets a caller raise only on a protected branch and only as a rule allows, so the caller's branch is
          // read only when a rule could allow it; an unreadable branch allows no raise.
          const callerRef = r.caller?.ref ?? r.ref;
          const callerRead =
            r.classInput !== null && POLICY_RULES.length > 0 && r.caller?.kind === "actions-oidc"
              ? yield* protection.refProtected(r.repo, callerRef)
              : false;
          const callerProtected = !isUnavailable(callerRead) && callerRead;

          let detailed: Resolved | undefined;
          const resolution = resolveRequestClass({
            binding: (request: ProfileRequest, inputs) => {
              detailed = resolveClassDetailed(request, inputs);
              return { class: detailed.class, labels: detailed.labels, alarm: detailed.alarm };
            },
            request: profileRequestOf(r, callerProtected),
            inputs: {
              ...(snapshot === undefined ? {} : { "protection-snapshot": snapshot }),
              "policy-rules": POLICY_RULES,
            },
            catalogue,
            allowedLabels: BINDING_LABELS,
            parentClass: null,
          });
          if (detailed?.clamped !== undefined)
            yield* Effect.logInfo("class input clamped", {
              run: r.run.name,
              repo: r.repo,
              requested: detailed.clamped.requested,
              assigned: detailed.clamped.assigned,
              caller: r.caller?.id ?? null,
            });
          if (resolution._tag === "Class" && resolution.alarm !== null)
            yield* raise(resolution.alarm, r);
          return resolution;
        }),
    };
  }),
);
