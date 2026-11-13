// The delivery keys `GET /v1/ops/delivery-keys` answers: the id of every installation of the GitHub App, read under the
// App JWT across every page of `GET /app/installations` (FD-IFC-094). The GitHub package's listing fails on any
// non-2xx page and on a listing it stops before the last page, so the route answers a complete list or `unavailable`
// with none (FD-IFC-099).
import { GithubApp, listAppInstallations } from "@fractalboxdev/flare-dispatch-github";
import { Effect, Layer } from "effect";
import { apiError } from "../errors.ts";
import { DeliveryKeys } from "../ports.ts";

/** The delivery keys over the isolate's GitHub App. */
export const appDeliveryKeys = Layer.effect(DeliveryKeys)(
  Effect.gen(function* () {
    const app = yield* GithubApp;
    return {
      list: listAppInstallations(app).pipe(
        Effect.map((installations) => installations.map((i) => i.installationId)),
        Effect.mapError((e) =>
          apiError("unavailable", `the GitHub App's installations are unreadable: ${e.message}`),
        ),
      ),
    };
  }),
);

/**
 * A deploy with no App key reads no installation, and answers `unavailable` rather than an empty list, which a
 * containment caller would read as "no key to pause".
 */
export const deliveryKeysWithoutApp = Layer.succeed(DeliveryKeys)({
  list: Effect.fail(
    apiError("unavailable", "this deploy has no GitHub App key, so it reads no installations"),
  ),
});
