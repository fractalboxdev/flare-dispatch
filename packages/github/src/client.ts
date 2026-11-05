// The GitHub calls the check-run applier makes, as a service. The live client
// speaks the REST API through an injected `fetch` and reports every response's
// rate-limit headers to the installation quota; tests supply an in-memory fake.
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { InstallationQuota, type QuotaObservation } from "./rate-limit.ts";

/** GitHub answered with a non-2xx status. */
export class GithubHttpError extends Schema.TaggedError<GithubHttpError>()("GithubHttpError", {
  status: Schema.Number,
  message: Schema.String,
  /** A `403` or `429` that GitHub sent for a rate limit rather than a permission. */
  rateLimited: Schema.Boolean,
}) {}

/** No answer arrived. `sent` is false only when the request never left, so a repeat cannot double it. */
export class GithubNetworkError extends Schema.TaggedError<GithubNetworkError>()(
  "GithubNetworkError",
  { sent: Schema.Boolean, message: Schema.String },
) {}

export type GithubError = GithubHttpError | GithubNetworkError;

export interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly external_id: string | null;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: string | null;
  readonly output: { readonly title: string | null; readonly summary: string | null };
}

export interface Annotation {
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly annotation_level: "notice" | "warning" | "failure";
  readonly message: string;
  readonly title?: string;
}

/** The fields of a check-run create or update this applier sends. */
export interface CheckRunBody {
  readonly name?: string;
  readonly head_sha?: string;
  readonly external_id?: string;
  readonly details_url?: string;
  readonly status?: "queued" | "in_progress" | "completed";
  readonly conclusion?: string;
  readonly output?: {
    readonly title: string;
    readonly summary: string;
    readonly annotations?: readonly Annotation[];
  };
}

export interface RepoCall {
  readonly installation: number;
  /** `<owner>/<repo>`. */
  readonly repo: string;
}

export class GithubClient extends Context.Service<
  GithubClient,
  {
    readonly createCheckRun: (
      call: RepoCall & { readonly body: CheckRunBody },
    ) => Effect.Effect<CheckRun, GithubError>;
    readonly updateCheckRun: (
      call: RepoCall & { readonly checkRunId: number; readonly body: CheckRunBody },
    ) => Effect.Effect<CheckRun, GithubError>;
    /** The check runs of one name on one commit. */
    readonly listCheckRuns: (
      call: RepoCall & { readonly ref: string; readonly name: string },
    ) => Effect.Effect<readonly CheckRun[], GithubError>;
    readonly listAnnotations: (
      call: RepoCall & { readonly checkRunId: number },
    ) => Effect.Effect<readonly Annotation[], GithubError>;
    /** Mints a new installation token, for the one retry after a `401` (FD-GH-047). */
    readonly refreshToken: (installation: number) => Effect.Effect<void, GithubError>;
  }
>()("@fractalboxdev/flare-dispatch-github/GithubClient") {}

export interface GithubClientOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly baseUrl?: string;
  /** The installation token; `fresh` asks for a newly minted one. */
  readonly token: (installation: number, fresh: boolean) => Effect.Effect<string, GithubError>;
}

const num = (v: string | null): number | undefined => {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** `Retry-After` as seconds or as an HTTP date, as an epoch-ms instant (FD-GH-060). */
const retryAfterAt = (v: string | null, now: number): number | undefined => {
  if (v === null) return undefined;
  const seconds = num(v);
  if (seconds !== undefined) return now + seconds * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : at;
};

/** The rate-limit headers of one response (FD-GH-057). */
export const observeHeaders = (headers: Headers, now: number): QuotaObservation => {
  const reset = num(headers.get("x-ratelimit-reset"));
  const limit = num(headers.get("x-ratelimit-limit"));
  const remaining = num(headers.get("x-ratelimit-remaining"));
  const retry = retryAfterAt(headers.get("retry-after"), now);
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(reset === undefined ? {} : { resetAt: reset * 1000 }),
    ...(retry === undefined ? {} : { retryAfterAt: retry }),
  };
};

export const githubClientLayer = (options: GithubClientOptions) =>
  Layer.effect(
    GithubClient,
    Effect.gen(function* () {
      const quota = yield* InstallationQuota;
      const base = options.baseUrl ?? "https://api.github.com";

      const request = <A>(installation: number, method: string, path: string, body?: unknown) =>
        Effect.gen(function* () {
          const token = yield* options.token(installation, false);
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              options.fetch(`${base}${path}`, {
                method,
                signal,
                headers: {
                  accept: "application/vnd.github+json",
                  authorization: `Bearer ${token}`,
                  "x-github-api-version": "2022-11-28",
                  ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              }),
            // A rejected fetch may have reached GitHub, so a write counts as sent.
            catch: (e) => new GithubNetworkError({ sent: method !== "GET", message: String(e) }),
          });
          const now = yield* Clock.currentTimeMillis;
          yield* quota.observe(String(installation), observeHeaders(response.headers, now));
          const json: unknown = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: (e) => new GithubNetworkError({ sent: true, message: String(e) }),
          });
          if (response.ok) return json as A;
          const message =
            typeof json === "object" && json !== null && "message" in json
              ? String(json.message)
              : response.statusText;
          const rateLimited =
            response.status === 429 ||
            (response.status === 403 &&
              (response.headers.get("retry-after") !== null ||
                response.headers.get("x-ratelimit-remaining") === "0" ||
                /rate limit/i.test(message)));
          return yield* Effect.fail(
            new GithubHttpError({ status: response.status, message, rateLimited }),
          );
        });

      return {
        createCheckRun: ({ installation, repo, body }) =>
          request<CheckRun>(installation, "POST", `/repos/${repo}/check-runs`, body),
        updateCheckRun: ({ installation, repo, checkRunId, body }) =>
          request<CheckRun>(installation, "PATCH", `/repos/${repo}/check-runs/${checkRunId}`, body),
        listCheckRuns: ({ installation, repo, ref, name }) =>
          request<{ readonly check_runs: readonly CheckRun[] }>(
            installation,
            "GET",
            `/repos/${repo}/commits/${ref}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`,
          ).pipe(Effect.map((r) => r.check_runs)),
        listAnnotations: ({ installation, repo, checkRunId }) =>
          Effect.gen(function* () {
            const all: Annotation[] = [];
            for (let page = 1; ; page++) {
              const batch = yield* request<readonly Annotation[]>(
                installation,
                "GET",
                `/repos/${repo}/check-runs/${checkRunId}/annotations?per_page=100&page=${page}`,
              );
              all.push(...batch);
              if (batch.length < 100) return all;
            }
          }),
        refreshToken: (installation) => Effect.asVoid(options.token(installation, true)),
      };
    }),
  );
