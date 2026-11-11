// Repo manifests: `.github/flare-dispatch.json`, decoded by `RepoManifest`, read
// at the commit FD-INT-016 names and cached per (repository, commit SHA) for at
// most 10 min (specs/intake.md § Repo manifests).
import { GithubRead, type GithubReadError } from "@fractalboxdev/flare-dispatch-github";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Result,
  Schema,
} from "effect";
import { parseCron } from "./cron.ts";
import type { RunCatalog } from "./runs.ts";

export const MANIFEST_PATH = ".github/flare-dispatch.json";
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const MANIFEST_MAX_RUNS = 50;
export const MANIFEST_CACHE_MS = 10 * 60_000;
export const MANIFEST_READ_TIMEOUT = Duration.seconds(10);
/** The `flare-dispatch/manifest` check run lists at most this many decode errors (FD-INT-018). */
export const MANIFEST_ERRORS_LISTED = 20;

const Label = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/));

export const Schedule = Schema.Struct({
  cron: Schema.String,
  /** The branch whose head the scheduled run pins; the default branch when absent (FD-INT-052). */
  branch: Schema.optionalKey(Schema.NonEmptyString),
});

export const ManifestEntry = Schema.Struct({
  recipe: Schema.NonEmptyString,
  label: Schema.optionalKey(Label),
  /** Webhook event names, `dispatch`, `cron` and `mcp`. */
  triggers: Schema.Array(Schema.NonEmptyString),
  params: Schema.optionalKey(Schema.Unknown),
  schedules: Schema.optionalKey(Schema.Array(Schedule)),
});
export type ManifestEntry = typeof ManifestEntry.Type;

export const RepoManifest = Schema.Struct({
  version: Schema.Literal(1),
  runs: Schema.Array(ManifestEntry),
  /** The pull-request authors the gate recipes skip; `dependabot[bot]` when absent (FD-GATE-017). */
  skipAuthors: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type RepoManifest = typeof RepoManifest.Type;

export type ManifestRead =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Unreadable"; readonly reason: string }
  | { readonly _tag: "Invalid"; readonly errors: readonly string[] }
  | { readonly _tag: "Valid"; readonly manifest: RepoManifest };

const lines = (message: string) =>
  message
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

/**
 * Decodes the manifest's bytes against `RepoManifest` and every entry's parameters against its recipe's schema
 * (FD-INT-017, FD-INT-018). Any error makes the whole manifest invalid.
 */
export const validateManifest = (text: string, size: number, catalog: RunCatalog): ManifestRead => {
  if (size > MANIFEST_MAX_BYTES)
    return {
      _tag: "Invalid",
      errors: [`manifest is ${size} bytes; the bound is ${MANIFEST_MAX_BYTES}`],
    };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { _tag: "Invalid", errors: [`manifest is not JSON: ${String(e)}`] };
  }
  const decoded = Schema.decodeUnknownResult(RepoManifest)(json);
  if (Result.isFailure(decoded)) return { _tag: "Invalid", errors: lines(decoded.failure.message) };
  const manifest = decoded.success;
  if (manifest.runs.length > MANIFEST_MAX_RUNS)
    return {
      _tag: "Invalid",
      errors: [`manifest lists ${manifest.runs.length} runs; the bound is ${MANIFEST_MAX_RUNS}`],
    };
  const errors: string[] = [];
  manifest.runs.forEach((entry, i) => {
    const run = catalog(entry.recipe);
    if (run === undefined) {
      errors.push(`runs[${i}].recipe: no recipe named ${entry.recipe}`);
      return;
    }
    const params = Schema.decodeUnknownResult(run.params)(entry.params ?? {});
    if (Result.isFailure(params))
      errors.push(...lines(params.failure.message).map((l) => `runs[${i}].params: ${l}`));
    (entry.schedules ?? []).forEach((s, j) => {
      if (parseCron(s.cron) === null)
        errors.push(
          `runs[${i}].schedules[${j}].cron: ${JSON.stringify(s.cron)} is not a 5-field cron`,
        );
    });
  });
  return errors.length > 0 ? { _tag: "Invalid", errors } : { _tag: "Valid", manifest };
};

/** A GitHub read that FD-INT-019 calls unreadable: a `5xx`, a network failure or a timeout. */
const unreadable = (e: GithubReadError): string =>
  Match.value(e).pipe(
    Match.tag("GithubHttpError", ({ status, message }) => `github ${status}: ${message}`),
    Match.tag("GithubNetworkError", ({ message }) => `network: ${message}`),
    Match.tag("GithubUncredentialed", ({ repo }) => `no installation serves ${repo}`),
    Match.tag("GithubUnexpected", ({ message }) => `unexpected: ${message}`),
    Match.exhaustive,
  );

/** Manifests by (repository, commit SHA). The commit fixes the bytes, so every decoded outcome is cacheable. */
export class ManifestSource extends Context.Service<
  ManifestSource,
  { readonly read: (repo: string, sha: string, catalog: RunCatalog) => Effect.Effect<ManifestRead> }
>()("@fractalboxdev/flare-dispatch-intake/ManifestSource") {}

export const manifestSourceLayer = Layer.effect(
  ManifestSource,
  Effect.gen(function* () {
    const github = yield* GithubRead;
    const cache = yield* Ref.make(
      new Map<string, { readonly at: number; readonly read: ManifestRead }>(),
    );
    return {
      read: (repo, sha, catalog) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const key = `${repo.toLowerCase()}@${sha}`;
          const hit = (yield* Ref.get(cache)).get(key);
          if (hit !== undefined && now - hit.at < MANIFEST_CACHE_MS) return hit.read;
          const read = yield* github.file(repo, MANIFEST_PATH, sha).pipe(
            Effect.timeoutOption(MANIFEST_READ_TIMEOUT),
            Effect.map(
              Option.match({
                onNone: (): ManifestRead => ({ _tag: "Unreadable", reason: "timeout after 10 s" }),
                onSome: (file): ManifestRead =>
                  file === null
                    ? { _tag: "Absent" }
                    : validateManifest(file.text, file.size, catalog),
              }),
            ),
            Effect.catch((e) =>
              Effect.succeed<ManifestRead>({ _tag: "Unreadable", reason: unreadable(e) }),
            ),
          );
          if (read._tag !== "Unreadable")
            yield* Ref.update(cache, (m) => {
              const next = new Map([...m].filter(([, v]) => now - v.at < MANIFEST_CACHE_MS));
              return next.set(key, { at: now, read });
            });
          return read;
        }),
    };
  }),
);
