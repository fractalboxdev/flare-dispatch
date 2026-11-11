// The effects intake causes outside admission: the manifest's failure check run,
// a held request's queued check run, installation eviction and the cancel of a
// destroyed merge group's executions.
import { GithubApp, GithubClient, GithubRead } from "@fractalboxdev/flare-dispatch-github";
import { checkOpenPayload, type Profile } from "@fractalboxdev/flare-dispatch-profile";
import { admittedIntentRows } from "@fractalboxdev/mameko-coordinator";
import { insertOutboxRows, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Clock, Context, Effect, Layer } from "effect";
import type { IntakeAdmitInput } from "./config.ts";
import { MANIFEST_ERRORS_LISTED } from "./manifest.ts";
import { d1IntakeStore, IntakeStore, StoreUnavailable } from "./store.ts";

export const MANIFEST_CHECK = "flare-dispatch/manifest";

/** Posts the one `failure` check run that lists an invalid manifest's first 20 decode errors (FD-INT-018). */
export class ManifestReporter extends Context.Service<
  ManifestReporter,
  {
    readonly invalid: (repo: string, sha: string, errors: readonly string[]) => Effect.Effect<void>;
  }
>()("@fractalboxdev/flare-dispatch-intake/ManifestReporter") {}

export const manifestSummary = (errors: readonly string[]) => {
  const listed = errors.slice(0, MANIFEST_ERRORS_LISTED);
  const more = errors.length - listed.length;
  return [
    "`.github/flare-dispatch.json` does not decode, so no run of this manifest was submitted.",
    "",
    ...listed.map((e) => `- ${e}`),
    ...(more > 0 ? ["", `and ${more} more`] : []),
  ].join("\n");
};

/**
 * The check run belongs to no execution, so no applier writes it; a GitHub failure is logged, because the shed row
 * already records the refusal.
 */
export const manifestReporterLayer = Layer.effect(
  ManifestReporter,
  Effect.gen(function* () {
    const client = yield* GithubClient;
    const read = yield* GithubRead;
    return {
      invalid: (repo, sha, errors) =>
        Effect.gen(function* () {
          const installation = yield* read.installation(repo);
          yield* client.createCheckRun({
            installation,
            repo,
            body: {
              name: MANIFEST_CHECK,
              head_sha: sha,
              status: "completed",
              conclusion: "failure",
              output: { title: "manifest: invalid", summary: manifestSummary(errors) },
            },
          });
        }).pipe(Effect.catch((e) => Effect.logWarning("manifest check run not posted", e))),
    };
  }),
);

/** The check run a held request's execution owns: its name and head SHA under the execution id (FD-INT-057). */
export interface HeldCheck {
  readonly repo: string;
  readonly executionId: string;
  readonly name: string;
  readonly headSha: string;
}

/**
 * The check run of a held request, as admission's `check.open` row would open it once the request is admitted: none
 * for a run that owns no check or a request that carries `local-only` (FD-GH-005, FD-INT-061).
 */
export const heldCheckOf = (admit: IntakeAdmitInput): HeldCheck | null => {
  const open = checkOpenPayload({ check: admit.check ?? null, labels: admit.labels });
  return open === null
    ? null
    : {
        repo: admit.scopeId,
        executionId: admit.executionId,
        name: open.name,
        headSha: open.head_sha,
      };
};

/**
 * The check run of a request held for its run's cooldown window (FD-INT-057). `queued` posts it `queued` with
 * `external_id` the execution id the request is admitted under, so the `check.open` applier adopts it at release
 * rather than creating a second one (FD-GH-010). `dropped` concludes it `cancelled` when release answers the request
 * with another execution, whose own check run reports it.
 */
export class HeldCheckReporter extends Context.Service<
  HeldCheckReporter,
  {
    readonly queued: (check: HeldCheck) => Effect.Effect<void, StoreUnavailable>;
    readonly dropped: (
      check: HeldCheck,
      answeredBy: string,
    ) => Effect.Effect<void, StoreUnavailable>;
  }
