// A Worker that mounts the router the way the control plane does, on workerd through Miniflare: the declared groups
// with the D1 Layers, the connect route before the router, and the request's services built from its bindings. Only
// the JWKS (from `TEST_JWKS`), the installation lookup and the executor channels are test doubles.
import { buildProfile, type Deployment } from "@fractalboxdev/flare-dispatch-profile";
import { runD1Migrations, type D1Like } from "@fractalboxdev/mameko-host-cloudflare";
import { Context, Effect, Layer } from "effect";
import { ApiConfig, apiConfigFromEnv, ConfigInvalid, type ApiEnv } from "../config.ts";
import { errorBody, apiError } from "../errors.ts";
import { declaredGroups } from "../groups.ts";
import { JwksSource, type Jwk } from "../jwt.ts";
import { d1Executions } from "../live/executions.ts";
import { d1Intake } from "../live/intake.ts";
import { oidcKeyFromSecret } from "../live/oidc-key.ts";
import { d1DeviceRegistry } from "../live/registry.ts";
import { runApiMigrations } from "../live/tables.ts";
import { Cancellation, FailureSummaries, Operations } from "../ports.ts";
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

const noChannels = { idFromName: () => null, get: () => ({ wake: async () => {} }) };

/** The ports this fixture does not back answer `unavailable`, as a deploy without them would. */
const unbacked = apiError("unavailable", "not backed in this fixture");

let migrated: Promise<unknown> | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    jwks = JSON.parse(env.TEST_JWKS) as Record<string, readonly Jwk[]>;
    migrated ??= runD1Migrations(env.DB).then(() => runApiMigrations(env.DB));
    await migrated;
    const config = apiConfigFromEnv(env, new URL(request.url).origin);
    if (config instanceof ConfigInvalid)
      return Response.json(errorBody(apiError("misconfigured", config.message), "fixture"), {
        status: 503,
      });
    const profile = buildProfile(env.DEPLOYMENT);
    const layers = Layer.mergeAll(
      d1Executions(env.DB),
      d1Intake({
        db: env.DB,
        channels: noChannels,
        deployment: env.DEPLOYMENT,
        profile,
        installations: () => Effect.succeed("installation-1"),
        resolveClass: ({ run, requested }) => Effect.succeed(requested ?? run.spec.limits.qosClass),
      }),
      d1DeviceRegistry({
        db: env.DB,
        anchor: env.EPOCH_ANCHOR.get(env.EPOCH_ANCHOR.idFromName("control-plane")),
        profile,
        posture: () => Effect.succeed("unmanaged"),
        verify: undefined,
      }),
      oidcKeyFromSecret(env.OIDC_SIGNING_JWK),
      Layer.succeed(Cancellation)({ cancel: () => Effect.fail(unbacked) }),
      Layer.succeed(FailureSummaries)({ pack: () => Effect.fail(unbacked) }),
      Layer.succeed(Operations)({
        apply: () => Effect.fail(unbacked),
        health: Effect.fail(unbacked),
      }),
    );
    const services = await Effect.runPromise(Layer.build(layers).pipe(Effect.scoped));
    return handler.fetch(request, Context.add(services, ApiConfig, config) as never);
  },
};
