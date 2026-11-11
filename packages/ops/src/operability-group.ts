// The handlers of the declaration's operability group: the fleet view, the phase gate's records, the spend view and
// the GitHub App install flow. The router's gate has already identified the caller (an operator, or for the spend view
// any Access identity), checked the method and assigned the request id; each handler answers an error from the error
// model (FD-IFC-001, FD-IFC-009).
import { FlareDispatchApi } from "@fractalboxdev/flare-dispatch-api/declaration";
import { apiError } from "@fractalboxdev/flare-dispatch-api/errors";
import { CurrentIdentity } from "@fractalboxdev/flare-dispatch-api/identity";
import { RequestId } from "@fractalboxdev/flare-dispatch-api/request-id";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Context, Effect, Match, Option } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import type { AccessIdentity } from "./access.ts";
import { fleet } from "./dashboard.ts";
import { installCallback, ManifestConversion, startInstall } from "./install.ts";
import { runOpsMigrations } from "./liveness.ts";
import { SpendView, utcMonth } from "./spend.ts";
import { phaseGateRecords } from "./verification/records.ts";

/** The operability record the handlers read, and the clock they read it at. */
export class OpsStore extends Context.Service<
  OpsStore,
  { readonly db: D1Like; readonly now: () => number }
>()("@fractalboxdev/flare-dispatch-ops/OpsStore") {}

/** The store with its tables migrated. */
const store = Effect.gen(function* () {
  const s = yield* OpsStore;
  yield* Effect.promise(() => runOpsMigrations(s.db));
  return { db: s.db, now: s.now() };
});

/** The gate's Access identity as the install flow binds a state to it: the session is the token's subject. */
const operatorOf = Effect.gen(function* () {
  const identity = yield* CurrentIdentity;
  return yield* Match.value(identity).pipe(
    Match.tag("Access", ({ id, claims }) =>
      Effect.succeed<AccessIdentity>({
        email: typeof claims["email"] === "string" ? claims["email"] : null,
        commonName: typeof claims["common_name"] === "string" ? claims["common_name"] : null,
        subject: typeof claims["sub"] === "string" ? claims["sub"] : id,
        name: id,
      }),
    ),
    Match.orElse(() =>
      Effect.fail(apiError("forbidden", "the install routes need an Access identity")),
    ),
  );
});

const sourceOf = (request: { readonly source: unknown }) => request.source as Request;

export const OperabilityHandlers = HttpApiBuilder.group(
  FlareDispatchApi,
  "operability",
  (handlers) =>
    handlers
      .handle("fleet", () =>
        Effect.gen(function* () {
          const { db, now } = yield* store;
          return yield* Effect.promise(() => fleet(db, now));
        }),
      )
      .handle("phaseGate", ({ query }) =>
        Effect.gen(function* () {
          const { db, now } = yield* store;
          return yield* phaseGateRecords(db, Number(query.gate), now).pipe(
            Effect.catchTag("RecordsUnreadable", (e) =>
              Effect.fail(
                apiError("unavailable", `the phase-gate records are unreadable: ${e.reason}`),
              ),
            ),
          );
        }),
      )
      .handle("spend", () =>
        Effect.gen(function* () {
          const { now } = yield* store;
          const spend = yield* SpendView;
          return yield* spend
            .view(utcMonth(now))
            .pipe(
              Effect.catchTag("SpendUnreadable", () =>
                Effect.fail(apiError("spend_unreadable", "the spend store cannot be read")),
              ),
            );
        }),
      )
      .handle("installNew", ({ request }) =>
        Effect.gen(function* () {
          const { db, now } = yield* store;
          const operator = yield* operatorOf;
          const origin = new URL(sourceOf(request).url).origin;
          const page = yield* Effect.promise(() => startInstall(db, operator, origin, now));
          return HttpServerResponse.fromWeb(page);
        }),
      )
      .handle("installCallback", ({ request }) =>
        Effect.gen(function* () {
          const conversion = yield* Effect.serviceOption(ManifestConversion);
          if (Option.isNone(conversion))
            return yield* apiError(
              "unavailable",
              "this deploy supplies no GitHub manifest conversion",
            );
          const { db, now } = yield* store;
          const operator = yield* operatorOf;
          const page = yield* installCallback(
            db,
            new URL(sourceOf(request).url),
            operator,
            now,
            yield* RequestId,
          ).pipe(Effect.provideService(ManifestConversion, conversion.value));
          return HttpServerResponse.fromWeb(page);
        }),
      ),
);