>()("@fractalboxdev/flare-dispatch-intake/HeldCheckReporter") {}

/**
 * Held requests use the same durable check rows as admitted ones. In particular, `check.open` uses admission's
 * `cp:check:open` key, so the release cannot race a second writer for the queued surface (FD-GH-001, FD-GH-010).
 * Only the drainer calls GitHub, under its installation permit. A store failure leaves the authoritative held record
 * intact: a redelivery retries the open, and a release retries a conclusion before dropping the held request.
 */
export const heldCheckReporterLayer = (db: D1Like, profile: Profile) =>
  Layer.effect(
    HeldCheckReporter,
    Effect.gen(function* () {
      const read = yield* GithubRead;
      const stage = (
        check: HeldCheck,
        kind: "check.open" | "check.conclude",
        answeredBy?: string,
      ) =>
        Effect.gen(function* () {
          const record = yield* (yield* IntakeStore).get(check.executionId);
          if (record === null)
            return yield* new StoreUnavailable({
              message: `held check: no intake record ${check.executionId}`,
            });
          const declaration = profile.intent_kinds[kind];
          const classRank = profile.classes.find((c) => c.name === record.className)?.rank;
          if (declaration === undefined || classRank === undefined)
            return yield* new StoreUnavailable({
              message: `held check: no profile kind or class for ${kind}`,
            });
          const installation = yield* read
            .installation(check.repo)
            .pipe(
              Effect.mapError(
                (e) => new StoreUnavailable({ message: `held check installation: ${e.message}` }),
              ),
            );
          const now = yield* Clock.currentTimeMillis;
          const payload =
            kind === "check.open"
              ? { name: check.name, head_sha: check.headSha }
              : {
                  name: check.name,
                  head_sha: check.headSha,
                  verdict: {
                    _tag: "cancelled",
                    cause: `not admitted: answered by execution ${answeredBy}`,
                  },
                  attempt: record.attempt,
                  details: {
                    class: record.className,
                    executor_kind: null,
                    placement_reason: "held for cooldown; not admitted",
                    queue_age_ms: Math.max(0, now - record.createdAt),
                    reserved_micro_usd: 0,
                    settled_micro_usd: 0,
                  },
                };
          // The pure admission builder supplies the profile's delivery metadata, canonical digest and canonical cp key.
          const generated = yield* Effect.promise(() =>
            admittedIntentRows({
              intents: {
                kinds: { [kind]: { ...declaration, on: "admitted" } },
                payload: () => payload,
                limitKey: () => String(installation),
              },
              executionId: check.executionId,
              scopeId: check.repo,
              run: record.run,
              className: record.className,
              classRank,
              now,
            }),
          );
          yield* Effect.tryPromise({
            try: () => insertOutboxRows(db, generated.rows),
            catch: (cause) =>
              new StoreUnavailable({ message: `held check outbox: ${String(cause)}` }),
          });
        }).pipe(Effect.provide(d1IntakeStore(db)));
      return {
        queued: (check) => stage(check, "check.open"),
        dropped: (check, answeredBy) => stage(check, "check.conclude", answeredBy),
      };
    }),
  );

/** Drops cached installation state before intake answers the webhook that changed it (FD-GH-066). */
export class InstallationEviction extends Context.Service<
  InstallationEviction,
  {
    readonly installation: (id: number) => Effect.Effect<void>;
    readonly repositories: (repos: readonly string[]) => Effect.Effect<void>;
  }
>()("@fractalboxdev/flare-dispatch-intake/InstallationEviction") {}

export const installationEvictionLayer = Layer.effect(
  InstallationEviction,
  Effect.gen(function* () {
    const app = yield* GithubApp;
    return { installation: app.evictInstallation, repositories: app.evictRepositories };
  }),
);
