// A Worker that mounts the router the way the control plane does, on workerd through Miniflare: the declared groups
// with the D1 Layers, the connect route before the router, and the request's services built from its bindings. A
// dispatch goes through intake's `submit` and mameko's admission (FD-INT-001). Only the JWKS (from `TEST_JWKS`) and the
// class resolution, which answers the requested class or the run's own, are test doubles.
import {
  catalogRuns,
  ClassResolver,
  d1Admission,
  d1IntakeStore,
  d1ShedRecorder,
  HeldCheckReporter,
  IntakeConfig,
  migrateIntake,
  submission,
  submit,
  type IntakeError,
} from "@fractalboxdev/flare-dispatch-intake";
import { buildProfile, type Deployment, type Profile } from "@fractalboxdev/flare-dispatch-profile";
import { runD1Migrations, type D1Like } from "@fractalboxdev/mameko-host-cloudflare";
import { Context, Effect, Layer, Schema } from "effect";
import { ApiConfig, apiConfigFromEnv, ConfigInvalid, type ApiEnv } from "../config.ts";
import { errorBody, apiError, type ErrorCode } from "../errors.ts";
import { declaredGroups } from "../groups.ts";
import { JwksSource, type Jwk } from "../jwt.ts";
import { d1Executions } from "../live/executions.ts";
import { oidcKeyFromSecret } from "../live/oidc-key.ts";
import { d1DeviceRegistry } from "../live/registry.ts";
import { runApiMigrations } from "../live/tables.ts";
import { Cancellation, DeliveryKeys, FailureSummaries, Intake, Operations } from "../ports.ts";
import { mount, toFetchHandler } from "../router.ts";

export { EpochAnchor } from "@fractalboxdev/mameko-host-cloudflare";

interface Env extends ApiEnv {
  readonly DB: D1Like;
  readonly EPOCH_ANCHOR: { idFromName(name: string): unknown; get(id: unknown): never };
  readonly DEPLOYMENT: Deployment;
  readonly TEST_JWKS: string;
}

const router = mount(...declaredGroups);

let jwks: Readonly<Record<string, readonly Jwk[]>> = {};
const handler = toFetchHandler(router, {
  shared: Layer.succeed(JwksSource)({ keys: (url) => Effect.succeed(jwks[url] ?? []) }),
});

/** The API's `Intake` port over intake's `submit`, with mameko's admission on the fixture's D1. */
const intakeOverAdmission = (db: D1Like, deployment: Deployment, profile: Profile) => {
  const catalog = catalogRuns(deployment);
  const layers = Layer.mergeAll(
    Layer.succeed(IntakeConfig, {
      catalog,
      profile,
      appId: 0,
      webhookSecret: undefined,
      webhookEvents: undefined,
      allows: () => true,
      confidentiality: () => "unclassified",
      writeCredentialIn: () => null,
    }),
    Layer.succeed(ClassResolver, {
      resolve: (r) =>
        Effect.succeed({
          _tag: "Class",
          class: r.classInput ?? r.run.defaultClass,
          labels: [],
          alarm: null,
        } as const),
    }),
    d1Admission(db, profile),
    d1IntakeStore(db),
    d1ShedRecorder(db),
    // No run this fixture admits declares a cooldown, so no request is held.
    Layer.succeed(HeldCheckReporter, { queued: () => Effect.void, dropped: () => Effect.void }),
  );
  const refused = (e: IntakeError) =>
    apiError(
      e.code as ErrorCode,
      e.message,
      e.executionId === undefined ? {} : { execution_id: e.executionId },
    );
  return Layer.succeed(Intake)({
    submit: (s) =>
      Effect.gen(function* () {
        const run = catalog(s.run);
        if (run === undefined) return yield* apiError("run_not_found", `no run named ${s.run}`);
        const inputs = yield* Schema.decodeUnknownEffect(run.input)(s.inputs).pipe(
          Effect.mapError((e) => apiError("invalid_inputs", e.message)),
        );
        const sha = s.sha ?? (inputs as { readonly sha?: string }).sha ?? "";
        const admitted = yield* submit(
          submission({
            run,
            trigger: s.trigger,
            repo: s.repository,
            sha,
            ref: s.ref ?? "",
            inputs,
            caller: {
              kind: s.caller.startsWith("actions:") ? "actions-oidc" : "access",
              id: s.caller,
            },
            classInput: s.class ?? null,
            idempotency:
              s.idempotency === undefined
                ? null
                : { key: s.idempotency.key, body: JSON.parse(s.idempotency.canonicalBody) },
          }),
        ).pipe(
          Effect.provide(layers),
          Effect.catchTags({
            IntakeError: (e) => Effect.fail(refused(e)),
            StoreUnavailable: () =>
              Effect.fail(apiError("intake_unavailable", "the intake store did not answer")),
          }),
        );
        return {
          _tag: admitted.duplicate ? ("Duplicate" as const) : ("Admitted" as const),
          executionId: admitted.executionId,
          class: admitted.className,
        };
      }),
  });
};

/** The ports this fixture does not back answer `unavailable`, as a deploy without them would. */
const unbacked = apiError("unavailable", "not backed in this fixture");

let migrated: Promise<unknown> | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    jwks = JSON.parse(env.TEST_JWKS) as Record<string, readonly Jwk[]>;
    migrated ??= runD1Migrations(env.DB)
      .then(() => runApiMigrations(env.DB))
      .then(() => Effect.runPromise(migrateIntake(env.DB)));
    await migrated;
    const config = apiConfigFromEnv(env, new URL(request.url).origin);
    if (config instanceof ConfigInvalid)
      return Response.json(errorBody(apiError("misconfigured", config.message), "fixture"), {
        status: 503,
      });
    const profile = buildProfile(env.DEPLOYMENT);
    const layers = Layer.mergeAll(
      d1Executions(env.DB),
      intakeOverAdmission(env.DB, env.DEPLOYMENT, profile),
      d1DeviceRegistry({
        db: env.DB,
        anchor: env.EPOCH_ANCHOR.get(env.EPOCH_ANCHOR.idFromName("control-plane")),
        profile,
        posture: () => Effect.succeed("unmanaged"),
        verify: undefined,
      }),
      oidcKeyFromSecret(env.OIDC_SIGNING_JWK),
      Layer.succeed(Cancellation)({ cancel: () => Effect.fail(unbacked) }),
      Layer.succeed(FailureSummaries)({
        pack: () => Effect.fail(unbacked),
        confidentiality: () => Effect.succeed("unclassified"),
      }),
      Layer.succeed(Operations)({
        apply: () => Effect.fail(unbacked),
        health: Effect.fail(unbacked),
        controlState: Effect.fail(unbacked),
      }),
      Layer.succeed(DeliveryKeys)({ list: Effect.fail(unbacked) }),
    );
    const services = await Effect.runPromise(Layer.build(layers).pipe(Effect.scoped));
    return handler.fetch(request, Context.add(services, ApiConfig, config) as never);
  },
};
