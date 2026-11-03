// Intake's live Layers on the deployment's D1 and the GitHub services of
// `githubLiveLayer`. The Worker adds the three ports another area owns: class
// resolution (`resolveClass`, specs/profile.md), the Access identity gate
// (specs/interfaces.md) and the execution cancel.
import { classNamed } from "@fractalboxdev/flare-dispatch-profile";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Layer } from "effect";
import { ClassResolver, d1Admission, IntakeConfig, type IntakeSettings } from "./config.ts";
import { manifestSourceLayer } from "./manifest.ts";
import { oidcVerifierLayer } from "./oidc.ts";
import { installationEvictionLayer, manifestReporterLayer } from "./ports.ts";
import { d1IntakeStore, d1ShedRecorder } from "./store.ts";

export interface IntakeLayerOptions {
  readonly db: D1Like;
  readonly settings: IntakeSettings;
  /** The `fetch` the OIDC verifier reads the issuer's keys with. */
  readonly fetch: typeof globalThis.fetch;
  /** Runs after each queued admission, for the Worker to wake standing claims. */
  readonly queued?: (className: string) => Effect.Effect<void>;
}

/** Every intake service except `ClassResolver`, `AccessIdentity` and `ExecutionCanceller`; needs the GitHub services. */
export const intakeLayer = (options: IntakeLayerOptions) =>
  Layer.mergeAll(
    Layer.succeed(IntakeConfig, options.settings),
    d1Admission(options.db, options.queued),
    d1IntakeStore(options.db),
    d1ShedRecorder(options.db),
    manifestSourceLayer,
    manifestReporterLayer,
    installationEvictionLayer,
    oidcVerifierLayer(options.fetch),
  );

/**
 * The class resolution intake applies until the profile's `resolveClass` binding is wired: the run's default class,
 * a `class` input applied only when it ranks lower, and the label `untrusted-input` for a `fork-pr` trigger
 * (FD-PROF-024). It reads no protection snapshot, so it never raises a gating run to `required`.
 */
export const runDefaultClassResolver = Layer.effect(
  ClassResolver,
  Effect.gen(function* () {
    const { profile } = yield* IntakeConfig;
    const rank = (name: string) => classNamed(profile, name)?.rank;
    return {
      resolve: (r) =>
        Effect.succeed({
          _tag: "Class" as const,
          class:
            r.classInput !== null &&
            (rank(r.classInput) ?? -1) > (rank(r.run.defaultClass) ?? Infinity)
              ? r.classInput
              : r.run.defaultClass,
          labels: r.trigger === "fork-pr" ? ["untrusted-input"] : [],
          alarm: null,
        }),
    };
  }),
);
