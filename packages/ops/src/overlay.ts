// The operator overlay: a JSON document of values only, decoded against the value schema with every undeclared key
// rejected (specs/operability.md § Template, overlay and rendered configuration, FD-OPS-002 to FD-OPS-004, FD-OPS-056).
import { spendConfigWith, type SpendConfig } from "@fractalboxdev/flare-dispatch-profile";
import { Effect, Schema } from "effect";
import { decodeStrict, type DecodeIssue } from "./decode.ts";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const Usd = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const Ids = Schema.Record(Schema.String, NonEmpty);
const opt = Schema.optional;

/** An HTTPS webhook URL or an email address (FD-OPS-056). */
export const AlertSink = NonEmpty.check(
  Schema.makeFilter((s: string) =>
    /^https:\/\/[^\s/]+/.test(s) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
      ? undefined
      : "an HTTPS URL or an email address",
  ),
);

/** Every value path the overlay may hold; nothing else (FD-OPS-002). */
export const OverlayValues = Schema.Struct({
  accountId: NonEmpty,
  d1: Ids,
  kv: opt(Ids),
  r2: Ids,
  hostnames: Ids,
  access: Schema.Struct({ teamDomain: NonEmpty, aud: NonEmpty }),
  operators: Schema.Array(NonEmpty).check(Schema.isMinLength(1)),
  dispatchers: opt(Schema.Array(NonEmpty)),
  github: Schema.Struct({ appId: NonEmpty, fixtureRepo: NonEmpty }),
  intake: opt(Schema.Struct({ webhookEvents: opt(Schema.Array(NonEmpty)) })),
  dispatch: opt(Schema.Struct({ oidcAudience: NonEmpty })),
  executors: opt(Schema.Struct({ planeId: NonEmpty })),
  alerts: Schema.Struct({ sink: AlertSink, webhookSilentHours: opt(Count) }),
  spend: opt(
    Schema.Struct({
      budgetUsd: opt(Usd),
      fixedUsd: opt(Usd),
      releaseReserveUsd: opt(Usd),
      opsReserveUsd: opt(Usd),
      measuredReserveMinUsd: opt(Usd),
      measuredReserveDays: opt(Count),
      overheadFactor: opt(Schema.Number.check(Schema.isGreaterThanOrEqualTo(1))),
    }),
  ),
  pools: opt(Schema.Record(Schema.String, Schema.Struct({ maxInstances: Count }))),
  aws: opt(
    Schema.Struct({
      budgetUsd: opt(Usd),
      launchCap: opt(Count),
      egressProxy: opt(NonEmpty),
      imageRegistry: opt(NonEmpty),
    }),
  ),
  gha: opt(
    Schema.Struct({
      concurrencyCap: opt(Count),
      runnerRepo: opt(NonEmpty),
      workflow: opt(NonEmpty),
    }),
  ),
  egress: opt(Schema.Struct({ targetPatterns: Schema.Array(NonEmpty) })),
  models: opt(
    Schema.Struct({
      registry: opt(Schema.Record(Schema.String, Schema.Unknown)),
      fallbackPriceUsdPerMTok: opt(Usd),
      bucketShares: opt(Schema.Record(Schema.String, Schema.Number)),
      breaker: opt(Schema.Number),
    }),
  ),
  provenance: opt(
    Schema.Struct({
      attestationMaxAgeDays: opt(Count),
      reattestIntervalDays: opt(Count),
      auditRate: opt(Schema.Number),
      statementRetentionDays: opt(Count),
      witnesses: opt(Schema.Array(NonEmpty)),
    }),
  ),
});
export type OverlayValues = typeof OverlayValues.Type;

/** `fd deploy` refused the overlay before any Cloudflare state changed; each issue names its path. */
export class OverlayRejected extends Schema.TaggedError<OverlayRejected>()("OverlayRejected", {
  issues: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
}) {}

/** Parses and decodes an overlay document (FD-OPS-003, FD-OPS-004, FD-OPS-056). */
export const decodeOverlay = (text: string) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (e) =>
        new OverlayRejected({ issues: [{ path: "", message: `not JSON: ${String(e)}` }] }),
    });
    return yield* decodeStrict(OverlayValues, parsed).pipe(
      Effect.mapError((issues: readonly DecodeIssue[]) => new OverlayRejected({ issues })),
    );
  });

const micro = (usd: number | undefined) => (usd === undefined ? undefined : Math.round(usd * 1e6));

/** The spend configuration the overlay delivers, each unset value at its default (FD-PROF-054, FD-OPS-083). */
export const spendConfigOf = (overlay: OverlayValues): SpendConfig => {
  const s = overlay.spend ?? {};
  const release = micro(s.releaseReserveUsd);
  return spendConfigWith({
    ...(s.budgetUsd === undefined ? {} : { budget: micro(s.budgetUsd)! }),
    ...(s.fixedUsd === undefined ? {} : { fixed: micro(s.fixedUsd)! }),
    ...(s.opsReserveUsd === undefined ? {} : { ops_reserve: micro(s.opsReserveUsd)! }),
    ...(s.measuredReserveMinUsd === undefined
      ? {}
      : { measured_reserve_min: micro(s.measuredReserveMinUsd)! }),
    ...(s.measuredReserveDays === undefined
      ? {}
      : { measured_reserve_days: s.measuredReserveDays }),
    ...(s.overheadFactor === undefined ? {} : { overhead_factor: s.overheadFactor }),
    ...(release === undefined ? {} : { reserves: { "release-reserve": release } }),
  });
};

/** A complete overlay of placeholder values, for CI's dry run and the drift check on every pull request. */
export const placeholderOverlay: OverlayValues = {
  accountId: "00000000000000000000000000000000",
  d1: { DB: "00000000-0000-0000-0000-000000000000" },
  r2: { CACHE: "flare-dispatch-cache", ARTIFACTS: "flare-dispatch-artifacts" },
  hostnames: { dispatcher: "dispatch.example.com", docs: "docs.example.com" },
  access: { teamDomain: "example.cloudflareaccess.com", aud: "placeholder-aud" },
  operators: ["operator@example.com"],
  github: { appId: "0", fixtureRepo: "example/canary" },
  alerts: { sink: "https://alerts.example.com/hook" },
};
